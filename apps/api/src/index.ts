import Fastify from 'fastify';
import type { Priority } from '@dispatch/shared';
import { config } from './config.js';
import { eventStore, migrate, pool } from './db.js';
import { createGateway } from './gateway.js';
import { fleetSnapshot, ingestLocations, startStaleSweeper } from './location.js';
import { dispatchMetrics } from './metrics.js';
import { redis } from './redis.js';
import { cancelRequest, createRequest, getRequest, onOfferResponse, onTripUpdate, startOfferTimeouts } from './requests.js';

const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true });

app.get('/health', async () => ({ ok: true }));

app.post<{ Body: { lat: number; lng: number; priority?: Priority } }>(
  '/requests',
  {
    schema: {
      body: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
        },
      },
    },
  },
  async (req, reply) => {
    const { lat, lng, priority = 'normal' } = req.body;
    reply.code(201);
    return createRequest({ lat, lng, priority });
  },
);

app.get<{ Params: { id: string } }>('/requests/:id', async (req, reply) => {
  const found = await getRequest(req.params.id);
  if (!found) return reply.code(404).send({ error: 'not_found' });
  return found;
});

app.post<{ Params: { id: string } }>('/requests/:id/cancel', async (req, reply) => {
  const cancelled = await cancelRequest(req.params.id);
  if (!cancelled) return reply.code(409).send({ error: 'not_cancellable' });
  return { id: req.params.id, state: 'CANCELLED' };
});

app.get('/metrics', async () => ({ fleet: await fleetSnapshot(), ...dispatchMetrics() }));

/** Polled by the live service; cheap because it touches no Redis. */
app.get('/metrics/dispatch', async () => dispatchMetrics());

const gateway = createGateway({
  onLocations: ingestLocations,
  onOfferResponse,
  onTripUpdate,
});

app.server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (pathname === '/gateway') {
    gateway.handleUpgrade(req, socket, head, (ws) => gateway.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

async function main() {
  await migrate();
  eventStore.start();
  const timers = [startStaleSweeper(), startOfferTimeouts()];

  await app.listen({ port: config.port, host: '0.0.0.0' });

  const shutdown = async () => {
    app.log.info('shutting down');
    timers.forEach(clearInterval);
    gateway.clients.forEach((ws) => ws.terminate());
    await app.close();
    await eventStore.stop();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
