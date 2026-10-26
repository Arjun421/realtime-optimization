# Real-time Dispatch Engine

Given thousands of moving agents (drivers, ambulances, field staff) and a new
request, decide **who should take it right now**, in milliseconds, without
double-assigning anyone, and recover when agents reject, ignore offers or lose GPS.

![Live dashboard: 10,000 simulated agents in Delhi NCR](docs/dashboard.png)

*Live dashboard during a 10,000-agent, 50 req/s simulation. Dots are agents (green available, yellow offered,
blue busy, grey stale GPS). Orange markers are requests waiting on an offer, with a line to the offered agent.
Red squares are zones where waiting requests outnumber free agents.*

## Architecture

```
 simulator (N agents) ──WS /gateway──►  API (Fastify + ws)
   pings every ~3s                        │
   accepts / rejects offers               ├─► Redis   live state: GEO index, last-seen, agent + request hashes,
   drives pickup → dropoff                │           offer deadlines. All state changes are atomic Lua scripts.
                                          │
 POST /requests ─────────────────────────►├─► dispatch: GEOSEARCH → filter (available, fresh, not tried)
                                          │             → rank → atomic claim → offer (timeout → next agent)
                                          │
                                          └─► Postgres + PostGIS   append-only request/event history (batched)

 dashboard (React + MapLibre + deck.gl) ◄──WS /live── live service (separate process, read-only on Redis)
   map, zone supply/demand, latency           one snapshot/s: every agent, open requests, zones, metrics
```

**Request lifecycle**

```
CREATED → SEARCHING → OFFERED → ASSIGNED → PICKED_UP → COMPLETED
              ▲          │
              └──────────┘  rejected / timed out → next candidate
SEARCHING → UNASSIGNED   (nobody eligible, or max attempts)
any open state → CANCELLED
```

Key design decisions:

- **No double assignment.** Claiming an agent is a Lua script that checks the agent is `AVAILABLE` and the request is still `SEARCHING`, then flips both in one atomic step.
- **Durable offer timeouts.** Deadlines live in a Redis sorted set, not in-process timers, so they survive restarts and work across multiple API instances.
- **Stale GPS is never dispatched.** A sweeper removes agents with no ping in 15s from the geo index, and dispatch re-checks freshness itself.
- **Cheap ingestion.** Each batch of pings, however large, becomes one `GEOADD` plus one `ZADD`.
- **The hot path never waits on Postgres.** Events are buffered and bulk-inserted every 500ms.
- **The dashboard doesn't slow dispatch down.** Snapshots are built in a separate process that only reads Redis.
  The first version built them inside the API and pushed dispatch p99 from ~20 ms to ~34 ms: Node runs one
  thing at a time, and parsing 10k agents plus `JSON.stringify` of ~500 KB took ~50 ms of that thread every
  second, on top of a 10k-result `GEOSEARCH` that kept Redis busy (next point).
- **Bulk reads that don't block Redis.** Positions are read with `ZRANGE` and the geohash scores decoded in JS
  (`apps/api/src/geohash.ts`, checked equal to `GEOPOS` for all 10k agents) instead of a 10k-result `GEOSEARCH`
  that would make Redis busy for ~14 ms. Status reads go through a Lua bulk `HMGET` in chunks of 2,000 keys.
- **Snapshot is built once, sent to every dashboard,** and not built at all while nobody is watching.
  A dashboard that falls behind skips frames instead of buffering without limit.

## Run it

Requires Node 22+ and Docker.

```bash
npm install
npm run infra:up            # Redis + PostGIS
npm run dev:api             # API on :4000
npm run dev:live            # dashboard feed on :4001
npm run dev:dashboard       # dashboard on http://localhost:5173
npm run dev:sim             # 1,000 agents, 2 requests/s

# bigger run
AGENTS=10000 REQUESTS_PER_SEC=50 npm run dev:sim
```

API:

| Method | Path | |
|---|---|---|
| `POST` | `/requests` | `{ lat, lng, priority? }` → creates and dispatches |
| `GET` | `/requests/:id` | current state |
| `POST` | `/requests/:id/cancel` | cancel and free the agent |
| `GET` | `/metrics` | fleet freshness, dispatch latency percentiles, counters |
| `WS` | `/gateway` | agent gateway (see `packages/shared/src/protocol.ts`) |
| `WS` | `:4001/live` | dashboard snapshot stream (see `packages/shared/src/live.ts`) |

The dashboard: click a point or agent to inspect it, click empty map to create a request at that spot (pick the
priority in the panel), and click a zone in "Zones short of agents" to fly to it.

Simulator settings (env): `AGENTS`, `REQUESTS_PER_SEC`, `PING_INTERVAL_MS`, `DARK_RATE`, `IGNORE_OFFER_RATE`, `API_URL`.

## Measured so far

A single local run on a MacBook (Apple Silicon), with API, simulator, Redis and Postgres on the same machine:

| Agents | Load | Dispatch decision p50 / p95 / p99 | Median location freshness |
|---|---|---|---|
| 10,000 | 50 req/s for 40s | 4.7 / 12.2 / 26.4 ms | ~2.0 s |

"Decision" = search + filter + rank + atomic claim, measured inside the API.
This is not yet a proper burst benchmark. See the roadmap.

**Dashboard cost** (Phase 2). Fresh Redis and API per run, 10,000 agents, 50 req/s, 60 s each, one run per row:

| | Dispatch decision p50 / p95 / p99 | Request → first offer p99 |
|---|---|---|
| No dashboard | 5.1 / 10.4 / 20.5 ms | 26 ms |
| Dashboard connected, first version (inside the API, `GEOSEARCH` reads) | 4.5 / 11.7 / 34.3 ms | 55 ms |
| Dashboard connected, separate live service (current) | 4.6 / 13.0 / 22.4 ms | 30 ms |

Snapshot with 10,000 agents and ~1,200 drawn requests: ~500 KB of JSON once per second, built in
51 ms p50 / 62 ms p95 by the live service. Small run-to-run differences are within noise; all processes share one laptop.

## Roadmap

- [x] **Phase 1: core loop.** Ingestion, geo index, stale detection, state machine, atomic assignment, reassignment, event store, simulator
- [x] **Phase 2: live dashboard.** Map of agents and requests (MapLibre + deck.gl), zone supply/demand panel, live latency and throughput, separate read-only snapshot service
- [ ] **Phase 3: smart dispatch.** Multi-factor ranking (ETA, acceptance probability, zone depletion, GPS staleness, priority), impossible-movement detection, zone capacity alerts
- [ ] **Phase 4: scale and measure.** Burst load tests (k6), request queue with backpressure, published p50/p95/p99
- [ ] **Phase 5: ML.** ETA, acceptance and demand models trained on the event history, compared against the nearest-agent baseline
