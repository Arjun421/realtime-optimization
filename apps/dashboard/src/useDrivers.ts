import type { LiveSnapshot } from '@dispatch/shared';
import { useMemo, useRef } from 'react';

/** Status value for a slot whose driver isn't in the latest snapshot. Filtered out on the GPU. */
export const ABSENT = -1;

export interface Drivers {
  /** One entry per slot: the data deck.gl iterates. */
  slots: number[];
  ids: string[];
  lng: Float64Array;
  lat: Float64Array;
  /** Index into AGENT_LIVE_STATUSES, or ABSENT. */
  status: Float32Array;
  slotOf: Map<string, number>;
  /** Changes every snapshot; feeds deck.gl updateTriggers. */
  version: number;
}

/**
 * Gives every driver a permanent slot. Redis returns drivers in a different
 * order each second (sorted by location), but deck.gl's GPU transitions
 * interpolate by position in the data, so a driver must keep the same index
 * from one snapshot to the next for its dot to glide instead of teleporting.
 * With stable slots the animation runs entirely on the GPU: React renders
 * once per snapshot, not once per frame.
 */
export function useDrivers(snap: LiveSnapshot | undefined): Drivers | undefined {
  const state = useRef<{ slotOf: Map<string, number>; ids: string[]; lng: Float64Array; lat: Float64Array }>({
    slotOf: new Map(),
    ids: [],
    lng: new Float64Array(0),
    lat: new Float64Array(0),
  });

  return useMemo(() => {
    if (!snap) return undefined;
    const s = state.current;
    const a = snap.agents;
    for (const id of a.ids) {
      if (!s.slotOf.has(id)) {
        s.slotOf.set(id, s.ids.length);
        s.ids.push(id);
      }
    }

    const n = s.ids.length;
    // Fresh arrays each snapshot (deck.gl diffs by reference); absent drivers keep their last position.
    const lng = new Float64Array(n);
    const lat = new Float64Array(n);
    lng.set(s.lng);
    lat.set(s.lat);
    const status = new Float32Array(n).fill(ABSENT);
    a.ids.forEach((id, i) => {
      const slot = s.slotOf.get(id)!;
      lng[slot] = a.lng[i]!;
      lat[slot] = a.lat[i]!;
      status[slot] = a.status[i]!;
    });
    s.lng = lng;
    s.lat = lat;

    return { slots: Array.from({ length: n }, (_, i) => i), ids: s.ids, lng, lat, status, slotOf: s.slotOf, version: snap.at };
  }, [snap]);
}
