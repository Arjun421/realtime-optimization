import { FlyToInterpolator, type MapViewState, type PickingInfo } from '@deck.gl/core';
import { DataFilterExtension, type DataFilterExtensionProps } from '@deck.gl/extensions';
import { LineLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import DeckGL from '@deck.gl/react';
import {
  zoneCenter,
  zonePolygon,
  type GpsAnomaly,
  type LiveRequest,
  type LiveZone,
  type Priority,
  type ZoneAlert,
} from '@dispatch/shared';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useMemo, useState } from 'react';
import { Map as BaseMap } from 'react-map-gl/maplibre';
import { PALETTES, zoneColor, type RGBA, type Theme } from './colors';
import { fmtDuration, fmtInt, REQUEST_STATE_TEXT } from './format';
import { Help } from './Help';
import { Kpis } from './Kpis';
import { Legend, type Layers } from './Legend';
import { Panel, type Selection } from './Panel';
import { useDrivers } from './useDrivers';
import { useLive } from './useLive';

/** The whole simulated city, nudged north so the stat tiles don't cover its top edge. */
const INITIAL_VIEW: MapViewState = { longitude: 77.095, latitude: 28.665, zoom: 10.3, pitch: 0, bearing: 0 };

const WAITING = new Set(['CREATED', 'SEARCHING', 'OFFERED']);
/** GPS jumps stay on the map this long. */
const JUMP_VISIBLE_MS = 60_000;
const THEME_KEY = 'dispatch-theme';
/** Dots glide to each new position over the gap between snapshots, on the GPU. */
const GLIDE = { getPosition: { duration: 1_000 } };
const FILTER = [new DataFilterExtension({ filterSize: 1 })];

const isUrgent = (r: LiveRequest) => r.priority === 'high' || r.priority === 'critical';
/** Same order as AGENT_LIVE_STATUSES. */
const AGENT_TEXT = ['Free', 'Deciding on an offer', 'Busy on a trip', 'GPS lost'] as const;

/** ?theme=dark in the URL wins (handy for sharing a link), then the remembered choice. */
function loadTheme(): Theme {
  const fromUrl = new URLSearchParams(location.search).get('theme');
  if (fromUrl === 'dark' || fromUrl === 'light') return fromUrl;
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

interface Link {
  from: [number, number];
  to: [number, number];
  color: RGBA;
  width: number;
}

export function App() {
  const live = useLive();
  const [view, setView] = useState<MapViewState>(INITIAL_VIEW);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [layers, setLayers] = useState<Layers>({ busy: true, matched: false, shortAreas: false, alerts: true, jumps: false });
  const [selection, setSelection] = useState<Selection>();
  const [priority, setPriority] = useState<Priority>('normal');
  const [clickToCreate, setClickToCreate] = useState(true);
  const [toast, setToast] = useState<string>();
  const [help, setHelp] = useState(false);

  const p = PALETTES[theme];
  const snap = live.snapshot;
  const drivers = useDrivers(snap);
  const driverPos = (slot: number): [number, number] => [drivers!.lng[slot]!, drivers!.lat[slot]!];

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Private window or blocked storage: the theme just won't be remembered.
    }
  }, [theme]);

  const customers = useMemo(
    () => snap?.requests.filter((r) => WAITING.has(r.state) || r.state === 'UNASSIGNED' || (layers.matched && r.state === 'ASSIGNED')) ?? [],
    [snap, layers.matched],
  );

  const links = useMemo(() => {
    if (!snap) return [];
    const out: Link[] = [];
    for (const r of snap.requests) {
      const offered = r.state === 'OFFERED';
      if (!r.agentId || !(offered || (layers.matched && r.state === 'ASSIGNED'))) continue;
      const slot = drivers?.slotOf.get(r.agentId);
      if (slot === undefined) continue;
      out.push({
        from: driverPos(slot),
        to: [r.lng, r.lat],
        color: offered ? p.offered : p.matched,
        width: offered ? 2 : 1,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driverPos reads `drivers`
  }, [snap, drivers, layers.matched, p]);

  /** Ring around whatever the panel is following. */
  const selected = useMemo((): [number, number] | undefined => {
    if (!snap || !selection) return undefined;
    if (selection.kind === 'agent') {
      const slot = drivers?.slotOf.get(selection.id);
      return slot === undefined ? undefined : driverPos(slot);
    }
    const r = snap.requests.find((x) => x.id === selection.id);
    return r ? [r.lng, r.lat] : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driverPos reads `drivers`
  }, [snap, selection, drivers]);

  const jumps = useMemo(
    () => (snap && layers.jumps ? snap.anomalies.filter((a) => snap.at - a.at < JUMP_VISIBLE_MS) : []),
    [snap, layers.jumps],
  );

  const deckLayers = useMemo(() => {
    if (!snap || !drivers) return [];
    const colors = [p.free, p.offered, p.busy, p.noGps];
    const hidden: RGBA = [0, 0, 0, 0];
    // Both driver layers hold every slot in the same order (so positions can glide) and a GPU
    // filter on status decides which dots each layer shows: busy underneath, free on top.
    const driverLayer = (id: string, statuses: [number, number], radius: (slot: number) => number) =>
      new ScatterplotLayer<number, DataFilterExtensionProps<number>>({
        id,
        data: drivers.slots,
        getPosition: driverPos,
        getFillColor: (slot) => colors[drivers.status[slot]!] ?? hidden,
        getRadius: radius,
        radiusUnits: 'meters',
        radiusMinPixels: 1.5,
        radiusMaxPixels: 8,
        extensions: FILTER,
        getFilterValue: (slot) => drivers.status[slot]!,
        filterRange: statuses,
        pickable: true,
        autoHighlight: true,
        transitions: GLIDE,
        updateTriggers: {
          getPosition: drivers.version,
          getFillColor: [drivers.version, theme],
          getRadius: drivers.version,
          getFilterValue: drivers.version,
        },
      });

    return [
      new PolygonLayer<LiveZone>({
        id: 'short-areas',
        visible: layers.shortAreas,
        data: snap.zones,
        getPolygon: (z) => zonePolygon(z.zone),
        getFillColor: (z) => zoneColor(z, p),
        stroked: false,
        pickable: true,
        updateTriggers: { getFillColor: theme },
      }),
      new PolygonLayer<ZoneAlert>({
        id: 'alerts',
        visible: layers.alerts,
        data: snap.alerts,
        getPolygon: (z) => zonePolygon(z.zone),
        getFillColor: (z) => [...(z.severity === 'critical' ? p.critical : p.warning).slice(0, 3), 28] as RGBA,
        getLineColor: (z) => (z.severity === 'critical' ? p.critical : p.warning),
        lineWidthUnits: 'pixels',
        getLineWidth: 2.5,
        pickable: true,
        updateTriggers: { getFillColor: theme, getLineColor: theme },
      }),
      driverLayer('drivers-busy', layers.busy ? [2, 3] : [3, 3], () => 28),
      new LineLayer<Link>({
        id: 'links',
        data: links,
        getSourcePosition: (l) => l.from,
        getTargetPosition: (l) => l.to,
        getColor: (l) => l.color,
        getWidth: (l) => l.width,
      }),
      driverLayer('drivers', [0, 1], (slot) => (drivers.status[slot] === 1 ? 60 : 40)),
      new LineLayer<GpsAnomaly>({
        id: 'jump-lines',
        data: jumps,
        getSourcePosition: (j) => [j.from.lng, j.from.lat],
        getTargetPosition: (j) => [j.to.lng, j.to.lat],
        getColor: [...p.jump.slice(0, 3), 140] as RGBA,
        getWidth: 1,
      }),
      new ScatterplotLayer<GpsAnomaly>({
        id: 'jumps',
        data: jumps,
        getPosition: (j) => [j.to.lng, j.to.lat],
        filled: false,
        stroked: true,
        getLineColor: p.jump,
        radiusUnits: 'pixels',
        getRadius: 7,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        pickable: true,
        updateTriggers: { getLineColor: theme },
      }),
      new ScatterplotLayer<LiveRequest>({
        id: 'customers',
        data: customers,
        getPosition: (r) => [r.lng, r.lat],
        getFillColor: (r) => (r.state === 'UNASSIGNED' ? [0, 0, 0, 0] : r.state === 'ASSIGNED' ? p.matched : p.waiting),
        getLineColor: (r) => (r.state === 'UNASSIGNED' ? p.waiting : r.state === 'ASSIGNED' ? [0, 0, 0, 0] : p.ring),
        getRadius: (r) => (r.state === 'ASSIGNED' ? 3 : isUrgent(r) ? 8 : 6),
        radiusUnits: 'pixels',
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        pickable: true,
        autoHighlight: true,
        updateTriggers: { getFillColor: theme, getLineColor: theme },
      }),
      new ScatterplotLayer<[number, number]>({
        id: 'selected',
        data: selected ? [selected] : [],
        getPosition: (d) => d,
        filled: false,
        stroked: true,
        getLineColor: p.free,
        radiusUnits: 'pixels',
        getRadius: 14,
        lineWidthUnits: 'pixels',
        getLineWidth: 3,
        transitions: GLIDE,
        updateTriggers: { getLineColor: theme },
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- driverPos reads `drivers`
  }, [snap, drivers, customers, links, jumps, layers, p, theme, selected]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(undefined), 2_500);
  };

  const flyToZone = (zone: number) => {
    const c = zoneCenter(zone);
    setView({
      ...view,
      longitude: c.lng,
      latitude: c.lat,
      zoom: 13.5,
      transitionDuration: 800,
      transitionInterpolator: new FlyToInterpolator(),
    });
  };

  const onClick = (info: PickingInfo) => {
    const layerId = info.layer?.id;
    if (layerId === 'customers' && info.object) return setSelection({ kind: 'request', id: (info.object as LiveRequest).id });
    if ((layerId === 'drivers' || layerId === 'drivers-busy') && drivers && info.object !== undefined) {
      return setSelection({ kind: 'agent', id: drivers.ids[info.object as number]! });
    }
    if (layerId === 'alerts' && info.object) return flyToZone((info.object as ZoneAlert).zone);
    if (!clickToCreate || !info.coordinate) return setSelection(undefined);

    const [lng, lat] = info.coordinate as [number, number];
    fetch('/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat, lng, priority }),
    })
      .then(async (res) => {
        if (res.status === 429) throw new Error('the system is at capacity, try again in a second');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        setSelection({ kind: 'request', id });
        flash('Ride booked. Watch it get a driver.');
      })
      .catch((err: Error) => flash(`Couldn't book: ${err.message}`));
  };

  const getTooltip = (info: PickingInfo) => {
    const layerId = info.layer?.id;
    if (!snap || info.object === undefined || info.object === null) return null;
    if ((layerId === 'drivers' || layerId === 'drivers-busy') && drivers) {
      const slot = info.object as number;
      return `Driver ${drivers.ids[slot]}\n${AGENT_TEXT[drivers.status[slot]!] ?? ''}`;
    }
    if (layerId === 'customers') {
      const r = info.object as LiveRequest;
      return `${REQUEST_STATE_TEXT[r.state]}\nwaiting ${fmtDuration(snap.at - r.createdAt)} · ${r.attempts} driver${r.attempts === 1 ? '' : 's'} asked${isUrgent(r) ? `\n${r.priority} priority` : ''}`;
    }
    if (layerId === 'short-areas') {
      const z = info.object as LiveZone;
      return `${z.demand} waiting · ${z.supply} free drivers\n~${z.demandPerMin} bookings per minute here`;
    }
    if (layerId === 'alerts') {
      const z = info.object as ZoneAlert;
      return `${z.severity === 'critical' ? '⛔ Critical' : '⚠ Warning'}: short of drivers\n${z.supply} free nearby, ~${Math.round(z.expectedDemand)} bookings due in 5 min\nClick to zoom in`;
    }
    if (layerId === 'jumps') {
      const j = info.object as GpsAnomaly;
      return `Bad GPS reading from ${j.agentId}\nwould mean ${fmtInt(j.speedKmh)} km/h, so it was ${j.reanchored ? 'accepted after repeats' : 'ignored'}`;
    }
    return null;
  };

  return (
    <div className="app">
      <main className="map">
        <DeckGL
          viewState={view}
          onViewStateChange={({ viewState }) => setView(viewState as MapViewState)}
          controller
          layers={deckLayers}
          onClick={onClick}
          getTooltip={getTooltip}
          getCursor={({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering || clickToCreate ? 'pointer' : 'grab')}
        >
          <BaseMap mapStyle={p.mapStyle} />
        </DeckGL>
        <Kpis live={live} palette={p} />
        <Legend palette={p} layers={layers} onLayers={setLayers} />
        {toast && <div className="toast" role="status">{toast}</div>}
      </main>
      <Panel
        live={live}
        palette={p}
        theme={theme}
        onTheme={setTheme}
        onHelp={() => setHelp(true)}
        selection={selection}
        onClearSelection={() => setSelection(undefined)}
        priority={priority}
        onPriority={setPriority}
        clickToCreate={clickToCreate}
        onClickToCreate={setClickToCreate}
        onZone={flyToZone}
      />
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
