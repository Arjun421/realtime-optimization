import type { Priority } from '@dispatch/shared';
import type { Redis } from 'ioredis';
import { config } from './config.js';
import { inc, metrics } from './metrics.js';
import { hmgetMany, keys, redis } from './redis.js';

/**
 * Queue order: priority first, then arrival. The score is
 * rank × RANK_SPAN + createdAt, and RANK_SPAN is bigger than any epoch-ms
 * timestamp, so every critical request sorts before every normal one and
 * the creation time can be read back out of the score.
 */
const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
const RANK_SPAN = 1e13;

export function queueScore(priority: Priority, createdAt: number): number {
  return PRIORITY_RANK[priority] * RANK_SPAN + createdAt;
}

/** A request still CREATED this long after arrival, and not in the queue, is stuck. */
const STUCK_AFTER_MS = 30_000;

/**
 * Runs `count` workers, each popping one request at a time and dispatching
 * it. This is what bounds concurrency: a burst of 2,000 requests becomes a
 * queue that 32 workers drain, instead of 2,000 dispatches fighting over the
 * event loop and Redis at once.
 *
 * Each worker blocks on its own Redis connection (BZPOPMIN), so an idle
 * queue costs nothing and several API instances can share one queue.
 * Returns a function that stops the workers.
 */
export function startDispatchWorkers(handle: (requestId: string) => Promise<void>, count = config.dispatchWorkers) {
  let running = true;
  const connections: Redis[] = [];

  const workers = Array.from({ length: count }, async () => {
    const conn = redis.duplicate();
    connections.push(conn);
    while (running) {
      try {
        const popped = await conn.bzpopmin(keys.queue, 1); // 1 s timeout so stopping is prompt
        if (!popped) continue;
        const [, requestId, score] = popped;
        metrics.queueWaitMs.add(Date.now() - (Number(score) % RANK_SPAN));
        await handle(requestId);
      } catch (err) {
        if (running) console.error('[queue] worker failed', err);
      }
    }
  });

  return async () => {
    running = false;
    connections.forEach((c) => c.disconnect());
    await Promise.allSettled(workers);
  };
}

/**
 * Popping is at-most-once: if a process dies between taking a request off the
 * queue and moving it to SEARCHING, nothing else would ever pick it up. This
 * sweeper finds requests still CREATED well after arrival and queues them
 * again (or dispatches them directly when the queue is off).
 */
export function startStuckRequestRecovery(redispatch: (requestId: string) => Promise<void>, intervalMs = 10_000) {
  return setInterval(async () => {
    try {
      const now = Date.now();
      const ids = await redis.zrangebyscore(keys.openRequests, now - 60 * 60_000, now - STUCK_AFTER_MS, 'LIMIT', 0, 2_000);
      if (ids.length === 0) return;
      const rows = await hmgetMany(ids.map(keys.req), ['state', 'priority', 'createdAt']);
      const stuck = ids.flatMap((id, i) => {
        const [state, priority, createdAt] = rows[i] ?? [];
        return state === 'CREATED' ? [{ id, priority: (priority ?? 'normal') as Priority, createdAt: Number(createdAt) }] : [];
      });
      for (const r of stuck) {
        if (config.queueEnabled) {
          // NX: if it's still sitting in the queue (a long backlog), leave it where it is.
          const added = await redis.zadd(keys.queue, 'NX', queueScore(r.priority, r.createdAt), r.id);
          if (added) inc('requestsRecovered');
        } else {
          inc('requestsRecovered');
          void redispatch(r.id);
        }
      }
    } catch (err) {
      console.error('[queue] recovery failed', err);
    }
  }, intervalMs);
}

export const queueDepth = () => redis.zcard(keys.queue);
