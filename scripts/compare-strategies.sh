#!/usr/bin/env bash
# Runs the same simulation once per dispatch strategy and compares outcomes.
#
#   scripts/compare-strategies.sh                      # defaults below
#   AGENTS=10000 REQUESTS_PER_SEC=15 MEASURE_S=900 scripts/compare-strategies.sh
#
# Each run starts from an empty Redis, warms up (metrics discarded), then
# measures. Stops any API / live service / simulator started from this repo.
set -euo pipefail

# A sleeping laptop pauses every timer and then jumps the simulation forward,
# which silently ruins the numbers. Keep macOS awake for the whole run.
if [[ -z "${CAFFEINATED:-}" ]] && command -v caffeinate > /dev/null; then
  CAFFEINATED=1 exec caffeinate -i "$0" "$@"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="${AGENTS:-3000}"
REQUESTS_PER_SEC="${REQUESTS_PER_SEC:-5}"
WARMUP_S="${WARMUP_S:-720}"
MEASURE_S="${MEASURE_S:-600}"
STRATEGIES="${STRATEGIES:-nearest smart}"
OUT="${OUT:-$ROOT/results/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"

stop_all() { pkill -f "$ROOT/node_modules/.bin/tsx" 2>/dev/null || true; sleep 2; }
trap stop_all EXIT

cd "$ROOT"
for strategy in $STRATEGIES; do
  echo "== $strategy: $AGENTS agents, $REQUESTS_PER_SEC req/s, ${WARMUP_S}s warm-up + ${MEASURE_S}s measured"
  stop_all
  docker compose exec -T redis redis-cli FLUSHALL > /dev/null

  DISPATCH_STRATEGY=$strategy npx tsx apps/api/src/index.ts > "$OUT/$strategy-api.log" 2>&1 &
  DISPATCH_STRATEGY=$strategy npx tsx apps/api/src/live-main.ts > "$OUT/$strategy-live.log" 2>&1 &
  until curl -sf localhost:4000/health > /dev/null; do sleep 1; done
  AGENTS=$AGENTS REQUESTS_PER_SEC=$REQUESTS_PER_SEC npx tsx apps/simulator/src/index.ts > "$OUT/$strategy-sim.log" 2>&1 &

  sleep "$WARMUP_S"
  curl -sf -X POST localhost:4000/metrics/reset > /dev/null
  started=$(date +%s)
  sleep "$MEASURE_S"
  elapsed=$(( $(date +%s) - started ))
  # sleep(1) doesn't count time the machine spent asleep; the wall clock does.
  if (( elapsed > MEASURE_S + 30 )); then
    echo "!! measuring took ${elapsed}s instead of ${MEASURE_S}s: the machine probably slept. Results are invalid." >&2
    exit 1
  fi
  curl -sf localhost:4000/metrics/dispatch > "$OUT/$strategy.json"
  curl -sf localhost:4001/alerts > "$OUT/$strategy-alerts.json" || echo '[]' > "$OUT/$strategy-alerts.json"
done

node scripts/compare-report.mjs "$OUT" $STRATEGIES | tee "$OUT/report.md"
