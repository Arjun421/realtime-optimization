import { createServer } from 'node:http';
import { config } from './config.js';
import { createLiveServer } from './live.js';
import { redis } from './redis.js';

/**
 * The dashboard feed runs as its own process. Building a 10k-agent snapshot
 * costs tens of milliseconds of CPU (parsing Redis replies, JSON.stringify),
 * and Node runs one thing at a time: inside the API that work made dispatch
 * wait and pushed its p99 up. Here it only shares Redis, and only reads.
 */
const live = createLiveServer();

const server = createServer((req, res) => {
  res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/health' ? { ok: true, dashboards: live.wss.clients.size } : { error: 'not_found' }));
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
