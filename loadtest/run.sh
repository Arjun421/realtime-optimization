#!/usr/bin/env bash
# Starts a fresh system, runs one k6 scenario against it and saves the results.
#
#   loadtest/run.sh spike on            # queue on
#   loadtest/run.sh spike off           # queue off (dispatch every request immediately)
#   SPIKE=600 loadtest/run.sh spike on  # scenario settings pass through to k6
#
# The simulator supplies AGENTS agents and no demand of its own; k6 is the demand.
set -euo pipefail

if [[ -z "${CAFFEINATED:-}" ]] && command -v caffeinate > /dev/null; then
  CAFFEINATED=1 exec caffeinate -i "$0" "$@"
fi

SCENARIO="${1:?scenario: steady | spike | breakpoint}"
QUEUE="${2:-on}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="${AGENTS:-10000}"
OUT="${OUT:-$ROOT/results/load-$(date +%Y%m%d-%H%M%S)}"
NAME="$SCENARIO-queue-$QUEUE"
mkdir -p "$OUT"

stop_all() { pkill -f "$ROOT/node_modules/.bin/tsx" 2>/dev/null || true; sleep 2; }
trap stop_all EXIT

cd "$ROOT"
stop_all
docker compose exec -T redis redis-cli FLUSHALL > /dev/null

QUEUE_ENABLED=$([[ $QUEUE == on ]] && echo true || echo false) \
  npx tsx apps/api/src/index.ts > "$OUT/$NAME-api.log" 2>&1 &
npx tsx apps/api/src/live-main.ts > "$OUT/$NAME-live.log" 2>&1 &
until curl -sf localhost:4000/health > /dev/null; do sleep 1; done
AGENTS=$AGENTS REQUESTS_PER_SEC=0 npx tsx apps/simulator/src/index.ts > "$OUT/$NAME-sim.log" 2>&1 &

sleep 15 # every agent pings at least a few times
curl -sf -X POST localhost:4000/metrics/reset > /dev/null

echo "== $NAME: $AGENTS agents"
started=$(date +%s)
k6 run --quiet --summary-export "$OUT/$NAME-k6.json" "loadtest/$SCENARIO.js" 2>&1 | tee "$OUT/$NAME-k6.log" || true
echo "k6 wall time: $(( $(date +%s) - started ))s"

# Let queued requests finish dispatching before reading the numbers.
until [[ "$(curl -sf localhost:4000/metrics/dispatch | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).queue.depth))')" == 0 ]]; do sleep 1; done
sleep 3
curl -sf localhost:4000/metrics/dispatch > "$OUT/$NAME-api.json"
node loadtest/summary.mjs "$OUT/$NAME"
