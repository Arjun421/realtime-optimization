import { haversineMeters, type GpsAnomaly } from '@dispatch/shared';
import { config } from './config.js';
import { inc } from './metrics.js';

export interface Fix {
  lat: number;
  lng: number;
  ts: number;
}

/**
 * Last believed position per agent. In memory is safe: an agent's pings all
 * come through the one gateway connection it uses, so they reach the same
 * API instance.
 */
const lastFix = new Map<string, Fix>();
/** Rejected pings that agree with each other; enough of them and we believe the agent moved. */
const pendingJump = new Map<string, Fix & { count: number }>();

/** True if going from `a` to `b` is physically possible for a vehicle. */
function plausible(a: Fix, b: Fix): boolean {
  const meters = haversineMeters(a, b);
  if (meters <= config.minJumpM) return true; // GPS noise, not a jump
  const seconds = (b.ts - a.ts) / 1000;
  return seconds > 0 && meters / seconds <= config.maxSpeedMps;
}

/**
 * Impossible-movement check. A single bad fix (multipath, spoofing, a bug) is
 * dropped, so the agent keeps its last good position and, if the bad fixes
 * continue, goes stale and stops getting offers. If several pings in a row
 * agree on the new spot, the agent really did relocate (e.g. GPS came back
 * after a long tunnel) and we accept it.
 */
export function checkMovement(agentId: string, fix: Fix): { accept: boolean; anomaly?: GpsAnomaly } {
  const prev = lastFix.get(agentId);
  if (!prev || plausible(prev, fix)) {
    lastFix.set(agentId, fix);
    pendingJump.delete(agentId);
    return { accept: true };
  }

  const pending = pendingJump.get(agentId);
  const count = pending && plausible(pending, fix) ? pending.count + 1 : 1;
  const seconds = Math.max(0.001, (fix.ts - prev.ts) / 1000);
  const reanchored = count >= config.reanchorAfterPings;
  const anomaly: GpsAnomaly = {
    agentId,
    at: fix.ts,
    from: { lat: prev.lat, lng: prev.lng },
    to: { lat: fix.lat, lng: fix.lng },
    speedKmh: Math.round((haversineMeters(prev, fix) / seconds) * 3.6),
    reanchored,
  };

  if (reanchored) {
    lastFix.set(agentId, fix);
    pendingJump.delete(agentId);
    inc('agentsReanchored');
    return { accept: true, anomaly };
  }
  pendingJump.set(agentId, { ...fix, count });
  inc('pingsImpossible');
  return { accept: false, anomaly };
}


export function lastFixTs(agentId: string): number | undefined {
  return lastFix.get(agentId)?.ts;
}

export function forgetAgent(agentId: string): void {
  lastFix.delete(agentId);
  pendingJump.delete(agentId);
}
