import { Redis, type Result } from 'ioredis';
import { config } from './config.js';

/**
 * Redis key layout
 *
 *   agents:geo          GEO   live positions of fresh agents (stale ones are swept out)
 *   agents:lastseen     ZSET  agentId -> last ping time (ms)
 *   agent:{id}          HASH  status (AVAILABLE|OFFERED|BUSY), requestId
 *   req:{id}            HASH  state, lat, lng, priority, agentId, attempts, createdAt, updatedAt
 *   req:{id}:tried      SET   agents already offered this request (never re-offer)
 *   offers:deadlines    ZSET  "{requestId}|{agentId}" -> offer expiry time (ms)
 */
export const keys = {
  geo: 'agents:geo',
  lastSeen: 'agents:lastseen',
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

type Arg = string | number;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    claimAgent(agentKey: string, reqKey: string, deadlinesKey: string, ...argv: Arg[]): Result<number, Context>;
    acceptOffer(agentKey: string, reqKey: string, deadlinesKey: string, ...argv: Arg[]): Result<number, Context>;
    releaseOffer(agentKey: string, reqKey: string, deadlinesKey: string, triedKey: string, ...argv: Arg[]): Result<number, Context>;
    transition(reqKey: string, ...argv: Arg[]): Result<number, Context>;
    completeTrip(agentKey: string, reqKey: string, ...argv: Arg[]): Result<number, Context>;
    cancelRequest(reqKey: string, deadlinesKey: string, ...argv: Arg[]): Result<string | null, Context>;
  }
}

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

redis.defineCommand('claimAgent', { numberOfKeys: 3, lua: CLAIM_AGENT });
redis.defineCommand('acceptOffer', { numberOfKeys: 3, lua: ACCEPT_OFFER });
redis.defineCommand('releaseOffer', { numberOfKeys: 4, lua: RELEASE_OFFER });
redis.defineCommand('transition', { numberOfKeys: 1, lua: TRANSITION });
redis.defineCommand('completeTrip', { numberOfKeys: 2, lua: COMPLETE_TRIP });
redis.defineCommand('cancelRequest', { numberOfKeys: 2, lua: CANCEL_REQUEST });
