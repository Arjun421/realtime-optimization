// Constant load: RATE requests/s for DURATION.
import { createRequest, vus } from './common.js';

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      ...vus,
    },
  },
};

export default createRequest;
