import type { DispatchStrategy } from '@dispatch/shared';

const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return value;
};

const strategy = (process.env.DISPATCH_STRATEGY ?? 'smart') as DispatchStrategy;
if (strategy !== 'smart' && strategy !== 'nearest' && strategy !== 'ml') {
  throw new Error(`DISPATCH_STRATEGY must be "smart", "ml" or "nearest", got "${strategy}"`);
}

export const config = {
  port: num('PORT', 4000),
  /** Port of the separate live-snapshot service (live-main.ts). */
  livePort: num('LIVE_PORT', 4001),
  /** Where the live service fetches dispatch metrics from. */
  apiUrl: process.env.API_URL ?? 'http://localhost:4000',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://dispatch:dispatch@localhost:5432/dispatch',

  /** An agent with no ping for this long is treated as stale and never offered work. */
  staleAfterMs: num('STALE_AFTER_MS', 15_000),
  /** How long an agent has to accept an offer before we move on. */
  offerTimeoutMs: num('OFFER_TIMEOUT_MS', 8_000),
  /** Give up and mark the request UNASSIGNED after this many offers. */
  maxOfferAttempts: num('MAX_OFFER_ATTEMPTS', 5),
  /** Candidate search widens through these radii until someone eligible is found. */
  searchRadiiKm: [2, 5, 10, 20],
  candidatesPerSearch: num('CANDIDATES_PER_SEARCH', 50),

  /**
   * Request queue. On: POST /requests only enqueues, a fixed pool of workers
   * dispatches, and a full queue answers 429. Off: every request is
   * dispatched immediately, however many arrive at once (the Phase 1-3 path).
   */
  queueEnabled: (process.env.QUEUE_ENABLED ?? 'true') !== 'false',
  /** Concurrent dispatches per API instance when the queue is on. */
  dispatchWorkers: num('DISPATCH_WORKERS', 128),
  /** Queue length at which new requests are refused with 429. */
  maxQueue: num('MAX_QUEUE', 2_000),

  /**
   * "nearest" is the Phase 1 baseline, "smart" the Phase 3 hand-tuned ranking,
   * "ml" the same ranking with the learned ETA, acceptance and demand models.
   */
  strategy,

  /**
   * Smart ranking. Every term is in seconds, so the weights mean something:
   * "a likely rejection costs about this long", not an arbitrary 0.3.
   */
  scoring: {
    /** Straight-line distance × this ≈ road distance. */
    detourFactor: num('SCORE_DETOUR_FACTOR', 1.3),
    /** Assumed average driving speed in the city. */
    speedMps: num('SCORE_SPEED_MPS', 9),
    /** Time lost each time an offer is declined or ignored (wait for the answer, then a farther agent). */
    retryCostS: num('SCORE_RETRY_COST_S', 20),
    /** Acceptance prior: a new agent is assumed to accept this often... */
    priorAcceptRate: num('SCORE_PRIOR_ACCEPT', 0.75),
    /** ...with the weight of this many past offers. */
    priorWeight: num('SCORE_PRIOR_WEIGHT', 4),
    /** Cost of taking the last free agent out of a zone that is about to need them. */
    depletionCostS: num('SCORE_DEPLETION_COST_S', 90),
    /** Zone demand is projected this far ahead when judging depletion. */
    depletionHorizonMin: num('SCORE_DEPLETION_HORIZON_MIN', 5),
    /** Each second of GPS age adds this much: the agent may have moved. */
    stalenessCostPerS: num('SCORE_STALENESS_COST', 1),
  },

  /** A ping implying more than this speed (and more than minJumpM) is rejected as impossible. */
  maxSpeedMps: num('MAX_SPEED_MPS', 55),
  minJumpM: num('MIN_JUMP_M', 300),
  /** This many consecutive pings agreeing on a new spot are believed (a real relocation, not a glitch). */
  reanchorAfterPings: num('REANCHOR_AFTER_PINGS', 3),
} as const;
