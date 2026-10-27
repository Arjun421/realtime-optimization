import type { Priority } from '@dispatch/shared';
import { config } from './config.js';
import { predictAcceptance, predictEtaSeconds } from './ml.js';

export interface Candidate {
  agentId: string;
  distanceM: number;
  lastSeenMs: number;
  /** Zone the agent is in now, or -1 outside the grid. */
  zone: number;
  /** Offers this agent has answered (accepted, rejected or let time out). */
  offers: number;
  accepts: number;
}

export interface ZoneStat {
  /** Free agents with fresh GPS right now. */
  supply: number;
  /** Recent request rate. */
  demandPerMin: number;
}

export interface RankContext {
  priority: Priority;
  /** Offers already made for this request (0 for the first). */
  attempt: number;
  pickupZone: number;
  zones: Map<number, ZoneStat>;
  now: number;
}

/** Why a candidate scored what it did. Stored with the OFFERED event for later analysis. */
export interface ScoreParts {
  etaS: number;
  pAccept: number;
  retryS: number;
  depletion: number;
  depletionS: number;
  stalenessS: number;
  costS: number;
}

export type Ranked = Candidate & { score: ScoreParts };

/**
 * How much zone depletion matters per priority. A critical request takes the
 * best agent even if that empties a zone; a low-priority one should not.
 */
const DEPLETION_WEIGHT: Record<Priority, number> = { low: 1.5, normal: 1, high: 0.5, critical: 0 };

const s = config.scoring;

export function etaSeconds(distanceM: number): number {
  return (distanceM * s.detourFactor) / s.speedMps;
}

/**
 * Smoothed acceptance rate. With no history it is the prior; every answered
 * offer pulls it toward the agent's real rate. Stops one early rejection from
 * branding a new agent as unreliable.
 */
export function acceptProbability(c: Pick<Candidate, 'offers' | 'accepts'>): number {
  return (c.accepts + s.priorAcceptRate * s.priorWeight) / (c.offers + s.priorWeight);
}

/**
 * 0..1: how short of free agents the agent's zone would be, over the horizon,
 * if we took this one. 0 when the pickup is in the same zone: then the agent
 * is serving exactly the demand we would be protecting.
 */
export function depletion(c: Candidate, ctx: RankContext): number {
  if (c.zone < 0 || c.zone === ctx.pickupZone) return 0;
  const stat = ctx.zones.get(c.zone);
  if (!stat) return 0;
  const expected = stat.demandPerMin * s.depletionHorizonMin;
  if (expected <= 0) return 0;
  const leftAfter = stat.supply - 1;
  return Math.min(1, Math.max(0, (expected - leftAfter) / expected));
}

/**
 * Expected seconds until the passenger has an agent heading their way, plus
 * the harm done elsewhere. Lower is better.
 *
 *   ETA                          drive time to pickup
 * + (1 − p) / p × retryCost      expected declines before an accept (geometric), each costing time
 * + depletion × weight × cost    leaving a soon-busy zone with nobody
 * + GPS age × cost               an old position means the ETA is less certain
 */
export function score(c: Candidate, ctx: RankContext): ScoreParts {
  const ml = config.strategy === 'ml';
  const etaS = ml ? predictEtaSeconds(c.distanceM) : etaSeconds(c.distanceM);
  const pAccept = ml
    ? predictAcceptance({ smoothedP: acceptProbability(c), distanceM: c.distanceM, attempt: ctx.attempt + 1, priority: ctx.priority })
    : acceptProbability(c);
  const retryS = ((1 - pAccept) / pAccept) * s.retryCostS;
  const dep = depletion(c, ctx);
  const depletionS = dep * DEPLETION_WEIGHT[ctx.priority] * s.depletionCostS;
  const stalenessS = (Math.max(0, ctx.now - c.lastSeenMs) / 1000) * s.stalenessCostPerS;
  return {
    etaS,
    pAccept,
    retryS,
    depletion: dep,
    depletionS,
    stalenessS,
    costS: etaS + retryS + depletionS + stalenessS,
  };
}

/** Orders eligible agents best-first. Dispatch offers to them in this order. */
export function rankCandidates(candidates: Candidate[], ctx: RankContext): Ranked[] {
  const ranked = candidates.map((c) => ({ ...c, score: score(c, ctx) }));
  if (config.strategy === 'nearest') return ranked.sort((a, b) => a.distanceM - b.distanceM);
  return ranked.sort((a, b) => a.score.costS - b.score.costS);
}
