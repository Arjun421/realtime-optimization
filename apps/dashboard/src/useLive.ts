import type { LiveSnapshot } from '@dispatch/shared';
import { useEffect, useState } from 'react';

/** Counters turned into per-second rates over this window. */
const RATE_WINDOW_MS = 10_000;
/** Trend charts show this many one-second points (5 minutes). */
const HISTORY_POINTS = 300;
const RATE_COUNTERS = ['requestsCreated', 'requestsAssigned', 'requestsUnassigned', 'requestsCompleted'] as const;
type RateCounter = (typeof RATE_COUNTERS)[number];

export interface HistoryPoint {
  at: number;
  freeDrivers: number;
  waiting: number;
}

export interface LiveState {
  snapshot?: LiveSnapshot;
  connected: boolean;
  /** Size of the last snapshot message. */
  bytes: number;
  rates: Partial<Record<RateCounter, number>>;
  history: HistoryPoint[];
}

/** Customers still waiting for a driver to accept. */
export function waitingCount(s: LiveSnapshot): number {
  const c = s.requestCounts;
  return (c.CREATED ?? 0) + (c.SEARCHING ?? 0) + (c.OFFERED ?? 0);
}

export function freeDriverCount(s: LiveSnapshot): number {
  let n = 0;
  for (const status of s.agents.status) if (status === 0) n++;
  return n;
}

/** Subscribes to WS /live, reconnecting with a short delay if the service restarts. */
export function useLive(): LiveState {
  const [state, setState] = useState<LiveState>({ connected: false, bytes: 0, rates: {}, history: [] });

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: number | undefined;
    let closed = false;
    const counterHistory: { at: number; counters: Record<string, number> }[] = [];
    let history: HistoryPoint[] = [];

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
        counterHistory.push({ at: snapshot.at, counters: snapshot.metrics.counters });
        while (counterHistory.length > 1 && snapshot.at - counterHistory[0]!.at > RATE_WINDOW_MS) counterHistory.shift();

        const rates: LiveState['rates'] = {};
        const first = counterHistory[0]!;
        const dtS = (snapshot.at - first.at) / 1000;
        if (dtS > 0) {
          for (const c of RATE_COUNTERS) {
            rates[c] = ((snapshot.metrics.counters[c] ?? 0) - (first.counters[c] ?? 0)) / dtS;
          }
        }

        history = [...history, { at: snapshot.at, freeDrivers: freeDriverCount(snapshot), waiting: waitingCount(snapshot) }];
        if (history.length > HISTORY_POINTS) history = history.slice(-HISTORY_POINTS);

        setState({ snapshot, connected: true, bytes: ev.data.length, rates, history });
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
