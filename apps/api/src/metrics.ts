import { config } from './config.js';

/** Fixed-size ring buffer of recent samples; percentiles are computed on read. */
export class LatencySamples {
  private samples: Float64Array;
  private next = 0;
  private filled = false;

  constructor(size = 10_000) {
    this.samples = new Float64Array(size);
  }

  reset() {
    this.next = 0;
    this.filled = false;
  }

  add(ms: number) {
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.samples.length;
    if (this.next === 0) this.filled = true;
  }

  summary() {
    const n = this.filled ? this.samples.length : this.next;
    if (n === 0) return { count: 0 };
    const sorted = this.samples.slice(0, n).sort();
    const at = (p: number) => round(sorted[Math.min(n - 1, Math.floor(p * n))]!);
    return { count: n, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: round(sorted[n - 1]!) };
  }
}

const round = (ms: number) => Math.round(ms * 100) / 100;

export const metrics = {
  /** Time to pick and lock an agent once dispatch starts (search + filter + rank + claim). */
  decisionMs: new LatencySamples(),
  /** Request creation → first offer sent. Includes any queueing. */
  timeToFirstOfferMs: new LatencySamples(),
  /** Request creation → an agent accepted. */
  timeToAssignMs: new LatencySamples(),
  /** Request creation → picked up: the customer's real wait. */
  waitToPickupMs: new LatencySamples(),
  /** Straight-line distance from the accepted agent to the pickup. */
  assignedDistanceM: new LatencySamples(),
  /** Time a request sat in the dispatch queue before a worker took it. */
  queueWaitMs: new LatencySamples(),
  counters: {
    pingsIngested: 0,
    pingsRejected: 0,
    /** Pings implying impossible speed; not written to the geo index. */
    pingsImpossible: 0,
    /** Agents whose new position was accepted after repeated consistent pings. */
    agentsReanchored: 0,
    /** Refused with 429 because the dispatch queue was full. */
    requestsRejected: 0,
    /** Requests found stuck in CREATED (e.g. a worker died holding them) and re-queued. */
    requestsRecovered: 0,
    requestsCreated: 0,
    offersSent: 0,
    offersAccepted: 0,
    offersRejected: 0,
    offersTimedOut: 0,
    claimConflicts: 0,
    requestsAssigned: 0,
    requestsUnassigned: 0,
    requestsCompleted: 0,
    requestsCancelled: 0,
  },
};

export type Counter = keyof typeof metrics.counters;

export function inc(counter: Counter, by = 1) {
  metrics.counters[counter] += by;
}

/** Everything this process measured itself (no Redis reads). */
export function dispatchMetrics() {
  return {
    strategy: config.strategy,
    dispatchDecisionMs: metrics.decisionMs.summary(),
    timeToFirstOfferMs: metrics.timeToFirstOfferMs.summary(),
    timeToAssignMs: metrics.timeToAssignMs.summary(),
    waitToPickupMs: metrics.waitToPickupMs.summary(),
    assignedDistanceM: metrics.assignedDistanceM.summary(),
    queueWaitMs: metrics.queueWaitMs.summary(),
    counters: metrics.counters,
  };
}

/** Clears samples and counters, so a benchmark can skip its warm-up period. */
export function resetMetrics() {
  for (const value of Object.values(metrics)) {
    if (value instanceof LatencySamples) value.reset();
  }
  for (const key of Object.keys(metrics.counters) as Counter[]) metrics.counters[key] = 0;
}
