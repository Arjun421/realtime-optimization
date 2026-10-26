import { CITY_BOUNDS, type LocationPing } from '@dispatch/shared';
import { config } from './config.js';
import { inc } from './metrics.js';
import { keys, redis } from './redis.js';

/** Agents with no ping for this long are forgotten entirely. */
const FORGET_AFTER_MS = 10 * 60_000;

const knownAgents = new Set<string>();

function isValid(p: LocationPing): boolean {
  return (
    typeof p.agentId === 'string' &&
    p.agentId.length > 0 &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Number.isFinite(p.ts) &&
    p.lat >= CITY_BOUNDS.minLat - 1 &&
    p.lat <= CITY_BOUNDS.maxLat + 1 &&
    p.lng >= CITY_BOUNDS.minLng - 1 &&
    p.lng <= CITY_BOUNDS.maxLng + 1
  );
}

/**
 * Writes a batch of pings with three commands total (two GEOADDs, one ZADD),
 * however many agents are in the batch. That's what keeps 10k agents pinging
 * every few seconds cheap.
 */
export async function ingestLocations(items: LocationPing[]): Promise<void> {
  const now = Date.now();
  const geoArgs: (string | number)[] = [];
  const seenArgs: (string | number)[] = [];
  const pipeline = redis.pipeline();

  for (const p of items) {
    if (!isValid(p)) {
      inc('pingsRejected');
      continue;
    }
    geoArgs.push(p.lng, p.lat, p.agentId);
    // Clamp device time so a skewed clock can't make an agent look fresher than it is.
    seenArgs.push(Math.min(p.ts, now), p.agentId);
    if (!knownAgents.has(p.agentId)) {
      knownAgents.add(p.agentId);
      pipeline.hsetnx(keys.agent(p.agentId), 'status', 'AVAILABLE');
    }
  }
  if (geoArgs.length === 0) return;

  pipeline.geoadd(keys.geo, ...geoArgs);
  pipeline.geoadd(keys.pos, ...geoArgs);
  pipeline.zadd(keys.lastSeen, ...seenArgs);
  await pipeline.exec();
  inc('pingsIngested', geoArgs.length / 3);
}

/**
 * Removes stale agents from the geo index so candidate searches never see
 * them. They are re-added automatically on their next ping. Dispatch also
 * checks freshness itself, so a sweep lagging slightly behind is harmless.
 */
export function startStaleSweeper(intervalMs = 2_000): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const now = Date.now();
      const stale = await redis.zrangebyscore(keys.lastSeen, '-inf', now - config.staleAfterMs);
      if (stale.length) await redis.zrem(keys.geo, ...stale);

      const forgotten = await redis.zrangebyscore(keys.lastSeen, '-inf', now - FORGET_AFTER_MS);
      if (forgotten.length) {
        await redis.zrem(keys.lastSeen, ...forgotten);
        await redis.zrem(keys.pos, ...forgotten);
        forgotten.forEach((id) => knownAgents.delete(id));
      }
    } catch (err) {
      console.error('[sweeper] failed', err);
    }
  }, intervalMs);
}

export async function fleetSnapshot() {
  const now = Date.now();
  const scores = await redis.zrange(keys.lastSeen, 0, -1, 'WITHSCORES');
  const ages: number[] = [];
  for (let i = 1; i < scores.length; i += 2) ages.push(now - Number(scores[i]));
  return fleetStats(ages);
}

/** Fresh/stale counts and median GPS age from each agent's time since last ping. */
export function fleetStats(ages: number[]) {
  ages.sort((a, b) => a - b);
  const stale = ages.filter((a) => a > config.staleAfterMs).length;
  return {
    tracked: ages.length,
    fresh: ages.length - stale,
    stale,
    medianFreshnessMs: ages[Math.floor(ages.length / 2)] ?? null,
  };
}
