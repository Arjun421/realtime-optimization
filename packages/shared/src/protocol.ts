import type { LatLng } from './geo.js';

/**
 * WebSocket protocol between the agent gateway (the simulator, or a real
 * driver-app gateway) and the API. One connection multiplexes many agents so
 * that 10k simulated agents don't need 10k sockets.
 */

export interface LocationPing {
  agentId: string;
  lat: number;
  lng: number;
  /** Device timestamp, epoch ms. */
  ts: number;
}

export type GatewayToServer =
  | { type: 'locations'; items: LocationPing[] }
  | { type: 'offer_response'; requestId: string; agentId: string; accept: boolean }
  | { type: 'trip_update'; requestId: string; agentId: string; event: 'picked_up' | 'completed' };

export type ServerToGateway =
  | { type: 'offer'; requestId: string; agentId: string; pickup: LatLng; expiresAt: number }
  | { type: 'offer_revoked'; requestId: string; agentId: string }
  | { type: 'assigned'; requestId: string; agentId: string; pickup: LatLng };
