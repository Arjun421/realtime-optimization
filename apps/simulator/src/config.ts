const num = (name: string, fallback: number) => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return value;
};

export const config = {
  apiUrl: process.env.API_URL ?? 'http://localhost:4000',
  agents: num('AGENTS', 1_000),
  requestsPerSec: num('REQUESTS_PER_SEC', 2),
  pingIntervalMs: num('PING_INTERVAL_MS', 3_000),
  tickMs: 500,
  /** Per-agent chance per tick of losing GPS for 20-60s. ~0.00025 keeps ~2% of the fleet dark. */
  darkRatePerTick: num('DARK_RATE', 0.00025),
  /** Share of offers an agent simply never answers (forces the offer-timeout path). */
  ignoreOfferRate: num('IGNORE_OFFER_RATE', 0.05),
};
