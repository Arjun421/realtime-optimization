import {
  ZONE_COLS,
  ZONE_ROWS,
  zoneLabel,
  zoneOf,
  type DispatchStrategy,
  type GpsAnomaly,
  type LatencySummary,
  type LiveRequest,
  type LiveSnapshot,
  type LiveZone,
  type Priority,
  type QueueStatus,
  type RequestState,
  type ZoneAlert,
} from '@dispatch/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { decodeGeoScore } from './geohash.js';
import { fleetStats } from './location.js';
import { demandShares } from './ml.js';
import { LatencySamples } from './metrics.js';
import { hmgetMany, keys, redis } from './redis.js';

const WAITING = new Set<RequestState>(['CREATED', 'SEARCHING', 'OFFERED']);
/** Counted but not drawn: once picked up, the pickup point no longer means anything on the map. */
const COUNT_ONLY = new Set<RequestState>(['PICKED_UP']);
/** A dashboard with this much unsent data skips frames instead of piling up memory. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Request rate per zone is averaged over this many whole minutes plus the current one. */
const DEMAND_WINDOW_MIN = 5;
/** Anomalies shown on the dashboard. */
const ANOMALIES_SHOWN = 30;

/**
 * Zone alert rule: a zone is short when the requests expected there over the
 * horizon are at least `minExpected` and the free agents *within reach* (the
 * zone and its 8 neighbours, matching dispatch's first 2 km search) cover less
 * than `coverage` of them. Counting only the zone itself flagged edge zones
 * sitting next to plenty of free agents. It must stay short for `openAfterMs`
 * to raise an alert and stay fine for `closeAfterMs` to clear it, so one noisy
 * second neither raises nor clears anything.
 */
const ALERT_RULE = { minExpected: 2, coverage: 0.5, openAfterMs: 10_000, closeAfterMs: 30_000 };

/** Indexes into AGENT_LIVE_STATUSES. */
const STATUS_CODE: Record<string, number> = { AVAILABLE: 0, OFFERED: 1, BUSY: 2 };
const STALE_CODE = 3;

/** ~1 m precision is plenty for a map and keeps the JSON small. */
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

type Fleet = LiveSnapshot['metrics']['fleet'];
interface DispatchMetrics {
  strategy: DispatchStrategy;
  dispatchDecisionMs: LatencySummary;
  timeToFirstOfferMs: LatencySummary;
  timeToAssignMs: LatencySummary;
  waitToPickupMs: LatencySummary;
  assignedDistanceM: LatencySummary;
  queueWaitMs: LatencySummary;
  queue: QueueStatus;
  counters: Record<string, number>;
}

const snapshotBuildMs = new LatencySamples(1_000);
const empty = { count: 0 };
let lastDispatchMetrics: DispatchMetrics = {
  strategy: config.strategy,
  dispatchDecisionMs: empty,
  timeToFirstOfferMs: empty,
  timeToAssignMs: empty,
  waitToPickupMs: empty,
  assignedDistanceM: empty,
  queueWaitMs: empty,
  queue: { enabled: config.queueEnabled, workers: 0, maxDepth: config.maxQueue, depth: 0 },
  counters: {},
};

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
  if (!entry) zones.set(zone, (entry = { zone, supply: 0, demand: 0, demandPerMin: 0 }));
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

/** Requests per minute by zone, from the per-minute buckets the API increments. */
async function readDemandRates(now: number, zones: Map<number, LiveZone>): Promise<void> {
  const minute = Math.floor(now / 60_000);
  const pipeline = redis.pipeline();
  for (let m = minute - DEMAND_WINDOW_MIN; m <= minute; m++) pipeline.hgetall(keys.zoneDemand(m));
  const buckets = ((await pipeline.exec()) ?? []).map(([, v]) => (v ?? {}) as Record<string, string>);

  const minutes = DEMAND_WINDOW_MIN + (now % 60_000) / 60_000;
  const totals = new Map<number, number>();
  let city = 0;
  for (const bucket of buckets) {
    for (const [zone, count] of Object.entries(bucket)) {
      totals.set(Number(zone), (totals.get(Number(zone)) ?? 0) + Number(count));
      city += Number(count);
    }
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;

  if (config.strategy === 'ml') {
    // Learned model: the whole city's recent rate split by each zone's long-run share.
    // Far less noisy than one zone's last few bookings (see ml/report.md).
    demandShares().forEach((share, zone) => {
      if (share > 0) zoneEntry(zones, zone).demandPerMin = round2((share * city) / minutes);
    });
    return;
  }
  for (const [zone, total] of totals) {
    if (zone >= 0) zoneEntry(zones, zone).demandPerMin = round2(total / minutes);
  }
}

/** Publishes supply and demand rate for dispatch's zone-depletion score. Replaced whole, atomically. */
async function writeZoneStats(now: number, zones: Map<number, LiveZone>): Promise<void> {
  const fields: Record<string, string> = { at: String(now) };
  for (const z of zones.values()) fields[z.zone] = `${z.supply}|${z.demandPerMin}`;
  await redis.multi().del(keys.zoneStats).hset(keys.zoneStats, fields).exec();
}

interface AlertState {
  shortSince?: number;
  fineSince?: number;
  alert?: ZoneAlert;
}
const alertStates = new Map<number, AlertState>();

/** Free agents in the zone and the 8 around it. */
function supplyWithinReach(zone: number, zones: Map<number, LiveZone>): number {
  const row = Math.floor(zone / ZONE_COLS);
  const col = zone % ZONE_COLS;
  let total = 0;
  for (let r = Math.max(0, row - 1); r <= Math.min(ZONE_ROWS - 1, row + 1); r++) {
    for (let c = Math.max(0, col - 1); c <= Math.min(ZONE_COLS - 1, col + 1); c++) {
      total += zones.get(r * ZONE_COLS + c)?.supply ?? 0;
    }
  }
  return total;
}

function updateAlerts(now: number, zones: Map<number, LiveZone>): ZoneAlert[] {
  const horizon = config.scoring.depletionHorizonMin;
  for (const zone of new Set([...zones.keys(), ...alertStates.keys()])) {
    const z = zones.get(zone) ?? { zone, supply: 0, demand: 0, demandPerMin: 0 };
    const expected = z.demandPerMin * horizon;
    const nearby = supplyWithinReach(zone, zones);
    const short = expected >= ALERT_RULE.minExpected && nearby < expected * ALERT_RULE.coverage;
    const state = alertStates.get(zone) ?? {};

    if (short) {
      state.fineSince = undefined;
      state.shortSince ??= now;
      if (!state.alert && now - state.shortSince >= ALERT_RULE.openAfterMs) {
        state.alert = { zone, severity: 'warning', since: state.shortSince, supply: 0, expectedDemand: 0, waiting: 0 };
        console.log(`[alerts] ${zoneLabel(zone)} short: ${nearby} free nearby for ~${expected.toFixed(1)} requests in ${horizon} min`);
      }
    } else {
      state.shortSince = undefined;
      if (state.alert) {
        state.fineSince ??= now;
        if (now - state.fineSince >= ALERT_RULE.closeAfterMs) {
          console.log(`[alerts] ${zoneLabel(zone)} cleared after ${Math.round((now - state.alert.since) / 1000)} s`);
          state.alert = undefined;
        }
      }
    }

    if (state.alert) {
      Object.assign(state.alert, {
        severity: nearby === 0 ? 'critical' : 'warning',
        supply: nearby,
        expectedDemand: Math.round(expected * 10) / 10,
        waiting: z.demand,
      });
    }
    if (state.alert || state.shortSince) alertStates.set(zone, state);
    else alertStates.delete(zone);
  }

  return [...alertStates.values()]
    .flatMap((s) => (s.alert ? [s.alert] : []))
    .sort((a, b) => (a.severity === b.severity ? a.since - b.since : a.severity === 'critical' ? -1 : 1));
}

export function currentAlerts(): ZoneAlert[] {
  return [...alertStates.values()].flatMap((s) => (s.alert ? [s.alert] : []));
}

async function readAnomalies(): Promise<GpsAnomaly[]> {
  const raw = await redis.lrange(keys.anomalies, 0, ANOMALIES_SHOWN - 1);
  return raw.map((r) => JSON.parse(r) as GpsAnomaly);
}

/**
 * One pass over live state: zone supply/demand (published for dispatch),
 * alerts, and the full dashboard snapshot.
 */
export async function buildSnapshot(): Promise<LiveSnapshot> {
  const started = performance.now();
  const now = Date.now();
  const zones = new Map<number, LiveZone>();
  const [{ agents, fleet }, { requests, requestCounts }, , anomalies, dispatch] = await Promise.all([
    readAgents(now, zones),
    readRequests(zones),
    readDemandRates(now, zones),
    readAnomalies(),
    fetchDispatchMetrics(),
  ]);
  await writeZoneStats(now, zones);
  const alerts = updateAlerts(now, zones);
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
    alerts,
    anomalies,
    metrics: { fleet, ...dispatch, snapshotBuildMs: snapshotBuildMs.summary() },
  };
}

/**
 * Every interval: rebuild live state, publish zone stats for dispatch, and
 * push the snapshot to connected dashboards. The zone stats are needed even
 * with nobody watching, so the loop always runs; serialising the snapshot is
 * skipped when there is no one to send it to. One snapshot string is shared
 * by all dashboards.
 */
export function createLiveServer(intervalMs = 1_000) {
  const wss = new WebSocketServer({ noServer: true });
  let latest: string | undefined;
  let building = false;

  wss.on('connection', (ws) => {
    if (latest) ws.send(latest);
  });

  const timer = setInterval(async () => {
    if (building) return;
    building = true;
    try {
      const snapshot = await buildSnapshot();
      if (wss.clients.size === 0) {
        latest = undefined;
        return;
      }
      latest = JSON.stringify(snapshot);
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
