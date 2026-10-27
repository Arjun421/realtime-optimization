import { zoneOf, type LatLng, type Priority } from '@dispatch/shared';
import { config } from './config.js';
import { eventStore } from './db.js';
import { sendToAgent } from './gateway.js';
import { inc, metrics } from './metrics.js';
import { indexEnded, keys, redis } from './redis.js';
import { rankCandidates, type Candidate, type ScoreParts } from './scoring.js';
import { readZoneStats } from './zones.js';

/**
 * Nearby agents that can take work right now: AVAILABLE, fresh GPS, and not
 * already offered this request. Also returns what ranking needs about them
 * (acceptance history, zone) in the same round trip.
 */
async function findCandidates(
  pickup: LatLng,
  radiusKm: number,
  limit: number,
  tried: Set<string>,
): Promise<Candidate[]> {
  const raw = (await redis.call(
    'GEOSEARCH', keys.geo,
    'FROMLONLAT', pickup.lng, pickup.lat,
    'BYRADIUS', radiusKm, 'km',
    'ASC', 'COUNT', limit, 'WITHDIST', 'WITHCOORD',
  )) as [string, string, [string, string]][];

  const nearby = raw.filter(([id]) => !tried.has(id));
  if (nearby.length === 0) return [];

  const ids = nearby.map(([id]) => id);
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hmget(keys.agent(id), 'status', 'offers', 'accepts');
  pipeline.zmscore(keys.lastSeen, ...ids);
  const results = (await pipeline.exec()) ?? [];
  const lastSeen = (results[ids.length]?.[1] ?? []) as (string | null)[];

  const freshAfter = Date.now() - config.staleAfterMs;
  const candidates: Candidate[] = [];
  nearby.forEach(([agentId, distKm, [lng, lat]], i) => {
    const [status, offers, accepts] = (results[i]?.[1] ?? []) as (string | null)[];
    const seen = lastSeen[i] == null ? null : Number(lastSeen[i]);
    if (status !== 'AVAILABLE' || seen === null || seen < freshAfter) return;
    candidates.push({
      agentId,
      distanceM: Number(distKm) * 1000,
      lastSeenMs: seen,
      zone: zoneOf({ lat: Number(lat), lng: Number(lng) }),
      offers: Number(offers ?? 0),
      accepts: Number(accepts ?? 0),
    });
  });
  return candidates;
}

const roundParts = (parts: ScoreParts) =>
  Object.fromEntries(Object.entries(parts).map(([k, v]: [string, number]) => [k, Math.round(v * 1000) / 1000]));

async function markUnassigned(requestId: string, reason: string) {
  const ok = await redis.transition(keys.req(requestId), 'SEARCHING', 'UNASSIGNED', Date.now(), '');
  if (!ok) return;
  await indexEnded(requestId);
  inc('requestsUnassigned');
  eventStore.record({ requestId, event: 'UNASSIGNED', data: { reason } });
}

/**
 * Picks the best available agent for a SEARCHING request, locks them
 * atomically and sends them an offer. Called on creation and again after
 * every rejection or offer timeout.
 */
export async function dispatch(requestId: string): Promise<void> {
  const started = performance.now();
  const req = await redis.hgetall(keys.req(requestId));
  if (req.state !== 'SEARCHING') return;

  const attempts = Number(req.attempts ?? 0);
  if (attempts >= config.maxOfferAttempts) return markUnassigned(requestId, 'max_attempts');

  const pickup = { lat: Number(req.lat), lng: Number(req.lng) };
  const priority = (req.priority ?? 'normal') as Priority;
  const pickupZone = zoneOf(pickup);
  const tried = new Set(await redis.smembers(keys.tried(requestId)));

  for (const [i, radiusKm] of config.searchRadiiKm.entries()) {
    // Widen the result count with the radius, or a crowd of busy agents
    // close by would hide available ones further out.
    const limit = config.candidatesPerSearch * 2 ** i;
    const candidates = await findCandidates(pickup, radiusKm, limit, tried);
    if (candidates.length === 0) continue;

    const zones = config.strategy !== 'nearest'
      ? await readZoneStats(candidates.map((c) => c.zone))
      : new Map();
    const ranked = rankCandidates(candidates, { priority, attempt: attempts, pickupZone, zones, now: Date.now() });

    for (const candidate of ranked) {
      const now = Date.now();
      const expiresAt = now + config.offerTimeoutMs;
      const claimed = await redis.claimAgent(
        keys.agent(candidate.agentId), keys.req(requestId), keys.deadlines,
        requestId, candidate.agentId, now, expiresAt, Math.round(candidate.distanceM),
      );
      if (claimed === -1) return; // request was cancelled meanwhile
      if (claimed === 0) {
        // Another request locked this agent between our read and our claim.
        inc('claimConflicts');
        continue;
      }

      metrics.decisionMs.add(performance.now() - started);
      if (attempts === 0) metrics.timeToFirstOfferMs.add(now - Number(req.createdAt));
      inc('offersSent');
      eventStore.record({
        requestId,
        event: 'OFFERED',
        agentId: candidate.agentId,
        data: {
          strategy: config.strategy,
          distanceM: Math.round(candidate.distanceM),
          radiusKm,
          attempt: attempts + 1,
          candidates: ranked.length,
          ...roundParts(candidate.score),
        },
      });
      sendToAgent(candidate.agentId, {
        type: 'offer',
        requestId,
        agentId: candidate.agentId,
        pickup,
        expiresAt,
      });
      return;
    }
  }

  await markUnassigned(requestId, 'no_candidates');
}
