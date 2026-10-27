import type { GatewayToServer, ServerToGateway } from '@dispatch/shared';
import WebSocket from 'ws';
import { config } from './config.js';
import { Fleet, stats } from './fleet.js';
import { demandPoint } from './random.js';

const gatewayUrl = config.apiUrl.replace(/^http/, 'ws') + '/gateway';
let socket: WebSocket | undefined;

function send(msg: GatewayToServer) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

const fleet = new Fleet(config.agents, send);

function connect() {
  const ws = new WebSocket(gatewayUrl);
  ws.on('open', () => {
    socket = ws;
    console.log(`[sim] connected to ${gatewayUrl} with ${config.agents} agents`);
  });
  ws.on('message', (raw) => fleet.handle(JSON.parse(raw.toString()) as ServerToGateway));
  ws.on('close', () => {
    socket = undefined;
    console.log('[sim] disconnected, retrying in 1s');
    setTimeout(connect, 1_000);
  });
  ws.on('error', (err) => console.error(`[sim] socket error: ${err.message}`));
}

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  fleet.tick(now - last);
  last = now;
}, config.tickMs);

let requestsSent = 0;
let requestErrors = 0;

/** Fires requests at `requestsPerSec` on average, spread evenly across each second. */
function generateDemand() {
  const intervalMs = 100;
  const perInterval = (config.requestsPerSec * intervalMs) / 1000;
  let carry = 0;
  setInterval(() => {
    carry += perInterval;
    for (; carry >= 1; carry--) {
      const pickup = demandPoint();
      requestsSent++;
      fetch(`${config.apiUrl}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...pickup, priority: Math.random() < 0.05 ? 'high' : 'normal' }),
      })
        .then((res) => {
          if (!res.ok) requestErrors++;
        })
        .catch(() => requestErrors++);
    }
  }, intervalMs);
}

async function report() {
  const modes = fleet.modeCounts();
  let api = '';
  try {
    const m = (await (await fetch(`${config.apiUrl}/metrics`)).json()) as {
      fleet: { fresh: number; stale: number; medianFreshnessMs: number | null };
      dispatchDecisionMs: { p50?: number; p95?: number; p99?: number };
      counters: Record<string, number>;
    };
    const d = m.dispatchDecisionMs;
    api =
      ` | api: fresh=${m.fleet.fresh} stale=${m.fleet.stale} freshness(p50)=${m.fleet.medianFreshnessMs}ms` +
      ` decision p50=${d.p50 ?? '-'}ms p95=${d.p95 ?? '-'}ms p99=${d.p99 ?? '-'}ms` +
      ` assigned=${m.counters.requestsAssigned} unassigned=${m.counters.requestsUnassigned}` +
      ` timeouts=${m.counters.offersTimedOut} conflicts=${m.counters.claimConflicts}`;
  } catch {
    api = ' | api: unreachable';
  }
  console.log(
    `[sim] idle=${modes.idle} offered=${modes.offered} pickup=${modes.to_pickup} dropoff=${modes.to_dropoff} dark=${modes.dark}` +
      ` | glitches=${stats.glitches} requests=${requestsSent} errors=${requestErrors} offers=${stats.offersReceived}` +
      ` accepted=${stats.accepted} rejected=${stats.rejected} ignored=${stats.ignored} completed=${stats.completed}` +
      api,
  );
}

connect();
// Let the first round of pings land before demand starts.
setTimeout(generateDemand, config.pingIntervalMs + 500);
setInterval(() => void report(), 5_000);
