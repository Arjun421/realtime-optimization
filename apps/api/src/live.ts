import {
  zoneOf,
  type LatencySummary,
  type LiveRequest,
  type LiveSnapshot,
  type LiveZone,
  type Priority,
  type RequestState,
} from '@dispatch/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { decodeGeoScore } from './geohash.js';
import { fleetStats } from './location.js';
import { LatencySamples } from './metrics.js';
import { hmgetMany, keys, redis } from './redis.js';

const WAITING = new Set<RequestState>(['CREATED', 'SEARCHING', 'OFFERED']);
/** Counted but not drawn: once picked up, the pickup point no longer means anything on the map. */
const COUNT_ONLY = new Set<RequestState>(['PICKED_UP']);
/** A dashboard with this much unsent data skips frames instead of piling up memory. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Indexes into AGENT_LIVE_STATUSES. */
const STATUS_CODE: Record<string, number> = { AVAILABLE: 0, OFFERED: 1, BUSY: 2 };
const STALE_CODE = 3;

/** ~1 m precision is plenty for a map and keeps the JSON small. */
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

type Fleet = LiveSnapshot['metrics']['fleet'];
interface DispatchMetrics {
  dispatchDecisionMs: LatencySummary;
  timeToFirstOfferMs: LatencySummary;
  counters: Record<string, number>;
}

const snapshotBuildMs = new LatencySamples(1_000);
let lastDispatchMetrics: DispatchMetrics = { dispatchDecisionMs: { count: 0 }, timeToFirstOfferMs: { count: 0 }, counters: {} };

/** Latency and counters live in the API's memory, so ask it. Falls back to the last answer. */
async function fetchDispatchMetrics(): Promise<DispatchMetrics> {
  try {
    const res = await fetch(`${config.apiUrl}/metrics/dispatch`, { signal: AbortSignal.timeout(500) });
    if (res.ok) lastDispatchMetrics = (await res.json()) as DispatchMetrics;
  } catch {
    // API restarting; keep showing the last numbers.
  }
  return lastDispatchMetrics;
}

function zoneEntry(zones: Map<number, LiveZone>, zone: number): LiveZone {
  let entry = zones.get(zone);
  if (!entry) zones.set(zone, (entry = { zone, supply: 0, demand: 0 }));
  return entry;
}

/** Every tracked agent with last known position, status and freshness. */
async function readAgents(
  now: number,
  zones: Map<number, LiveZone>,
): Promise<{ agents: LiveSnapshot['agents']; fleet: Fleet }> {
  // Raw GEO scores, decoded here rather than by Redis (see geohash.ts).
  const raw = await redis.zrange(keys.pos, 0, -1, 'WITHSCORES');
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i += 2) ids.push(raw[i]!);

  const agents: LiveSnapshot['agents'] = { ids: [], lng: [], lat: [], status: [] };
  if (ids.length === 0) return { agents, fleet: fleetStats([]) };

  const [statuses, lastSeen] = await Promise.all([
    hmgetMany(ids.map(keys.agent), ['status']),
    redis.zmscore(keys.lastSeen, ...ids),
  ]);

  const ages: number[] = [];
  const freshAfter = now - config.staleAfterMs;
  ids.forEach((id, i) => {
    const seen = lastSeen[i] == null ? null : Number(lastSeen[i]);
    if (seen !== null) ages.push(now - seen);
    const stale = seen === null || seen < freshAfter;
    const status = stale ? STALE_CODE : STATUS_CODE[statuses[i]?.[0] ?? ''] ?? 0;
    const pos = decodeGeoScore(Number(raw[i * 2 + 1]));

    agents.ids.push(id);
    agents.lng.push(round5(pos.lng));
    agents.lat.push(round5(pos.lat));
    agents.status.push(status);

    if (status === STATUS_CODE.AVAILABLE) {
      const zone = zoneOf(pos);
      if (zone >= 0) zoneEntry(zones, zone).supply++;
    }
  });
  return { agents, fleet: fleetStats(ages) };
}

/** Open requests plus ones that finished in the last few seconds. */
async function readRequests(
  zones: Map<number, LiveZone>,
): Promise<Pick<LiveSnapshot, 'requests' | 'requestCounts'>> {
  const requests: LiveRequest[] = [];
  const requestCounts: LiveSnapshot['requestCounts'] = {};
  const [open, ended] = await Promise.all([
    redis.zrange(keys.openRequests, 0, -1),
    redis.zrange(keys.endedRequests, 0, -1),
  ]);
  const ids = [...open, ...ended];
  if (ids.length === 0) return { requests, requestCounts };

  const rows = await hmgetMany(ids.map(keys.req), ['state', 'lat', 'lng', 'priority', 'agentId', 'attempts', 'createdAt']);

  ids.forEach((id, i) => {
    const [state, lat, lng, priority, agentId, attempts, createdAt] = rows[i] ?? [];
    if (!state) return; // expired
    const s = state as RequestState;
    requestCounts[s] = (requestCounts[s] ?? 0) + 1;
    if (COUNT_ONLY.has(s)) return;

    const req: LiveRequest = {
      id,
      lat: round5(Number(lat)),
      lng: round5(Number(lng)),
      state: s,
      priority: (priority ?? 'normal') as Priority,
      agentId: agentId ?? undefined,
      attempts: Number(attempts ?? 0),
      createdAt: Number(createdAt),
    };
    requests.push(req);

    if (WAITING.has(s)) {
      const zone = zoneOf(req);
      if (zone >= 0) zoneEntry(zones, zone).demand++;
    }
  });
  return { requests, requestCounts };
}

export async function buildSnapshot(): Promise<LiveSnapshot> {
  const started = performance.now();
  const now = Date.now();
  const zones = new Map<number, LiveZone>();
  const [{ agents, fleet }, { requests, requestCounts }, dispatch] = await Promise.all([
    readAgents(now, zones),
    readRequests(zones),
    fetchDispatchMetrics(),
  ]);
  const buildMs = performance.now() - started;
  snapshotBuildMs.add(buildMs);

  return {
    type: 'snapshot',
    at: now,
    buildMs: Math.round(buildMs * 100) / 100,
    agents,
    requests,
    requestCounts,
    zones: [...zones.values()],
    metrics: { fleet, ...dispatch, snapshotBuildMs: snapshotBuildMs.summary() },
  };
}

/**
 * Pushes one snapshot per interval to every connected dashboard. The snapshot
 * is built once and the same string sent to all clients, so ten open
 * dashboards cost the same Redis work as one. Nothing is built while nobody
 * is watching.
 */
export function createLiveServer(intervalMs = 1_000) {
  const wss = new WebSocketServer({ noServer: true });
  let latest: string | undefined;
  let building = false;

  wss.on('connection', (ws) => {
    if (latest) ws.send(latest);
  });

  const timer = setInterval(async () => {
    if (wss.clients.size === 0 || building) return;
    building = true;
    try {
      latest = JSON.stringify(await buildSnapshot());
      for (const ws of wss.clients) {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
        ws.send(latest);
      }
    } catch (err) {
      console.error('[live] snapshot failed', err);
    } finally {
      building = false;
    }
  }, intervalMs);

  return { wss, timer };
}
