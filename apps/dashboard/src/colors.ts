import type { AgentLiveStatus, LiveZone, RequestState } from '@dispatch/shared';

export type RGBA = [number, number, number, number];

/** Same order as AGENT_LIVE_STATUSES, so the status code indexes straight in. */
export const AGENT_COLORS: Record<AgentLiveStatus, RGBA> = {
  AVAILABLE: [34, 197, 94, 220],
  OFFERED: [250, 204, 21, 255],
  BUSY: [56, 130, 246, 230],
  STALE: [120, 120, 130, 160],
};

export const REQUEST_COLORS: Record<RequestState, RGBA> = {
  CREATED: [239, 68, 68, 255],
  SEARCHING: [239, 68, 68, 255],
  OFFERED: [249, 115, 22, 255],
  ASSIGNED: [148, 163, 184, 200],
  PICKED_UP: [167, 139, 250, 255],
  COMPLETED: [34, 197, 94, 120],
  UNASSIGNED: [217, 70, 239, 255],
  CANCELLED: [120, 120, 130, 120],
};

/** Red where waiting requests outnumber free agents, faint green where supply is spare. */
export function zoneColor(z: LiveZone): RGBA {
  const gap = z.demand - z.supply;
  if (gap > 0) return [239, 68, 68, 50 + Math.min(gap, 5) * 30];
  return [34, 197, 94, Math.min(z.supply, 20) * 2.5];
}

export const cssColor = ([r, g, b]: RGBA) => `rgb(${r} ${g} ${b})`;
