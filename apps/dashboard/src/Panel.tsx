import { AGENT_LIVE_STATUSES, zoneLabel, type LatencySummary, type LiveSnapshot, type Priority } from '@dispatch/shared';
import { useState, type ReactNode } from 'react';
import { cssColor, type Palette, type RGBA, type Theme } from './colors';
import { fmtDistance, fmtDuration, fmtInt, REQUEST_STATE_TEXT } from './format';
import { RideTracker } from './RideTracker';
import type { LiveState } from './useLive';
import type { Ride } from './useRide';

export type Selection = { kind: 'request' | 'agent'; id: string };
type Tab = 'overview' | 'alerts' | 'system';

interface Props {
  live: LiveState;
  palette: Palette;
  theme: Theme;
  onTheme(t: Theme): void;
  onHelp(): void;
  selection?: Selection;
  /** The followed booking, when the selection is a booking. */
  ride?: Ride;
  rideDriverDistanceM?: number;
  onClearSelection(): void;
  priority: Priority;
  onPriority(p: Priority): void;
  clickToCreate: boolean;
  onClickToCreate(on: boolean): void;
  onZone(zone: number): void;
}

const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'critical'];
const AGENT_STATUS_TEXT = { AVAILABLE: 'Free', OFFERED: 'Deciding on an offer', BUSY: 'Busy on a trip', STALE: 'GPS lost' } as const;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

function Row({ label, value, color, hint }: { label: string; value: ReactNode; color?: RGBA; hint?: string }) {
  return (
    <div className="row" title={hint}>
      <span className="label">
        {color && <i className="swatch" style={{ background: cssColor(color) }} />}
        {label}
        {hint && <span className="info" aria-hidden>ⓘ</span>}
      </span>
      <span className="value">{value}</span>
    </div>
  );
}

const ms = (n: number | undefined) => (n === undefined ? '–' : n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US'));

function LatencyRow({ label, s, hint }: { label: string; s: LatencySummary; hint: string }) {
  return (
    <tr title={hint}>
      <th scope="row">{label}</th>
      <td>{ms(s.p50)}</td>
      <td>{ms(s.p95)}</td>
      <td>{ms(s.p99)}</td>
    </tr>
  );
}

function Selected({ snap, selection, palette: p, onClear }: { snap: LiveSnapshot; selection: Selection; palette: Palette; onClear(): void }) {
  let title: string;
  let body: ReactNode;
  if (selection.kind === 'request') {
    title = 'Selected customer';
    const r = snap.requests.find((x) => x.id === selection.id);
    body = r ? (
      <>
        <p className="selected-state">{REQUEST_STATE_TEXT[r.state]}</p>
        <Row label="Waiting for" value={fmtDuration(snap.at - r.createdAt)} />
        <Row label="Drivers asked so far" value={r.attempts} hint="Each 'no' or ignored offer moves on to the next best driver." />
        <Row label="Priority" value={r.priority} />
        {r.agentId && <Row label="Driver" value={r.agentId} />}
      </>
    ) : (
      <p className="muted">This customer is in the car or finished, so they're no longer drawn.</p>
    );
  } else {
    title = `Selected driver · ${selection.id}`;
    const i = snap.agents.ids.indexOf(selection.id);
    const status = i >= 0 ? AGENT_LIVE_STATUSES[snap.agents.status[i]!]! : undefined;
    const colors = { AVAILABLE: p.free, OFFERED: p.offered, BUSY: p.busy, STALE: p.noGps };
    body = status ? (
      <Row label="Status" value={AGENT_STATUS_TEXT[status]} color={colors[status]} />
    ) : (
      <p className="muted">This driver went offline.</p>
    );
  }
  return (
    <section className="selected">
      <h2>{title}</h2>
      {body}
      <button className="link" onClick={onClear}>Stop following</button>
    </section>
  );
}

function Overview({ props, snap }: { props: Props; snap: LiveSnapshot }) {
  const { live, palette: p } = props;
  const m = snap.metrics;
  const c = m.counters;
  const counts = AGENT_LIVE_STATUSES.map(() => 0);
  snap.agents.status.forEach((s) => counts[s]!++);
  const rc = snap.requestCounts;
  const answered = (c.offersAccepted ?? 0) + (c.offersRejected ?? 0) + (c.offersTimedOut ?? 0);
  const rate = (n: number | undefined) => (n === undefined ? '–' : `${n.toFixed(1)} per second`);

  return (
    <>
      {props.selection?.kind === 'agent' && <Selected snap={snap} selection={props.selection} palette={p} onClear={props.onClearSelection} />}

      <Section title="Drivers right now">
        <Row label="Free" value={fmtInt(counts[0]!)} color={p.free} />
        <Row label="Deciding on an offer" value={fmtInt(counts[1]!)} color={p.offered} />
        <Row label="Busy on a trip" value={fmtInt(counts[2]!)} color={p.busy} />
        <Row label="GPS lost" value={fmtInt(counts[3]!)} color={p.noGps} hint="No location for 15 s. They get no jobs until it comes back." />
      </Section>

      <Section title="Customers right now">
        <Row label="Waiting for a driver" value={fmtInt((rc.CREATED ?? 0) + (rc.SEARCHING ?? 0) + (rc.OFFERED ?? 0))} color={p.waiting} />
        <Row label="Driver on the way" value={fmtInt(rc.ASSIGNED ?? 0)} color={p.matched} />
        <Row label="In the car" value={fmtInt(rc.PICKED_UP ?? 0)} />
        <Row label="No driver found (last 5 s)" value={fmtInt(rc.UNASSIGNED ?? 0)} />
      </Section>

      <Section title="Last 10 seconds">
        <Row label="New bookings" value={rate(live.rates.requestsCreated)} />
        <Row label="Matched with a driver" value={rate(live.rates.requestsAssigned)} />
        <Row label="No driver found" value={rate(live.rates.requestsUnassigned)} />
        <Row label="Trips finished" value={rate(live.rates.requestsCompleted)} />
      </Section>

      <Section title="How customers are doing">
        <Row
          label="Drivers say yes"
          value={answered ? `${Math.round((100 * (c.offersAccepted ?? 0)) / answered)}% of offers` : '–'}
          hint="Share of offers accepted. The rest were turned down or ignored, and the next driver was asked."
        />
        <Row label="Typical driver distance" value={fmtDistance(m.assignedDistanceM.p50)} hint="Straight-line distance from the driver who accepted to the customer (median)." />
        <Row
          label="Choosing a driver"
          value={{ smart: 'Smart ranking', ml: 'Smart ranking + ML models', nearest: 'Nearest driver' }[m.strategy]}
          hint="Smart ranking weighs distance, how often a driver accepts, and not emptying busy areas. ML mode uses learned pickup-time, acceptance and demand models for those inputs."
        />
      </Section>

      <Section title="Try it" hint="Click an empty spot on the map to book a ride there, then watch it get a driver.">
        <label className="switch">
          <input type="checkbox" checked={props.clickToCreate} onChange={(e) => props.onClickToCreate(e.target.checked)} />
          Click the map to book a ride
        </label>
        <div className="priorities" role="group" aria-label="Priority of new bookings">
          {PRIORITIES.map((pr) => (
            <button key={pr} className={pr === props.priority ? 'active' : ''} onClick={() => props.onPriority(pr)}>
              {pr}
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}

function Alerts({ props, snap }: { props: Props; snap: LiveSnapshot }) {
  const c = snap.metrics.counters;
  return (
    <>
      <Section
        title={`Areas short of drivers · ${snap.alerts.length}`}
        hint="Free drivers within ~2 km cover less than half the bookings expected here in the next 5 minutes, for at least 10 seconds. Click one to see it."
      >
        {snap.alerts.length === 0 && <p className="muted">All areas have enough free drivers.</p>}
        {snap.alerts.map((a) => (
          <button key={a.zone} className={`alert ${a.severity}`} onClick={() => props.onZone(a.zone)}>
            <span className="alert-badge">{a.severity === 'critical' ? '⛔ Critical' : '⚠ Warning'}</span>
            <span className="alert-text">
              {a.supply === 0 ? 'No free drivers nearby' : `${a.supply} free driver${a.supply === 1 ? '' : 's'} nearby`}, about{' '}
              {Math.round(a.expectedDemand)} bookings expected
            </span>
            <span className="alert-meta">
              {zoneLabel(a.zone)} · for {fmtDuration(snap.at - a.since)}
            </span>
          </button>
        ))}
      </Section>

      <Section
        title="Bad GPS readings blocked"
        hint="A phone reported a jump that would mean driving faster than 200 km/h. The reading is ignored so the driver isn't sent to the wrong place."
      >
        <Row label="Blocked so far" value={fmtInt(c.pingsImpossible ?? 0)} />
        <Row label="Real moves accepted" value={fmtInt(c.agentsReanchored ?? 0)} hint="Three readings in a row agreed on the new spot, so the driver really did move." />
        {snap.anomalies.slice(0, 5).map((a) => (
          <div key={`${a.agentId}-${a.at}`} className="row small">
            <span>{a.agentId}</span>
            <span className="muted">
              {fmtInt(a.speedKmh)} km/h · {a.reanchored ? 'accepted' : 'blocked'}
            </span>
          </div>
        ))}
      </Section>
    </>
  );
}

function System({ props, snap }: { props: Props; snap: LiveSnapshot }) {
  const m = snap.metrics;
  return (
    <>
      <Section title="Response times (milliseconds)" hint="p50 = half of cases are faster, p95 / p99 = the slow end.">
        <table className="latency">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">p50</th>
              <th scope="col">p95</th>
              <th scope="col">p99</th>
            </tr>
          </thead>
          <tbody>
            <LatencyRow label="Pick a driver" s={m.dispatchDecisionMs} hint="Search nearby drivers, rank them and lock the best one." />
            <LatencyRow label="Booking → first offer" s={m.timeToFirstOfferMs} hint="Includes time waiting in the queue." />
            <LatencyRow label="Waiting in queue" s={m.queueWaitMs} hint="Time before a worker started on the booking." />
            <LatencyRow label="Build this screen" s={m.snapshotBuildMs} hint="Live service reading all state from Redis once a second." />
          </tbody>
        </table>
      </Section>

      <Section title={m.queue.enabled ? `Request queue · ${m.queue.workers} workers` : 'Request queue · off'}>
        <Row label="Waiting in queue" value={`${fmtInt(m.queue.depth)} of ${fmtInt(m.queue.maxDepth)}`} />
        <Row label="Turned away (busy, try again)" value={fmtInt(m.counters.requestsRejected ?? 0)} hint="HTTP 429: the queue was full, so the booking was refused quickly instead of everyone slowing down." />
      </Section>

      <Section title="This screen">
        <Row label="Update size" value={`${Math.round(props.live.bytes / 1024)} KB per second`} />
        <Row label="Drivers tracked" value={fmtInt(snap.agents.ids.length)} />
      </Section>
    </>
  );
}

export function Panel(props: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const { live } = props;
  const snap = live.snapshot;

  return (
    <aside className="panel">
      <header className="panel-header">
        <div>
          <h1>Delhi dispatch</h1>
          <div className="status">
            <i className={`dot ${live.connected ? 'on' : 'off'}`} />
            {live.connected ? 'Live' : 'Reconnecting…'}
          </div>
        </div>
        <div className="header-actions">
          <button
            className="icon-btn"
            onClick={() => props.onTheme(props.theme === 'light' ? 'dark' : 'light')}
            aria-label={`Switch to ${props.theme === 'light' ? 'dark' : 'light'} theme`}
            title="Light / dark"
          >
            {props.theme === 'light' ? '☾' : '☀'}
          </button>
          <button className="icon-btn" onClick={props.onHelp} aria-label="How to read this dashboard" title="How to read this">
            ?
          </button>
        </div>
      </header>

      {props.selection?.kind === 'request' && (
        <div className="ride-wrap">
          <RideTracker
            ride={props.ride}
            driverDistanceM={props.rideDriverDistanceM}
            now={snap?.at ?? Date.now()}
            onClose={props.onClearSelection}
          />
        </div>
      )}

      <nav className="tabs" role="tablist">
        {(['overview', 'alerts', 'system'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'overview' ? 'Overview' : t === 'alerts' ? `Alerts${snap?.alerts.length ? ` · ${snap.alerts.length}` : ''}` : 'System'}
          </button>
        ))}
      </nav>

      <div className="panel-body">
        {!snap && <p className="muted">Waiting for live data. Is the live service running? (npm run dev)</p>}
        {snap && tab === 'overview' && <Overview props={props} snap={snap} />}
        {snap && tab === 'alerts' && <Alerts props={props} snap={snap} />}
        {snap && tab === 'system' && <System props={props} snap={snap} />}
      </div>
    </aside>
  );
}
