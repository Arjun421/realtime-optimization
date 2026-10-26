import {
  AGENT_LIVE_STATUSES,
  zoneLabel,
  type LatencySummary,
  type LiveSnapshot,
  type Priority,
  type RequestState,
} from '@dispatch/shared';
import type { ReactNode } from 'react';
import { AGENT_COLORS, REQUEST_COLORS, cssColor, type RGBA } from './colors';
import type { LiveState } from './useLive';

export interface Layers {
  agents: boolean;
  requests: boolean;
  links: boolean;
  zones: boolean;
}

export type Selection = { kind: 'request' | 'agent'; id: string };

interface Props {
  live: LiveState;
  layers: Layers;
  onLayers(layers: Layers): void;
  selection?: Selection;
  onClearSelection(): void;
  priority: Priority;
  onPriority(p: Priority): void;
  clickToCreate: boolean;
  onClickToCreate(on: boolean): void;
  onZone(zone: number): void;
}

const SHOWN_REQUEST_STATES: RequestState[] = ['SEARCHING', 'OFFERED', 'ASSIGNED', 'PICKED_UP', 'UNASSIGNED', 'COMPLETED'];
const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'critical'];

const fmt = (n: number | undefined, digits = 1) => (n === undefined ? '–' : n.toFixed(digits));
const fmtInt = (n: number) => n.toLocaleString('en-US');

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value, color }: { label: string; value: ReactNode; color?: RGBA }) {
  return (
    <div className="row">
      <span className="label">
        {color && <i className="swatch" style={{ background: cssColor(color) }} />}
        {label}
      </span>
      <span className="value">{value}</span>
    </div>
  );
}

function Latency({ label, s }: { label: string; s: LatencySummary }) {
  return (
    <div className="latency">
      <span className="label">{label}</span>
      <span className="value">
        {fmt(s.p50)} / {fmt(s.p95)} / {fmt(s.p99)} <small>ms</small>
      </span>
    </div>
  );
}

function SelectionDetails({ snap, selection, onClear }: { snap: LiveSnapshot; selection: Selection; onClear(): void }) {
  let body: ReactNode;
  if (selection.kind === 'request') {
    const r = snap.requests.find((x) => x.id === selection.id);
    body = r ? (
      <>
        <Row label="State" value={r.state} color={REQUEST_COLORS[r.state]} />
        <Row label="Priority" value={r.priority} />
        <Row label="Offers made" value={r.attempts} />
        <Row label="Agent" value={r.agentId ?? '–'} />
        <Row label="Age" value={`${((snap.at - r.createdAt) / 1000).toFixed(1)} s`} />
      </>
    ) : (
      <p className="muted">No longer on the map (finished more than 5 s ago).</p>
    );
  } else {
    const i = snap.agents.ids.indexOf(selection.id);
    const status = i >= 0 ? AGENT_LIVE_STATUSES[snap.agents.status[i]!]! : undefined;
    const trip = snap.requests.find((r) => r.agentId === selection.id && r.state !== 'COMPLETED');
    body = status ? (
      <>
        <Row label="Status" value={status} color={AGENT_COLORS[status]} />
        <Row label="Position" value={`${snap.agents.lat[i]!.toFixed(4)}, ${snap.agents.lng[i]!.toFixed(4)}`} />
        <Row label="Request" value={trip ? trip.state : status === 'BUSY' ? 'PICKED_UP' : '–'} />
      </>
    ) : (
      <p className="muted">Agent no longer tracked.</p>
    );
  }
  return (
    <Section title={selection.kind === 'request' ? 'Selected request' : `Selected ${selection.id}`}>
      {body}
      <button className="link" onClick={onClear}>
        Clear selection
      </button>
    </Section>
  );
}

export function Panel(props: Props) {
  const { live, layers } = props;
  const snap = live.snapshot;

  const agentCounts = AGENT_LIVE_STATUSES.map(() => 0);
  snap?.agents.status.forEach((s) => agentCounts[s]!++);

  const counts = snap?.requestCounts ?? {};
  const requestCounts = { ...counts, SEARCHING: (counts.SEARCHING ?? 0) + (counts.CREATED ?? 0) };

  const shortages = (snap?.zones ?? [])
    .filter((z) => z.demand > z.supply)
    .sort((a, b) => b.demand - b.supply - (a.demand - a.supply))
    .slice(0, 6);

  const m = snap?.metrics;

  return (
    <aside className="panel">
      <header>
        <h1>Dispatch Live</h1>
        <div className="status">
          <i className={`dot ${live.connected ? 'on' : 'off'}`} />
          {live.connected ? 'Connected' : 'Reconnecting…'}
          {snap && (
            <span className="muted">
              {' '}
              · {(live.bytes / 1024).toFixed(0)} KB · built in {snap.buildMs.toFixed(1)} ms
            </span>
          )}
        </div>
      </header>

      {!snap && <p className="muted">Waiting for the first snapshot. Is the API running on :4000?</p>}

      {snap && m && (
        <>
          <Section title={`Fleet · ${fmtInt(snap.agents.ids.length)} agents`}>
            {AGENT_LIVE_STATUSES.map((s, i) => (
              <Row key={s} label={s.toLowerCase()} value={fmtInt(agentCounts[i]!)} color={AGENT_COLORS[s]} />
            ))}
            <Row
              label="Median GPS age"
              value={m.fleet.medianFreshnessMs === null ? '–' : `${(m.fleet.medianFreshnessMs / 1000).toFixed(1)} s`}
            />
          </Section>

          <Section title="Requests">
            {SHOWN_REQUEST_STATES.map((s) => (
              <Row key={s} label={s.toLowerCase().replace('_', ' ')} value={requestCounts[s] ?? 0} color={REQUEST_COLORS[s]} />
            ))}
          </Section>

          <Section title="Throughput (last 10 s)">
            <Row label="Created" value={`${fmt(live.rates.requestsCreated)} /s`} />
            <Row label="Assigned" value={`${fmt(live.rates.requestsAssigned)} /s`} />
            <Row label="Unassigned" value={`${fmt(live.rates.requestsUnassigned)} /s`} />
            <Row label="Completed" value={`${fmt(live.rates.requestsCompleted)} /s`} />
          </Section>

          <Section title="Latency p50 / p95 / p99">
            <Latency label="Dispatch decision" s={m.dispatchDecisionMs} />
            <Latency label="Request → first offer" s={m.timeToFirstOfferMs} />
            <Latency label="Snapshot build" s={m.snapshotBuildMs} />
          </Section>

          {props.selection && (
            <SelectionDetails snap={snap} selection={props.selection} onClear={props.onClearSelection} />
          )}

          <Section title="Zones short of agents">
            {shortages.length === 0 && <p className="muted">Every zone has enough free agents.</p>}
            {shortages.map((z) => (
              <button key={z.zone} className="zone" onClick={() => props.onZone(z.zone)}>
                <span>{zoneLabel(z.zone)}</span>
                <span className="muted">
                  {z.demand} waiting · {z.supply} free
                </span>
              </button>
            ))}
          </Section>
        </>
      )}

      <Section title="Controls">
        <div className="toggles">
          {(Object.keys(layers) as (keyof Layers)[]).map((k) => (
            <label key={k}>
              <input type="checkbox" checked={layers[k]} onChange={(e) => props.onLayers({ ...layers, [k]: e.target.checked })} />
              {k}
            </label>
          ))}
        </div>
        <label className="create">
          <input type="checkbox" checked={props.clickToCreate} onChange={(e) => props.onClickToCreate(e.target.checked)} />
          Click map to create a request
        </label>
        <div className="priorities">
          {PRIORITIES.map((p) => (
            <button key={p} className={p === props.priority ? 'active' : ''} onClick={() => props.onPriority(p)}>
              {p}
            </button>
          ))}
        </div>
      </Section>
    </aside>
  );
}
