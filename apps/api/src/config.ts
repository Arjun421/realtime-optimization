const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return value;
};

export const config = {
  port: num('PORT', 4000),
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
} as const;
