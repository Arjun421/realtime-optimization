import { randomUUID } from 'node:crypto';
import type { Priority } from '@dispatch/shared';
import { eventStore } from './db.js';
import { dispatch } from './dispatch.js';
import { sendToAgent } from './gateway.js';
import { zoneOf } from '@dispatch/shared';
import { inc, metrics } from './metrics.js';
import { indexEnded, keys, redis, REQUEST_TTL_S } from './redis.js';
import { config } from './config.js';
import { queueScore } from './queue.js';
import { demandBucket } from './zones.js';

/**
 * Creates a request. With the queue on it is only enqueued, and `null` means
 * the queue is full (the caller answers 429). With the queue off it is
 * dispatched straight away.
 */
export async function createRequest(input: { lat: number; lng: number; priority: Priority }) {
  const id = randomUUID();
  const now = Date.now();
  const bucket = demandBucket(now);
  const created = await redis.createRequest(
    keys.req(id), keys.openRequests, keys.queue, bucket.key,
    id, input.lat, input.lng, input.priority, now, config.maxQueue,
    queueScore(input.priority, now), zoneOf(input), REQUEST_TTL_S, config.queueEnabled ? '1' : '0', bucket.ttlS,
  );
  if (!created) {
    inc('requestsRejected');
    return null;
  }

  inc('requestsCreated');
  eventStore.recordRequest({ id, ...input, at: new Date(now) });
  eventStore.record({ requestId: id, event: 'CREATED', at: new Date(now) });

  if (!config.queueEnabled) void startDispatch(id);
  return { id, state: 'CREATED' as const };
}

/** CREATED → SEARCHING, then find an agent. Called by a queue worker, or directly when the queue is off. */
export async function startDispatch(requestId: string) {
  try {
    const ok = await redis.transition(keys.req(requestId), 'CREATED', 'SEARCHING', Date.now(), '');
    if (!ok) return;
    eventStore.record({ requestId, event: 'SEARCHING' });
    await dispatch(requestId);
  } catch (err) {
    console.error(`[dispatch] request ${requestId} failed`, err);
  }
}

export async function getRequest(id: string) {
  const req = await redis.hgetall(keys.req(id));
  return Object.keys(req).length ? { id, ...req } : null;
}

export async function cancelRequest(id: string): Promise<boolean> {
  const freedAgent = await redis.cancelRequest(keys.req(id), keys.deadlines, id, Date.now());
  if (freedAgent === null) return false;
  await indexEnded(id);
  inc('requestsCancelled');
  eventStore.record({ requestId: id, event: 'CANCELLED', agentId: freedAgent || undefined });
  if (freedAgent) sendToAgent(freedAgent, { type: 'offer_revoked', requestId: id, agentId: freedAgent });
  return true;
}

/** Agent turned the offer down, or it expired: free them and find someone else. */
async function releaseAndRedispatch(requestId: string, agentId: string, reason: 'rejected' | 'timeout') {
  const released = await redis.releaseOffer(
    keys.agent(agentId), keys.req(requestId), keys.deadlines, keys.tried(requestId),
    requestId, agentId, Date.now(),
  );
  if (!released) return false;

  inc(reason === 'rejected' ? 'offersRejected' : 'offersTimedOut');
  eventStore.record({ requestId, event: reason === 'rejected' ? 'OFFER_REJECTED' : 'OFFER_TIMEOUT', agentId });
  await dispatch(requestId);
  return true;
}

export async function onOfferResponse(requestId: string, agentId: string, accept: boolean) {
  if (!accept) {
    await releaseAndRedispatch(requestId, agentId, 'rejected');
    return;
  }

  const accepted = await redis.acceptOffer(
    keys.agent(agentId), keys.req(requestId), keys.deadlines,
    requestId, agentId, Date.now(),
  );
  if (!accepted) {
    // Too late: the offer already timed out or the request was cancelled.
    sendToAgent(agentId, { type: 'offer_revoked', requestId, agentId });
    return;
  }

  const now = Date.now();
  inc('offersAccepted');
  inc('requestsAssigned');
  eventStore.record({ requestId, event: 'ASSIGNED', agentId });
  const req = await redis.hmget(keys.req(requestId), 'lat', 'lng', 'createdAt', 'offerDistM');
  metrics.timeToAssignMs.add(now - Number(req[2]));
  if (req[3]) metrics.assignedDistanceM.add(Number(req[3]));
  sendToAgent(agentId, {
    type: 'assigned',
    requestId,
    agentId,
    pickup: { lat: Number(req[0]), lng: Number(req[1]) },
  });
}

export async function onTripUpdate(requestId: string, agentId: string, event: 'picked_up' | 'completed') {
  const now = Date.now();
  if (event === 'picked_up') {
    const ok = await redis.transition(keys.req(requestId), 'ASSIGNED', 'PICKED_UP', now, agentId);
    if (!ok) return;
    eventStore.record({ requestId, event: 'PICKED_UP', agentId });
    const createdAt = await redis.hget(keys.req(requestId), 'createdAt');
    if (createdAt) metrics.waitToPickupMs.add(now - Number(createdAt));
    return;
  }
  const ok = await redis.completeTrip(keys.agent(agentId), keys.req(requestId), requestId, agentId, now);
  if (ok) {
    await indexEnded(requestId, now);
    inc('requestsCompleted');
    eventStore.record({ requestId, event: 'COMPLETED', agentId });
  }
}

/**
 * Offer deadlines live in Redis (not in-process timers), so they survive an
 * API restart and work the same with several API instances.
 */
export function startOfferTimeouts(intervalMs = 250): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const expired = await redis.zrangebyscore(keys.deadlines, '-inf', Date.now(), 'LIMIT', 0, 500);
      await Promise.all(
        expired.map(async (member) => {
          const [requestId, agentId] = member.split('|') as [string, string];
          const released = await releaseAndRedispatch(requestId, agentId, 'timeout');
          if (released) sendToAgent(agentId, { type: 'offer_revoked', requestId, agentId });
          else await redis.zrem(keys.deadlines, member); // already resolved; drop the leftover entry
        }),
      );
    } catch (err) {
      console.error('[timeouts] failed', err);
    } finally {
      running = false;
    }
  }, intervalMs);
}
