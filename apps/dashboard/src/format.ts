import type { RequestState } from '@dispatch/shared';

export const fmtInt = (n: number) => n.toLocaleString('en-US');

/** "850 ms", "12 s", "3 min 05 s": whatever a person reads fastest. */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return '–';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, '0')} s`;
}

export function fmtDistance(m: number | undefined): string {
  if (m === undefined) return '–';
  return m < 1_000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** What a customer request's state means, in words. */
export const REQUEST_STATE_TEXT: Record<RequestState, string> = {
  CREATED: 'Just arrived',
  SEARCHING: 'Looking for a driver',
  OFFERED: 'Offered to a driver, waiting for their answer',
  ASSIGNED: 'Driver accepted and is on the way',
  PICKED_UP: 'In the car',
  COMPLETED: 'Trip finished',
  UNASSIGNED: 'No driver could be found',
  CANCELLED: 'Cancelled',
};
