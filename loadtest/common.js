// Shared by every k6 scenario: what one request looks like and how results are judged.
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

export const API = __ENV.API_URL || 'http://localhost:4000';

/** Same busy areas the simulator uses, so load lands where agents are. */
const HOTSPOTS = [
  [28.6315, 77.2167], [28.495, 77.089], [28.57, 77.321], [28.5245, 77.2066],
  [28.6519, 77.1909], [28.5921, 77.046], [28.7495, 77.0565],
];

const accepted = new Counter('requests_accepted');
const rejected = new Rate('requests_rejected');

// 429 is the system working as designed (shedding load), not an error.
http.setResponseCallback(http.expectedStatuses(201, 429));

export function createRequest() {
  const [lat, lng] = HOTSPOTS[Math.floor(Math.random() * HOTSPOTS.length)];
  const body = JSON.stringify({
    lat: lat + (Math.random() - 0.5) * 0.06,
    lng: lng + (Math.random() - 0.5) * 0.06,
    priority: Math.random() < 0.05 ? 'high' : 'normal',
  });
  const res = http.post(`${API}/requests`, body, { headers: { 'content-type': 'application/json' } });
  rejected.add(res.status === 429);
  if (res.status === 201) accepted.add(1);
}

export const vus = { preAllocatedVUs: 200, maxVUs: 3000 };
