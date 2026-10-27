import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { acceptProbability, depletion, rankCandidates, type Candidate, type RankContext } from './scoring.js';

const now = 1_000_000;
const agent = (over: Partial<Candidate>): Candidate => ({
  agentId: 'a',
  distanceM: 1_000,
  lastSeenMs: now,
  zone: 1,
  offers: 0,
  accepts: 0,
  ...over,
});
const ctx = (over: Partial<RankContext> = {}): RankContext => ({
  priority: 'normal',
  attempt: 0,
  pickupZone: 1,
  zones: new Map(),
  now,
  ...over,
});

describe('acceptProbability', () => {
  it('is the prior with no history', () => {
    assert.equal(acceptProbability({ offers: 0, accepts: 0 }), 0.75);
  });

  it('moves toward the observed rate as history grows', () => {
    const few = acceptProbability({ offers: 2, accepts: 0 });
    const many = acceptProbability({ offers: 40, accepts: 0 });
    assert.ok(few < 0.75 && few > many);
    assert.ok(many < 0.1);
  });
});

describe('depletion', () => {
  const zones = new Map([[2, { supply: 2, demandPerMin: 1 }]]); // 5 requests due, 2 free

  it('is 0 when the agent is already in the pickup zone', () => {
    assert.equal(depletion(agent({ zone: 1 }), ctx({ pickupZone: 1, zones })), 0);
  });

  it('is high when taking the agent leaves its zone short', () => {
    // 5 expected, 1 left after taking this agent: (5 - 1) / 5
    assert.equal(depletion(agent({ zone: 2 }), ctx({ pickupZone: 1, zones })), 0.8);
  });

  it('is 0 for a zone with spare agents or no data', () => {
    const plenty = new Map([[2, { supply: 30, demandPerMin: 1 }]]);
    assert.equal(depletion(agent({ zone: 2 }), ctx({ zones: plenty })), 0);
    assert.equal(depletion(agent({ zone: 3 }), ctx({ zones })), 0);
  });
});

describe('rankCandidates (smart)', () => {
  it('prefers a slightly farther agent who usually accepts over one who usually declines', () => {
    const decliner = agent({ agentId: 'decliner', distanceM: 800, offers: 20, accepts: 4 });
    // 200 m farther ≈ 29 s more ETA, less than the expected cost of the likely decline.
    const reliable = agent({ agentId: 'reliable', distanceM: 1_000, offers: 20, accepts: 19 });
    const [first] = rankCandidates([decliner, reliable], ctx());
    assert.equal(first?.agentId, 'reliable');
  });

  it('still takes a much nearer agent even if it declines more', () => {
    const decliner = agent({ agentId: 'decliner', distanceM: 800, offers: 20, accepts: 4 });
    const reliable = agent({ agentId: 'reliable', distanceM: 1_600, offers: 20, accepts: 19 });
    assert.equal(rankCandidates([decliner, reliable], ctx())[0]?.agentId, 'decliner');
  });

  it('still takes the nearest when acceptance history is equal', () => {
    const near = agent({ agentId: 'near', distanceM: 500 });
    const far = agent({ agentId: 'far', distanceM: 3_000 });
    assert.equal(rankCandidates([far, near], ctx())[0]?.agentId, 'near');
  });

  it('protects a depleted zone for normal requests but not for critical ones', () => {
    const zones = new Map([[2, { supply: 1, demandPerMin: 2 }]]);
    const lastInZone = agent({ agentId: 'last-in-zone', distanceM: 600, zone: 2 });
    // 400 m farther ≈ 58 s more ETA, less than the 90 s cost of emptying zone 2.
    const fromSpareZone = agent({ agentId: 'spare', distanceM: 1_000, zone: 3 });
    const normal = rankCandidates([lastInZone, fromSpareZone], ctx({ zones }));
    const critical = rankCandidates([lastInZone, fromSpareZone], ctx({ zones, priority: 'critical' }));
    assert.equal(normal[0]?.agentId, 'spare');
    assert.equal(critical[0]?.agentId, 'last-in-zone');
  });

  it('penalises stale GPS', () => {
    const stale = agent({ agentId: 'stale', distanceM: 1_000, lastSeenMs: now - 12_000 });
    const fresh = agent({ agentId: 'fresh', distanceM: 1_050 });
    assert.equal(rankCandidates([stale, fresh], ctx())[0]?.agentId, 'fresh');
  });
});

describe('learned models (ml.ts)', async () => {
  const { predictAcceptance, predictEtaSeconds } = await import('./ml.js');

  it('predicts drive time that grows with distance and is far below the old formula', () => {
    const near = predictEtaSeconds(500);
    const far = predictEtaSeconds(3_000);
    assert.ok(far > near && near >= 0);
    assert.ok(far < (3_000 * 1.3) / 9); // the formula overestimated badly
  });

  it('trusts a better acceptance history more', () => {
    const low = predictAcceptance({ smoothedP: 0.4, distanceM: 1_000, attempt: 1, priority: 'normal' });
    const high = predictAcceptance({ smoothedP: 0.9, distanceM: 1_000, attempt: 1, priority: 'normal' });
    assert.ok(high > low && low > 0 && high < 1);
  });
});
