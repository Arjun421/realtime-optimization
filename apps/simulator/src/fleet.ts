import {
  bearingRad,
  haversineMeters,
  offsetMeters,
  type GatewayToServer,
  type LatLng,
  type LocationPing,
  type ServerToGateway,
} from '@dispatch/shared';
import { config } from './config.js';
import { between, clampToCity, demandPoint, isInCity, uniformPoint } from './random.js';

type Mode = 'idle' | 'offered' | 'to_pickup' | 'to_dropoff';

interface SimAgent {
  id: string;
  pos: LatLng;
  heading: number;
  speedMps: number;
  /** How likely this agent is to accept an offer. Varies per agent on purpose. */
  acceptRate: number;
  mode: Mode;
  requestId?: string;
  target?: LatLng;
  nextPingAt: number;
  /** GPS dropout: no pings until this time. */
  darkUntil: number;
}

export const stats = {
  glitches: 0,
  offersReceived: 0,
  accepted: 0,
  rejected: 0,
  ignored: 0,
  revoked: 0,
  pickups: 0,
  completed: 0,
};

const CITY_CENTER: LatLng = { lat: 28.6139, lng: 77.209 };
const ARRIVED_M = 30;

export class Fleet {
  private agents = new Map<string, SimAgent>();

  constructor(
    count: number,
    private send: (msg: GatewayToServer) => void,
  ) {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const id = `agent-${String(i).padStart(5, '0')}`;
      this.agents.set(id, {
        id,
        pos: Math.random() < 0.7 ? demandPoint(0) : uniformPoint(),
        heading: between(0, 2 * Math.PI),
        speedMps: between(4, 10),
        acceptRate: between(0.5, 0.95),
        mode: 'idle',
        // Spread first pings over one interval so they don't all land at once.
        nextPingAt: now + Math.random() * config.pingIntervalMs,
        darkUntil: 0,
      });
    }
  }

  /** Advance every agent by `dtMs` and send one batched location message. */
  tick(dtMs: number) {
    const now = Date.now();
    const pings: LocationPing[] = [];

    for (const a of this.agents.values()) {
      this.move(a, dtMs / 1000);

      if (a.darkUntil < now && Math.random() < config.darkRatePerTick) {
        a.darkUntil = now + between(20_000, 60_000);
      }
      if (now >= a.nextPingAt && now >= a.darkUntil) {
        // The agent doesn't move; only this one reported fix is wrong.
        let reported = a.pos;
        if (Math.random() < config.gpsGlitchRate) {
          stats.glitches++;
          reported = offsetMeters(a.pos, between(3_000, 20_000), between(0, 2 * Math.PI));
        }
        pings.push({ agentId: a.id, lat: reported.lat, lng: reported.lng, ts: now });
        a.nextPingAt = now + config.pingIntervalMs * between(0.8, 1.2);
      }
    }

    if (pings.length) this.send({ type: 'locations', items: pings });
  }

  private move(a: SimAgent, dtS: number) {
    if (a.target) {
      const remaining = haversineMeters(a.pos, a.target);
      const step = a.speedMps * dtS;
      if (remaining <= Math.max(step, ARRIVED_M)) {
        a.pos = a.target;
        this.arrive(a);
      } else {
        a.pos = offsetMeters(a.pos, step, bearingRad(a.pos, a.target));
      }
      return;
    }

    // Idle: wander, drifting heading, turning back toward the centre at the city edge.
    a.heading += between(-0.3, 0.3);
    const next = offsetMeters(a.pos, a.speedMps * dtS, a.heading);
    if (isInCity(next)) a.pos = next;
    else a.heading = bearingRad(a.pos, CITY_CENTER);
  }

  private arrive(a: SimAgent) {
    if (a.mode === 'to_pickup' && a.requestId) {
      stats.pickups++;
      this.send({ type: 'trip_update', requestId: a.requestId, agentId: a.id, event: 'picked_up' });
      a.mode = 'to_dropoff';
      a.target = clampToCity(offsetMeters(a.pos, between(2_000, 8_000), between(0, 2 * Math.PI)));
    } else if (a.mode === 'to_dropoff' && a.requestId) {
      stats.completed++;
      this.send({ type: 'trip_update', requestId: a.requestId, agentId: a.id, event: 'completed' });
      this.goIdle(a);
    } else {
      a.target = undefined;
    }
  }

  private goIdle(a: SimAgent) {
    a.mode = 'idle';
    a.requestId = undefined;
    a.target = undefined;
    a.speedMps = between(4, 10);
  }

  handle(msg: ServerToGateway) {
    const a = this.agents.get(msg.agentId);
    if (!a) return;

    switch (msg.type) {
      case 'offer': {
        stats.offersReceived++;
        // Phone offline or already busy: the offer goes unanswered and times out.
        if (Date.now() < a.darkUntil || a.mode !== 'idle') {
          stats.ignored++;
          return;
        }
        if (Math.random() < config.ignoreOfferRate) {
          stats.ignored++;
          return;
        }
        a.mode = 'offered';
        a.requestId = msg.requestId;
        const accept = Math.random() < a.acceptRate;
        // Humans take a moment to decide.
        setTimeout(() => {
          if (a.mode !== 'offered' || a.requestId !== msg.requestId) return;
          if (accept) stats.accepted++;
          else {
            stats.rejected++;
            this.goIdle(a);
          }
          this.send({ type: 'offer_response', requestId: msg.requestId, agentId: a.id, accept });
        }, between(500, 4_000));
        return;
      }
      case 'assigned':
        if (a.requestId !== msg.requestId) return;
        a.mode = 'to_pickup';
        a.target = msg.pickup;
        a.speedMps = between(8, 14);
        return;
      case 'offer_revoked':
        if (a.requestId === msg.requestId) {
          stats.revoked++;
          this.goIdle(a);
        }
        return;
    }
  }

  modeCounts() {
    const now = Date.now();
    const counts = { idle: 0, offered: 0, to_pickup: 0, to_dropoff: 0, dark: 0 };
    for (const a of this.agents.values()) {
      counts[a.mode]++;
      if (now < a.darkUntil) counts.dark++;
    }
    return counts;
  }
}
