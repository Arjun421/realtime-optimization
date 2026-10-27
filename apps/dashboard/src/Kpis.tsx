import type { ReactNode } from 'react';
import { cssColor, type Palette } from './colors';
import { fmtDuration, fmtInt } from './format';
import { Sparkline } from './Sparkline';
import { freeDriverCount, waitingCount, type LiveState } from './useLive';

function Tile({ label, value, sub, children }: { label: string; value: string; sub: string; children?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-sub">{sub}</div>
      {children}
    </div>
  );
}

/** The four numbers a person watching the city cares about, across the top of the map. */
export function Kpis({ live, palette }: { live: LiveState; palette: Palette }) {
  const snap = live.snapshot;
  if (!snap) return null;
  const m = snap.metrics;
  const times = live.history.map((h) => h.at);

  return (
    <div className="kpis">
      <Tile label="Free drivers" value={fmtInt(freeDriverCount(snap))} sub={`of ${fmtInt(snap.agents.ids.length)} · ready for a job`}>
        <Sparkline
          values={live.history.map((h) => h.freeDrivers)}
          times={times}
          color={cssColor(palette.free)}
          label="Free drivers over the last 5 minutes"
          format={fmtInt}
        />
      </Tile>
      <Tile label="Customers waiting" value={fmtInt(waitingCount(snap))} sub="no driver has accepted yet">
        <Sparkline
          values={live.history.map((h) => h.waiting)}
          times={times}
          color={cssColor(palette.waiting)}
          label="Customers waiting over the last 5 minutes"
          format={fmtInt}
        />
      </Tile>
      <Tile
        label="Time to get a driver"
        value={fmtDuration(m.timeToAssignMs.p50)}
        sub={`typical · 95% within ${fmtDuration(m.timeToAssignMs.p95)}`}
      />
      <Tile
        label="Time until pickup"
        value={fmtDuration(m.waitToPickupMs.p50)}
        sub={`typical · 95% within ${fmtDuration(m.waitToPickupMs.p95)}`}
      />
    </div>
  );
}
