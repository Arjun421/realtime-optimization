import { randomUUID } from 'node:crypto';
import type { Priority } from '@dispatch/shared';
import { eventStore } from './db.js';
import { dispatch } from './dispatch.js';
import { sendToAgent } from './gateway.js';
import { inc } from './metrics.js';
import { keys, redis } from './redis.js';

const REQUEST_TTL_S = 6 * 60 * 60;

export async function createRequest(input: { lat: number; lng: number; priority: Priority }) {
  const id = randomUUID();
  const now = Date.now();
  await redis
    .multi()
    .hset(keys.req(id), {
      state: 'CREATED',
      lat: input.lat,
      lng: input.lng,
      priority: input.priority,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    .expire(keys.req(id), REQUEST_TTL_S)
    .exec();

  inc('requestsCreated');
  eventStore.recordRequest({ id, ...input, at: new Date(now) });
  eventStore.record({ requestId: id, event: 'CREATED', at: new Date(now) });

  void startDispatch(id);
  return { id, state: 'CREATED' as const };
}

async function startDispatch(requestId: string) {
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

  inc('offersAccepted');
  inc('requestsAssigned');
  eventStore.record({ requestId, event: 'ASSIGNED', agentId });
  const req = await redis.hmget(keys.req(requestId), 'lat', 'lng');
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
    if (ok) eventStore.record({ requestId, event: 'PICKED_UP', agentId });
    return;
  }
  const ok = await redis.completeTrip(keys.agent(agentId), keys.req(requestId), requestId, agentId, now);
  if (ok) {
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
