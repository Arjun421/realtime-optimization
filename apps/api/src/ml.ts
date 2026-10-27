import { readFileSync } from 'node:fs';
import type { Priority } from '@dispatch/shared';

/**
 * The Phase 5 models, trained by ml/train.py and stored as plain numbers in
 * ml/models/*.json. They are tiny on purpose (a line, a logistic regression,
 * a table of shares), so using them on the dispatch hot path costs
 * microseconds. See ml/report.md for how each was evaluated.
 */

const MODELS = new URL('../../../ml/models/', import.meta.url);
const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`${name}.json`, MODELS), 'utf8')) as T;

interface EtaModel {
  interceptS: number;
  secondsPerMeter: number;
}
interface AcceptanceModel {
  features: string[];
  mean: number[];
  std: number[];
  weights: number[];
  intercept: number;
}
interface DemandModel {
  share: number[];
}

let models: { eta: EtaModel; acceptance: AcceptanceModel; demand: DemandModel } | undefined;

/** Loads the model files; call once at startup when they are needed, so a missing file fails fast. */
export function loadModels() {
  models ??= { eta: load('eta'), acceptance: load('acceptance'), demand: load('demand') };
  return models;
}

/** Learned drive time to pickup from straight-line distance. */
export function predictEtaSeconds(distanceM: number): number {
  const { eta } = loadModels();
  return Math.max(0, eta.interceptS + eta.secondsPerMeter * distanceM);
}

/**
 * Learned acceptance probability. Inputs mirror ml/train.py accept_features():
 * the smoothed history rate (as log-odds), distance, which attempt this is,
 * and whether the request is urgent.
 */
export function predictAcceptance(input: { smoothedP: number; distanceM: number; attempt: number; priority: Priority }): number {
  const { acceptance: m } = loadModels();
  const p = Math.min(0.99, Math.max(0.01, input.smoothedP));
  const raw = [
    Math.log(p / (1 - p)),
    input.distanceM / 1000,
    input.attempt,
    input.priority === 'high' || input.priority === 'critical' ? 1 : 0,
  ];
  let z = m.intercept;
  raw.forEach((x, i) => (z += m.weights[i]! * ((x - m.mean[i]!) / m.std[i]!)));
  return 1 / (1 + Math.exp(-z));
}

/** Long-run share of the city's bookings that land in each zone. */
export function demandShares(): number[] {
  return loadModels().demand.share;
}
