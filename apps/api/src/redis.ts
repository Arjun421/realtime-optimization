import { Redis, type Result } from 'ioredis';
import { config } from './config.js';

/**
 * Redis key layout
 *
 *   agents:geo          GEO   live positions of fresh agents (stale ones are swept out)
 *   agents:pos          GEO   last known position of every tracked agent, stale included (dashboard only)
 *   agents:lastseen     ZSET  agentId -> last ping time (ms)
 *   requests:open       ZSET  requestId -> createdAt, every request not yet finished (dashboard index)
 *   requests:ended      ZSET  requestId -> endedAt, requests finished in the last few seconds (dashboard index)
 *   agent:{id}          HASH  status (AVAILABLE|OFFERED|BUSY), requestId
 *   req:{id}            HASH  state, lat, lng, priority, agentId, attempts, createdAt, updatedAt
 *   req:{id}:tried      SET   agents already offered this request (never re-offer)
 *   offers:deadlines    ZSET  "{requestId}|{agentId}" -> offer expiry time (ms)
 */
export const keys = {
  geo: 'agents:geo',
  pos: 'agents:pos',
  lastSeen: 'agents:lastseen',
  openRequests: 'requests:open',
  endedRequests: 'requests:ended',
  deadlines: 'offers:deadlines',
  agent: (id: string) => `agent:${id}`,
  req: (id: string) => `req:${id}`,
  tried: (id: string) => `req:${id}:tried`,
};

/*
 * Every multi-key state change is a Lua script so it runs atomically. This is
 * what stops two concurrent requests from claiming the same agent, and a late
 * "accept" from racing an offer timeout.
 */

/** KEYS: agent, req, deadlines. ARGV: reqId, agentId, now, deadline.
 *  Returns 1 = claimed, 0 = agent not available, -1 = request no longer searching. */
const CLAIM_AGENT = `
if redis.call('HGET', KEYS[2], 'state') ~= 'SEARCHING' then return -1 end
if redis.call('HGET', KEYS[1], 'status') ~= 'AVAILABLE' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'OFFERED', 'requestId', ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'OFFERED', 'agentId', ARGV[2], 'updatedAt', ARGV[3])
redis.call('HINCRBY', KEYS[2], 'attempts', 1)
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[1] .. '|' .. ARGV[2])
return 1
`;

/** KEYS: agent, req, deadlines. ARGV: reqId, agentId, now. Returns 1 if accepted. */
const ACCEPT_OFFER = `
if redis.call('HGET', KEYS[2], 'state') ~= 'OFFERED' then return 0 end
if redis.call('HGET', KEYS[2], 'agentId') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'ASSIGNED', 'updatedAt', ARGV[3])
redis.call('HSET', KEYS[1], 'status', 'BUSY', 'requestId', ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1] .. '|' .. ARGV[2])
return 1
`;

/** Rejection or timeout: free the agent, remember it was tried, go back to SEARCHING.
 *  KEYS: agent, req, deadlines, tried. ARGV: reqId, agentId, now. Returns 1 if released. */
const RELEASE_OFFER = `
if redis.call('HGET', KEYS[2], 'state') ~= 'OFFERED' then return 0 end
if redis.call('HGET', KEYS[2], 'agentId') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'SEARCHING', 'updatedAt', ARGV[3])
redis.call('HDEL', KEYS[2], 'agentId')
if redis.call('HGET', KEYS[1], 'requestId') == ARGV[1] then
  redis.call('HSET', KEYS[1], 'status', 'AVAILABLE')
  redis.call('HDEL', KEYS[1], 'requestId')
end
redis.call('ZREM', KEYS[3], ARGV[1] .. '|' .. ARGV[2])
redis.call('SADD', KEYS[4], ARGV[2])
redis.call('EXPIRE', KEYS[4], 21600)
return 1
`;

/** Compare-and-set on request state. ARGV[4] = expected agentId, or '' for any.
 *  KEYS: req. ARGV: from, to, now, agentId. Returns 1 if transitioned. */
const TRANSITION = `
if redis.call('HGET', KEYS[1], 'state') ~= ARGV[1] then return 0 end
if ARGV[4] ~= '' and redis.call('HGET', KEYS[1], 'agentId') ~= ARGV[4] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[2], 'updatedAt', ARGV[3])
return 1
`;

/** KEYS: agent, req. ARGV: reqId, agentId, now. Returns 1 if completed. */
const COMPLETE_TRIP = `
if redis.call('HGET', KEYS[2], 'state') ~= 'PICKED_UP' then return 0 end
if redis.call('HGET', KEYS[2], 'agentId') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'COMPLETED', 'updatedAt', ARGV[3])
if redis.call('HGET', KEYS[1], 'requestId') == ARGV[1] then
  redis.call('HSET', KEYS[1], 'status', 'AVAILABLE')
  redis.call('HDEL', KEYS[1], 'requestId')
end
return 1
`;

/** KEYS: req, deadlines. ARGV: reqId, now.
 *  Returns the freed agentId ('' if none), or false if the request was already terminal.
 *  Builds the agent key inside the script, which is fine on a single Redis node. */
const CANCEL_REQUEST = `
local state = redis.call('HGET', KEYS[1], 'state')
if not state or state == 'COMPLETED' or state == 'UNASSIGNED' or state == 'CANCELLED' or state == 'PICKED_UP' then
  return false
end
redis.call('HSET', KEYS[1], 'state', 'CANCELLED', 'updatedAt', ARGV[2])
local agentId = redis.call('HGET', KEYS[1], 'agentId')
if agentId then
  redis.call('ZREM', KEYS[2], ARGV[1] .. '|' .. agentId)
  local agentKey = 'agent:' .. agentId
  if redis.call('HGET', agentKey, 'requestId') == ARGV[1] then
    redis.call('HSET', agentKey, 'status', 'AVAILABLE')
    redis.call('HDEL', agentKey, 'requestId')
  end
  return agentId
end
return ''
`;

/** Read-only bulk HMGET: one reply per key instead of one command per key.
 *  KEYS: hashes. ARGV: fields. Returns one array of values per key. */
const HMGET_MANY = `
local out = {}
for i, key in ipairs(KEYS) do out[i] = redis.call('HMGET', key, unpack(ARGV)) end
return out
`;

type Arg = string | number;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    claimAgent(agentKey: string, reqKey: string, deadlinesKey: string, ...argv: Arg[]): Result<number, Context>;
    acceptOffer(agentKey: string, reqKey: string, deadlinesKey: string, ...argv: Arg[]): Result<number, Context>;
    releaseOffer(agentKey: string, reqKey: string, deadlinesKey: string, triedKey: string, ...argv: Arg[]): Result<number, Context>;
    transition(reqKey: string, ...argv: Arg[]): Result<number, Context>;
    completeTrip(agentKey: string, reqKey: string, ...argv: Arg[]): Result<number, Context>;
    cancelRequest(reqKey: string, deadlinesKey: string, ...argv: Arg[]): Result<string | null, Context>;
    hmgetMany(numKeys: number, ...keysThenFields: string[]): Result<(string | null)[][], Context>;
  }
}

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

redis.defineCommand('claimAgent', { numberOfKeys: 3, lua: CLAIM_AGENT });
redis.defineCommand('acceptOffer', { numberOfKeys: 3, lua: ACCEPT_OFFER });
redis.defineCommand('releaseOffer', { numberOfKeys: 4, lua: RELEASE_OFFER });
redis.defineCommand('transition', { numberOfKeys: 1, lua: TRANSITION });
redis.defineCommand('completeTrip', { numberOfKeys: 2, lua: COMPLETE_TRIP });
redis.defineCommand('cancelRequest', { numberOfKeys: 2, lua: CANCEL_REQUEST });
redis.defineCommand('hmgetMany', { lua: HMGET_MANY });

export const REQUEST_TTL_S = 6 * 60 * 60;
/** Finished requests stay on the dashboard this long. */
export const ENDED_VISIBLE_MS = 5_000;

/**
 * Moves a finished request from the dashboard's open index to its ended index.
 * Both indexes trim themselves here, so they stay small without a cleanup job.
 * Not atomic with the state change: these keys only feed the dashboard, and
 * the worst case is a request drawn one frame late.
 */
export async function indexEnded(requestId: string, now = Date.now()): Promise<void> {
  await redis
    .multi()
    .zrem(keys.openRequests, requestId)
    .zremrangebyscore(keys.openRequests, '-inf', now - REQUEST_TTL_S * 1000)
    .zadd(keys.endedRequests, now, requestId)
    .zremrangebyscore(keys.endedRequests, '-inf', now - ENDED_VISIBLE_MS)
    .exec();
}

/** Scripts block Redis while they run, so bulk reads go in chunks to keep each one short. */
const HMGET_CHUNK = 2_000;

/** HMGET `fields` from every key, in order. */
export async function hmgetMany(hashKeys: string[], fields: string[]): Promise<(string | null)[][]> {
  const chunks: Promise<(string | null)[][]>[] = [];
  for (let i = 0; i < hashKeys.length; i += HMGET_CHUNK) {
    const slice = hashKeys.slice(i, i + HMGET_CHUNK);
    chunks.push(redis.hmgetMany(slice.length, ...slice, ...fields));
  }
  return (await Promise.all(chunks)).flat();
}
