// One-line-per-metric summary of a load run: what k6 saw from outside, and
// what the API measured inside.
import { readFileSync } from 'node:fs';

const base = process.argv[2];
const k6 = JSON.parse(readFileSync(`${base}-k6.json`, 'utf8')).metrics;
const api = JSON.parse(readFileSync(`${base}-api.json`, 'utf8'));
const c = api.counters;
const s = (x) => (x === undefined ? '–' : x);
const lat = (m) => `${s(m.p50)} / ${s(m.p95)} / ${s(m.p99)} (max ${s(m.max)})`;

const http = k6.http_req_duration;
console.log(`
HTTP POST /requests (k6)   p50 ${http.med.toFixed(1)} · p95 ${http['p(95)'].toFixed(1)} · max ${http.max.toFixed(0)} ms · ${k6.http_reqs.count} sent at ${k6.http_reqs.rate.toFixed(0)}/s
Refused with 429           ${(100 * (k6.requests_rejected?.value ?? 0)).toFixed(1)}%   failed (not 201/429): ${(100 * k6.http_req_failed.value).toFixed(2)}%
Queue                      ${api.queue.enabled ? `${api.queue.workers} workers, max ${api.queue.maxDepth}` : 'off'}
Queue wait (ms)            ${lat(api.queueWaitMs)}
Dispatch decision (ms)     ${lat(api.dispatchDecisionMs)}
Request → first offer (ms) ${lat(api.timeToFirstOfferMs)}
Created ${c.requestsCreated} · refused ${c.requestsRejected} · offers ${c.offersSent} · assigned ${c.requestsAssigned} · unassigned ${c.requestsUnassigned} · claim conflicts ${c.claimConflicts}
`);
