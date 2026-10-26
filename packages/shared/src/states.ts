/**
 * Request lifecycle.
 *
 *   CREATED ─► SEARCHING ─► OFFERED ─► ASSIGNED ─► PICKED_UP ─► COMPLETED
 *                 ▲            │
 *                 └────────────┘  (rejected / offer timed out → try next agent)
 *
 *   SEARCHING ─► UNASSIGNED  (no agent found / max attempts reached)
 *   any non-terminal ─► CANCELLED
 */
export const REQUEST_STATES = [
  'CREATED',
  'SEARCHING',
  'OFFERED',
  'ASSIGNED',
  'PICKED_UP',
  'COMPLETED',
  'UNASSIGNED',
  'CANCELLED',
] as const;

export type RequestState = (typeof REQUEST_STATES)[number];

export const REQUEST_TRANSITIONS: Record<RequestState, readonly RequestState[]> = {
  CREATED: ['SEARCHING', 'CANCELLED'],
  SEARCHING: ['OFFERED', 'UNASSIGNED', 'CANCELLED'],
  OFFERED: ['ASSIGNED', 'SEARCHING', 'CANCELLED'],
  ASSIGNED: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: ['COMPLETED'],
  COMPLETED: [],
  UNASSIGNED: [],
  CANCELLED: [],
};

export function canTransition(from: RequestState, to: RequestState): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

/** Agent availability. Only AVAILABLE agents can receive offers. */
export type AgentStatus = 'AVAILABLE' | 'OFFERED' | 'BUSY';

export type Priority = 'low' | 'normal' | 'high' | 'critical';
