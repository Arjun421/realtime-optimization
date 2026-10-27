// Raise the rate until the system can't keep up. The run stops itself once
// requests start failing or HTTP latency degrades, and the rate reached at
// that point is the capacity on this machine.
import { createRequest, vus } from './common.js';

export const options = {
  scenarios: {
    breakpoint: {
      executor: 'ramping-arrival-rate',
      startRate: 50,
      timeUnit: '1s',
      stages: [{ target: Number(__ENV.MAX_RATE || 3000), duration: __ENV.DURATION || '3m' }],
      ...vus,
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '5s' }],
    http_req_duration: [{ threshold: 'p(95)<500', abortOnFail: true, delayAbortEval: '10s' }],
  },
};

export default createRequest;
