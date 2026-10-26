import type { LiveSnapshot } from '@dispatch/shared';
import { useEffect, useState } from 'react';

/** Counters turned into per-second rates over this window. */
const RATE_WINDOW_MS = 10_000;
const RATE_COUNTERS = ['requestsCreated', 'requestsAssigned', 'requestsUnassigned', 'requestsCompleted'] as const;
type RateCounter = (typeof RATE_COUNTERS)[number];

export interface LiveState {
  snapshot?: LiveSnapshot;
  connected: boolean;
  /** Size of the last snapshot message. */
  bytes: number;
  rates: Partial<Record<RateCounter, number>>;
}

/** Subscribes to WS /live, reconnecting with a short delay if the API restarts. */
export function useLive(): LiveState {
  const [state, setState] = useState<LiveState>({ connected: false, bytes: 0, rates: {} });

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: number | undefined;
    let closed = false;
    const history: { at: number; counters: Record<string, number> }[] = [];

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/live`);
      ws.onopen = () => setState((s) => ({ ...s, connected: true }));
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed) retry = window.setTimeout(connect, 1_000);
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        const snapshot = JSON.parse(ev.data) as LiveSnapshot;
        history.push({ at: snapshot.at, counters: snapshot.metrics.counters });
        while (history.length > 1 && snapshot.at - history[0]!.at > RATE_WINDOW_MS) history.shift();

        const rates: LiveState['rates'] = {};
        const first = history[0]!;
        const dtS = (snapshot.at - first.at) / 1000;
        if (dtS > 0) {
          for (const c of RATE_COUNTERS) {
            rates[c] = ((snapshot.metrics.counters[c] ?? 0) - (first.counters[c] ?? 0)) / dtS;
          }
        }
        setState({ snapshot, connected: true, bytes: ev.data.length, rates });
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return state;
}
