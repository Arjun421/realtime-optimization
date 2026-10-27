import type { LatLng } from './geo.js';
import type { Priority, RequestState } from './states.js';

/**
 * Snapshot the API pushes to dashboards over WS /live, about once a second.
 * Agents are sent column-wise (parallel arrays) because 10k small objects
 * would roughly double the payload.
 */

/** What the dashboard colours an agent by. STALE wins over any status. */
export const AGENT_LIVE_STATUSES = ['AVAILABLE', 'OFFERED', 'BUSY', 'STALE'] as const;
export type AgentLiveStatus = (typeof AGENT_LIVE_STATUSES)[number];

export interface LiveRequest {
  id: string;
  lat: number;
  lng: number;
  state: RequestState;
  priority: Priority;
  agentId?: string;
  attempts: number;
  createdAt: number;
}

export interface LiveZone {
  zone: number;
  /** AVAILABLE agents with fresh GPS. */
  supply: number;
  /** Requests still waiting for an agent (CREATED, SEARCHING, OFFERED). */
  demand: number;
  /** Recent request rate, averaged over the last few minutes. */
  demandPerMin: number;
}

/** A zone that has stayed short of free agents long enough to flag. */
export interface ZoneAlert {
  zone: number;
  severity: 'warning' | 'critical';
  /** When the zone first crossed the threshold (epoch ms). */
  since: number;
  /** Free agents in the zone and its 8 neighbours. */
  supply: number;
  /** Requests expected over the alert horizon at the recent rate. */
  expectedDemand: number;
  waiting: number;
}

/** A location ping that implied faster-than-possible movement. */
export interface GpsAnomaly {
  agentId: string;
  at: number;
  from: LatLng;
  to: LatLng;
  speedKmh: number;
  /** True when repeated consistent pings convinced us the agent really is at `to`. */
  reanchored: boolean;
}

export interface LatencySummary {
  count: number;
  p50?: number;
  p95?: number;
  p99?: number;
  max?: number;
}

export type DispatchStrategy = 'nearest' | 'smart' | 'ml';

export interface QueueStatus {
  enabled: boolean;
  workers: number;
  maxDepth: number;
  depth: number;
}

export interface LiveSnapshot {
  type: 'snapshot';
  at: number;
  /** Time the API spent building this snapshot. */
  buildMs: number;
  agents: {
    ids: string[];
    lng: number[];
    lat: number[];
    /** Index into AGENT_LIVE_STATUSES. */
    status: number[];
  };
  /** Requests to draw: open ones (except PICKED_UP) plus ones that ended in the last few seconds. */
  requests: LiveRequest[];
  /** Every open or just-ended request by state, including PICKED_UP. */
  requestCounts: Partial<Record<RequestState, number>>;
  /** Only zones with any supply or demand. */
  zones: LiveZone[];
  alerts: ZoneAlert[];
  /** Most recent first. */
  anomalies: GpsAnomaly[];
  metrics: {
    fleet: { tracked: number; fresh: number; stale: number; medianFreshnessMs: number | null };
    dispatchDecisionMs: LatencySummary;
    timeToFirstOfferMs: LatencySummary;
    snapshotBuildMs: LatencySummary;
    /** Request creation → an agent accepted. */
    timeToAssignMs: LatencySummary;
    /** Request creation → passenger picked up. What the customer actually feels. */
    waitToPickupMs: LatencySummary;
    /** Straight-line distance from the accepted agent to the pickup. */
    assignedDistanceM: LatencySummary;
    /** Time requests waited in the dispatch queue. */
    queueWaitMs: LatencySummary;
    queue: QueueStatus;
    strategy: DispatchStrategy;
    counters: Record<string, number>;
  };
}
