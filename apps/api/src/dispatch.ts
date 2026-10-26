import type { LatLng } from '@dispatch/shared';
import { config } from './config.js';
import { eventStore } from './db.js';
import { sendToAgent } from './gateway.js';
import { inc, metrics } from './metrics.js';
import { keys, redis } from './redis.js';
import { rankCandidates, type Candidate } from './scoring.js';

/**
 * Nearby agents that can take work right now: AVAILABLE, fresh GPS, and not
 * already offered this request.
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
    'ASC', 'COUNT', limit, 'WITHDIST',
  )) as [string, string][];

  const nearby = raw.filter(([id]) => !tried.has(id));
  if (nearby.length === 0) return [];

  // One round trip for every candidate's status and last-seen time.
  const ids = nearby.map(([id]) => id);
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hget(keys.agent(id), 'status');
  pipeline.zmscore(keys.lastSeen, ...ids);
  const results = (await pipeline.exec()) ?? [];
  const lastSeen = (results[ids.length]?.[1] ?? []) as (string | null)[];

  const freshAfter = Date.now() - config.staleAfterMs;
  const candidates: Candidate[] = [];
  nearby.forEach(([agentId, distKm], i) => {
    const status = results[i]?.[1];
    const seen = lastSeen[i] == null ? null : Number(lastSeen[i]);
    if (status !== 'AVAILABLE' || seen === null || seen < freshAfter) return;
    candidates.push({ agentId, distanceM: Number(distKm) * 1000, lastSeenMs: seen });
  });
  return candidates;
}

async function markUnassigned(requestId: string, reason: string) {
  const ok = await redis.transition(keys.req(requestId), 'SEARCHING', 'UNASSIGNED', Date.now(), '');
  if (!ok) return;
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
  const tried = new Set(await redis.smembers(keys.tried(requestId)));

  for (const [i, radiusKm] of config.searchRadiiKm.entries()) {
    // Widen the result count with the radius, or a crowd of busy agents
    // close by would hide available ones further out.
    const limit = config.candidatesPerSearch * 2 ** i;
    const candidates = await findCandidates(pickup, radiusKm, limit, tried);

    for (const candidate of rankCandidates(candidates)) {
      const now = Date.now();
      const expiresAt = now + config.offerTimeoutMs;
      const claimed = await redis.claimAgent(
        keys.agent(candidate.agentId), keys.req(requestId), keys.deadlines,
        requestId, candidate.agentId, now, expiresAt,
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
        data: { distanceM: Math.round(candidate.distanceM), radiusKm, attempt: attempts + 1 },
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
