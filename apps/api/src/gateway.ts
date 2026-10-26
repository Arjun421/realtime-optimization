import type { GatewayToServer, LocationPing, ServerToGateway } from '@dispatch/shared';
import { WebSocket, WebSocketServer } from 'ws';

export interface GatewayHandlers {
  onLocations(items: LocationPing[]): Promise<void>;
  onOfferResponse(requestId: string, agentId: string, accept: boolean): Promise<void>;
  onTripUpdate(requestId: string, agentId: string, event: 'picked_up' | 'completed'): Promise<void>;
}

/** Which gateway connection each agent last reported through. */
const agentSockets = new Map<string, WebSocket>();

export function sendToAgent(agentId: string, msg: ServerToGateway): boolean {
  const ws = agentSockets.get(agentId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

export function createGateway(handlers: GatewayHandlers): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    const owned = new Set<string>();

    ws.on('message', async (raw) => {
      let msg: GatewayToServer;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        switch (msg.type) {
          case 'locations':
            for (const p of msg.items) {
              if (agentSockets.get(p.agentId) !== ws) {
                agentSockets.set(p.agentId, ws);
                owned.add(p.agentId);
              }
            }
            await handlers.onLocations(msg.items);
            break;
          case 'offer_response':
            await handlers.onOfferResponse(msg.requestId, msg.agentId, msg.accept);
            break;
          case 'trip_update':
            await handlers.onTripUpdate(msg.requestId, msg.agentId, msg.event);
            break;
        }
      } catch (err) {
        console.error(`[gateway] failed to handle ${msg.type}`, err);
      }
    });

    ws.on('close', () => {
      for (const id of owned) {
        if (agentSockets.get(id) === ws) agentSockets.delete(id);
      }
    });
  });

  return wss;
}
