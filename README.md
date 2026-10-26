# Real-time Dispatch Engine

Given thousands of moving agents (drivers, ambulances, field staff) and a new
request, decide **who should take it right now**, in milliseconds, without
double-assigning anyone, and recover when agents reject, ignore offers or lose GPS.

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

## Run it

Requires Node 22+ and Docker.

```bash
npm install
npm run infra:up            # Redis + PostGIS
npm run dev:api             # API on :4000
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

Simulator settings (env): `AGENTS`, `REQUESTS_PER_SEC`, `PING_INTERVAL_MS`, `DARK_RATE`, `IGNORE_OFFER_RATE`, `API_URL`.

## Measured so far

A single local run on a MacBook (Apple Silicon), with API, simulator, Redis and Postgres on the same machine:

| Agents | Load | Dispatch decision p50 / p95 / p99 | Median location freshness |
|---|---|---|---|
| 10,000 | 50 req/s for 40s | 4.7 / 12.2 / 26.4 ms | ~2.0 s |

"Decision" = search + filter + rank + atomic claim, measured inside the API.
This is not yet a proper burst benchmark. See the roadmap.

## Roadmap

- [x] **Phase 1: core loop.** Ingestion, geo index, stale detection, state machine, atomic assignment, reassignment, event store, simulator
- [ ] **Phase 2: live dashboard.** Map of agents and requests (MapLibre + deck.gl), zone supply/demand panel
- [ ] **Phase 3: smart dispatch.** Multi-factor ranking (ETA, acceptance probability, zone depletion, GPS staleness, priority), impossible-movement detection, zone capacity alerts
- [ ] **Phase 4: scale and measure.** Burst load tests (k6), request queue with backpressure, published p50/p95/p99
- [ ] **Phase 5: ML.** ETA, acceptance and demand models trained on the event history, compared against the nearest-agent baseline
