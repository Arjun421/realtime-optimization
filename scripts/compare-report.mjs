// Prints a markdown table comparing the strategy runs saved by compare-strategies.sh.
import { readFileSync } from 'node:fs';

const [dir, ...strategies] = process.argv.slice(2);
const runs = strategies.map((s) => ({ s, m: JSON.parse(readFileSync(`${dir}/${s}.json`, 'utf8')) }));

const sec = (ms) => (ms === undefined ? '–' : (ms / 1000).toFixed(1));
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '–');

const rows = [
  ['Requests created', (m) => m.counters.requestsCreated],
  ['Offers per assigned request', (m) => (m.counters.offersSent / m.counters.requestsAssigned).toFixed(2)],
  ['Offers accepted', (m) => {
    const c = m.counters;
    return pct(c.offersAccepted, c.offersAccepted + c.offersRejected + c.offersTimedOut);
  }],
  ['Unassigned', (m) => pct(m.counters.requestsUnassigned, m.counters.requestsCreated)],
  ['Time to assign p50 / p95 (s)', (m) => `${sec(m.timeToAssignMs.p50)} / ${sec(m.timeToAssignMs.p95)}`],
  ['Wait to pickup p50 / p95 (s)', (m) => `${sec(m.waitToPickupMs.p50)} / ${sec(m.waitToPickupMs.p95)}`],
  ['Pickup distance p50 / p95 (m)', (m) => `${Math.round(m.assignedDistanceM.p50 ?? 0)} / ${Math.round(m.assignedDistanceM.p95 ?? 0)}`],
  ['Dispatch decision p50 / p99 (ms)', (m) => `${m.dispatchDecisionMs.p50} / ${m.dispatchDecisionMs.p99}`],
];

console.log(`| | ${runs.map((r) => r.s).join(' | ')} |`);
console.log(`|---|${runs.map(() => '---').join('|')}|`);
for (const [label, f] of rows) console.log(`| ${label} | ${runs.map((r) => f(r.m)).join(' | ')} |`);
