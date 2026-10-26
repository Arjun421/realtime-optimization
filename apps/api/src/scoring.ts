export interface Candidate {
  agentId: string;
  distanceM: number;
  lastSeenMs: number;
}

/**
 * Orders eligible agents best-first. Dispatch offers to them in this order.
 *
 * For now this is plain nearest-first. It is the single place a smarter
 * ranking plugs in: ETA instead of distance, acceptance probability, zone
 * depletion, GPS staleness and request priority.
 */
export function rankCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => a.distanceM - b.distanceM);
}
