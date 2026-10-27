// Calm, then a sudden burst (SPIKE req/s for 20 s), then calm again: the
// "concert just ended" case. Watch what the burst does to everyone's latency.
import { createRequest, vus } from './common.js';

const base = Number(__ENV.BASE || 20);
const spike = Number(__ENV.SPIKE || 400);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: base,
      timeUnit: '1s',
      stages: [
        { target: base, duration: '30s' },
        { target: spike, duration: '3s' },
        { target: spike, duration: '20s' },
        { target: base, duration: '3s' },
        { target: base, duration: '40s' },
      ],
      ...vus,
    },
  },
};

export default createRequest;
