import { Redis, type Result } from 'ioredis';
import { config } from './config.js';

/**
 * Redis key layout
 *
 *   agents:geo          GEO   live positions of fresh agents (stale ones are swept out)
 *   agents:free         GEO   the AVAILABLE subset of agents:geo: what dispatch searches
 *   agents:pos          GEO   last known position of every tracked agent, stale included (dashboard only)
 *   agents:lastseen     ZSET  agentId -> last ping time (ms)
 *   requests:open       ZSET  requestId -> createdAt, every request not yet finished (dashboard index)
 *   requests:ended      ZSET  requestId -> endedAt, requests finished in the last few seconds (dashboard index)
 *   agent:{id}          HASH  status (AVAILABLE|OFFERED|BUSY), requestId, offers, accepts (answered offers only)
 *   req:{id}            HASH  state, lat, lng, priority, agentId, attempts, offerDistM, createdAt, updatedAt
 *   zones:stats         HASH  zone -> "supply|demandPerMin", rewritten every second by the live service
 *   zones:demand:{min}  HASH  zone -> requests created in that epoch minute (expires after 15 min)
 *   gps:anomalies       LIST  latest impossible-movement events, JSON, capped
 *   dispatch:queue      ZSET  requestId -> priority rank × 1e13 + createdAt; workers pop the lowest
 *   req:{id}:tried      SET   agents already offered this request (never re-offer)
 *   offers:deadlines    ZSET  "{requestId}|{agentId}" -> offer expiry time (ms)
 */
export const keys = {
  geo: 'agents:geo',
  free: 'agents:free',
  pos: 'agents:pos',
  lastSeen: 'agents:lastseen',
  openRequests: 'requests:open',
  endedRequests: 'requests:ended',
  deadlines: 'offers:deadlines',
  agent: (id: string) => `agent:${id}`,
  req: (id: string) => `req:${id}`,
  tried: (id: string) => `req:${id}:tried`,
  zoneStats: 'zones:stats',
  zoneDemand: (minute: number) => `zones:demand:${minute}`,
  anomalies: 'gps:anomalies',
  queue: 'dispatch:queue',
};

/*
 * Every multi-key state change is a Lua script so it runs atomically. This is
 * what stops two concurrent requests from claiming the same agent, and a late
 * "accept" from racing an offer timeout.
 */

/*
 * agents:free holds only AVAILABLE agents, so a search returns the nearest free
 * agents directly. Searching every agent and filtering afterwards let a crowd of
 * busy agents in a hotspot fill the whole result list and hide free ones further
 * out: a booking at Connaught Place came back "no agent found" while 522 free
 * agents were within 10 km. Every script that changes an agent's status keeps
 * this index in step, in the same atomic step.
 */

/** Puts an agent that just became AVAILABLE back in the free index, at its live position. */
const MARK_FREE = `
local function markFree(freeKey, geoKey, agentId)
  local pos = redis.call('GEOPOS', geoKey, agentId)[1]
  if pos then redis.call('GEOADD', freeKey, pos[1], pos[2], agentId) end
end
`;

/** KEYS: agent, req, deadlines, free. ARGV: reqId, agentId, now, deadline, distanceM.
 *  Returns 1 = claimed, 0 = agent not available, -1 = request no longer searching. */
const CLAIM_AGENT = `
if redis.call('HGET', KEYS[2], 'state') ~= 'SEARCHING' then return -1 end
if redis.call('HGET', KEYS[1], 'status') ~= 'AVAILABLE' then return 0 end
redis.call('ZREM', KEYS[4], ARGV[2])
redis.call('HSET', KEYS[1], 'status', 'OFFERED', 'requestId', ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'OFFERED', 'agentId', ARGV[2], 'updatedAt', ARGV[3], 'offerDistM', ARGV[5])
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
redis.call('HINCRBY', KEYS[1], 'offers', 1)
redis.call('HINCRBY', KEYS[1], 'accepts', 1)
redis.call('ZREM', KEYS[3], ARGV[1] .. '|' .. ARGV[2])
return 1
`;

/** Rejection or timeout: free the agent, remember it was tried, go back to SEARCHING.
 *  KEYS: agent, req, deadlines, tried, free, geo. ARGV: reqId, agentId, now. Returns 1 if released. */
const RELEASE_OFFER = MARK_FREE + `
if redis.call('HGET', KEYS[2], 'state') ~= 'OFFERED' then return 0 end
if redis.call('HGET', KEYS[2], 'agentId') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'SEARCHING', 'updatedAt', ARGV[3])
redis.call('HDEL', KEYS[2], 'agentId')
if redis.call('HGET', KEYS[1], 'requestId') == ARGV[1] then
  redis.call('HSET', KEYS[1], 'status', 'AVAILABLE')
  redis.call('HDEL', KEYS[1], 'requestId')
  markFree(KEYS[5], KEYS[6], ARGV[2])
end
redis.call('HINCRBY', KEYS[1], 'offers', 1)
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

/** KEYS: agent, req, free, geo. ARGV: reqId, agentId, now. Returns 1 if completed. */
const COMPLETE_TRIP = MARK_FREE + `
if redis.call('HGET', KEYS[2], 'state') ~= 'PICKED_UP' then return 0 end
if redis.call('HGET', KEYS[2], 'agentId') ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'COMPLETED', 'updatedAt', ARGV[3])
if redis.call('HGET', KEYS[1], 'requestId') == ARGV[1] then
  redis.call('HSET', KEYS[1], 'status', 'AVAILABLE')
  redis.call('HDEL', KEYS[1], 'requestId')
  markFree(KEYS[3], KEYS[4], ARGV[2])
end
return 1
`;

/** KEYS: req, deadlines, free, geo. ARGV: reqId, now.
 *  Returns the freed agentId ('' if none), or false if the request was already terminal.
 *  Builds the agent key inside the script, which is fine on a single Redis node. */
const CANCEL_REQUEST = MARK_FREE + `
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
    markFree(KEYS[3], KEYS[4], agentId)
  end
  return agentId
end
return ''
`;

/** Creates a request and (optionally) queues it, or refuses because the queue is full.
 *  One script, so a full queue never leaves a half-created request behind and a worker
 *  never pops an id whose hash doesn't exist yet.
 *  KEYS: req, open, queue, demandBucket.
 *  ARGV: id, lat, lng, priority, now, maxQueue, queueScore, zone, ttlS, useQueue ('1'|'0'), bucketTtlS.
 *  Returns 1 if created, 0 if the queue was full. */
const CREATE_REQUEST = `
local useQueue = ARGV[10] == '1'
if useQueue and redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[6]) then return 0 end
redis.call('HSET', KEYS[1], 'state', 'CREATED', 'lat', ARGV[2], 'lng', ARGV[3], 'priority', ARGV[4],
  'attempts', 0, 'createdAt', ARGV[5], 'updatedAt', ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[9])
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
redis.call('HINCRBY', KEYS[4], ARGV[8], 1)
redis.call('EXPIRE', KEYS[4], ARGV[11])
if useQueue then redis.call('ZADD', KEYS[3], ARGV[7], ARGV[1]) end
return 1
`;

/** Adds the AVAILABLE agents among a batch of pings to the free index (the others stay out).
 *  KEYS: free. ARGV: lng, lat, agentId, repeated. Builds agent keys inside (single node). */
const INDEX_FREE = `
for i = 1, #ARGV, 3 do
  if redis.call('HGET', 'agent:' .. ARGV[i + 2], 'status') == 'AVAILABLE' then
    redis.call('GEOADD', KEYS[1], ARGV[i], ARGV[i + 1], ARGV[i + 2])
  end
end
return 1
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
    claimAgent(agentKey: string, reqKey: string, deadlinesKey: string, freeKey: string, ...argv: Arg[]): Result<number, Context>;
    acceptOffer(agentKey: string, reqKey: string, deadlinesKey: string, ...argv: Arg[]): Result<number, Context>;
    releaseOffer(agentKey: string, reqKey: string, deadlinesKey: string, triedKey: string, freeKey: string, geoKey: string, ...argv: Arg[]): Result<number, Context>;
    transition(reqKey: string, ...argv: Arg[]): Result<number, Context>;
    completeTrip(agentKey: string, reqKey: string, freeKey: string, geoKey: string, ...argv: Arg[]): Result<number, Context>;
    cancelRequest(reqKey: string, deadlinesKey: string, freeKey: string, geoKey: string, ...argv: Arg[]): Result<string | null, Context>;
    indexFree(freeKey: string, ...argv: Arg[]): Result<number, Context>;
    hmgetMany(numKeys: number, ...keysThenFields: string[]): Result<(string | null)[][], Context>;
    createRequest(reqKey: string, openKey: string, queueKey: string, bucketKey: string, ...argv: Arg[]): Result<number, Context>;
  }
}

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });

redis.defineCommand('claimAgent', { numberOfKeys: 4, lua: CLAIM_AGENT });
redis.defineCommand('acceptOffer', { numberOfKeys: 3, lua: ACCEPT_OFFER });
redis.defineCommand('releaseOffer', { numberOfKeys: 6, lua: RELEASE_OFFER });
redis.defineCommand('transition', { numberOfKeys: 1, lua: TRANSITION });
redis.defineCommand('completeTrip', { numberOfKeys: 4, lua: COMPLETE_TRIP });
redis.defineCommand('cancelRequest', { numberOfKeys: 4, lua: CANCEL_REQUEST });
redis.defineCommand('indexFree', { numberOfKeys: 1, lua: INDEX_FREE });
redis.defineCommand('hmgetMany', { lua: HMGET_MANY });
redis.defineCommand('createRequest', { numberOfKeys: 4, lua: CREATE_REQUEST });

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
