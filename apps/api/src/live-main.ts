import { createServer } from 'node:http';
import { config } from './config.js';
import { createLiveServer, currentAlerts } from './live.js';
import { redis } from './redis.js';

/**
 * The live service runs as its own process. It reads all live state once a
 * second, publishes zone supply/demand for dispatch, raises zone alerts and
 * feeds dashboards. A 10k-agent pass costs tens of milliseconds of CPU
 * (parsing Redis replies, JSON.stringify), and Node runs one thing at a time:
 * inside the API that work made dispatch wait and pushed its p99 up. Here it
 * only shares Redis, and its only writes are the zone stats.
 */
const live = createLiveServer();

const routes: Record<string, () => unknown> = {
  '/health': () => ({ ok: true, dashboards: live.wss.clients.size }),
  '/alerts': () => currentAlerts(),
};

const server = createServer((req, res) => {
  const route = routes[req.url ?? ''];
  res.writeHead(route ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(route ? route() : { error: 'not_found' }));
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname !== '/live') return socket.destroy();
  live.wss.handleUpgrade(req, socket, head, (ws) => live.wss.emit('connection', ws, req));
});

server.listen(config.livePort, () => {
  console.log(`[live] dashboard feed on ws://localhost:${config.livePort}/live (metrics from ${config.apiUrl})`);
});

const shutdown = () => {
  clearInterval(live.timer);
  live.wss.clients.forEach((ws) => ws.terminate());
  server.close();
  redis.disconnect();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
