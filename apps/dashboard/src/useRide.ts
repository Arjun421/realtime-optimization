import type { Priority, RequestState } from '@dispatch/shared';
import { useEffect, useState } from 'react';

/** One booking as GET /requests/:id returns it. */
export interface Ride {
  id: string;
  state: RequestState;
  lat: number;
  lng: number;
  priority: Priority;
  agentId?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

const FINAL = new Set<RequestState>(['COMPLETED', 'UNASSIGNED', 'CANCELLED']);

/**
 * Follows one booking from start to finish by asking the API for it once a
 * second. The live snapshot drops a booking from the map once a driver is on
 * the way, so it can't tell the story of a single ride; this can.
 */
export function useRide(id: string | undefined): Ride | undefined {
  const [ride, setRide] = useState<Ride>();

  useEffect(() => {
    setRide(undefined);
    if (!id) return;
    let stopped = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const res = await fetch(`/requests/${id}`);
        if (res.ok) {
          const r = (await res.json()) as Record<string, string>;
          const next: Ride = {
            id,
            state: r.state as RequestState,
            lat: Number(r.lat),
            lng: Number(r.lng),
            priority: (r.priority ?? 'normal') as Priority,
            agentId: r.agentId || undefined,
            attempts: Number(r.attempts ?? 0),
            createdAt: Number(r.createdAt),
            updatedAt: Number(r.updatedAt),
          };
          if (!stopped) setRide(next);
          if (FINAL.has(next.state)) return; // nothing more will change
        }
      } catch {
        // API restarting: try again next second.
      }
      if (!stopped) timer = window.setTimeout(poll, 1_000);
    };

    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  return ride;
}
