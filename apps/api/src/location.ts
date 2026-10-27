import { CITY_BOUNDS, type LocationPing } from '@dispatch/shared';
import { config } from './config.js';
import { inc } from './metrics.js';
import { checkMovement, forgetAgent, lastFixTs } from './movement.js';
import { keys, redis } from './redis.js';

/** Agents with no ping for this long are forgotten entirely. */
const FORGET_AFTER_MS = 10 * 60_000;

const knownAgents = new Set<string>();
/** How many anomalies the dashboard list keeps. */
const ANOMALY_LOG_SIZE = 100;

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
 * Writes a batch of pings with four commands total (two GEOADDs, one ZADD, one
 * script that adds the AVAILABLE ones to the free index),
 * however many agents are in the batch. That's what keeps 10k agents pinging
 * every few seconds cheap. Impossible jumps are filtered out first.
 */
export async function ingestLocations(items: LocationPing[]): Promise<void> {
  const now = Date.now();
  const geoArgs: (string | number)[] = [];
  const seenArgs: (string | number)[] = [];
  const anomalies: string[] = [];
  const pipeline = redis.pipeline();

  for (const p of items) {
    if (!isValid(p)) {
      inc('pingsRejected');
      continue;
    }
    // Clamp device time so a skewed clock can't make an agent look fresher than it is.
    const ts = Math.min(p.ts, now);
    const prevTs = lastFixTs(p.agentId);
    if (prevTs !== undefined && ts <= prevTs) {
      inc('pingsRejected'); // duplicate or out of order
      continue;
    }
    const { accept, anomaly } = checkMovement(p.agentId, { lat: p.lat, lng: p.lng, ts });
    if (anomaly) anomalies.push(JSON.stringify(anomaly));
    if (!accept) continue;

    geoArgs.push(p.lng, p.lat, p.agentId);
    seenArgs.push(ts, p.agentId);
    if (!knownAgents.has(p.agentId)) {
      knownAgents.add(p.agentId);
      pipeline.hsetnx(keys.agent(p.agentId), 'status', 'AVAILABLE');
    }
  }
  if (anomalies.length) {
    pipeline.lpush(keys.anomalies, ...anomalies);
    pipeline.ltrim(keys.anomalies, 0, ANOMALY_LOG_SIZE - 1);
  }
  if (geoArgs.length === 0) {
    await pipeline.exec();
    return;
  }

  pipeline.geoadd(keys.geo, ...geoArgs);
  pipeline.geoadd(keys.pos, ...geoArgs);
  // After the HSETNX above, so a brand-new agent is already AVAILABLE when this runs.
  pipeline.indexFree(keys.free, ...geoArgs);
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
      if (stale.length) {
        await redis.zrem(keys.geo, ...stale);
        await redis.zrem(keys.free, ...stale);
      }

      const forgotten = await redis.zrangebyscore(keys.lastSeen, '-inf', now - FORGET_AFTER_MS);
      if (forgotten.length) {
        await redis.zrem(keys.lastSeen, ...forgotten);
        await redis.zrem(keys.pos, ...forgotten);
        await redis.zrem(keys.free, ...forgotten);
        for (const id of forgotten) {
          knownAgents.delete(id);
          forgetAgent(id);
        }
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
