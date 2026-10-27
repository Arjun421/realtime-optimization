import { keys, redis } from './redis.js';
import type { ZoneStat } from './scoring.js';

/** Zone stats are written every second; older than this means the live service is down. */
const MAX_AGE_MS = 10_000;

/**
 * Supply and demand for the given zones, as last written by the live service.
 * Empty if the stats are missing or too old, which simply turns zone
 * depletion off rather than failing dispatch.
 */
export async function readZoneStats(zones: number[]): Promise<Map<number, ZoneStat>> {
  const out = new Map<number, ZoneStat>();
  const wanted = [...new Set(zones.filter((z) => z >= 0))];
  if (wanted.length === 0) return out;

  const values = await redis.hmget(keys.zoneStats, 'at', ...wanted.map(String));
  const at = Number(values[0]);
  if (!at || Date.now() - at > MAX_AGE_MS) return out;

  wanted.forEach((zone, i) => {
    const raw = values[i + 1];
    if (!raw) return out.set(zone, { supply: 0, demandPerMin: 0 });
    const [supply, demandPerMin] = raw.split('|').map(Number);
    out.set(zone, { supply: supply ?? 0, demandPerMin: demandPerMin ?? 0 });
  });
  return out;
}

/** Counts a new request toward its zone's demand for the current minute. */
export function demandBucket(now: number): { key: string; ttlS: number } {
  return { key: keys.zoneDemand(Math.floor(now / 60_000)), ttlS: 15 * 60 };
}
