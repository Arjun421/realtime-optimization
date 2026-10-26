import { FlyToInterpolator, type MapViewState, type PickingInfo } from '@deck.gl/core';
import { LineLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import DeckGL from '@deck.gl/react';
import {
  AGENT_LIVE_STATUSES,
  zoneCenter,
  zonePolygon,
  type LiveRequest,
  type LiveZone,
  type Priority,
} from '@dispatch/shared';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useMemo, useState } from 'react';
import { Map as BaseMap } from 'react-map-gl/maplibre';
import { AGENT_COLORS, REQUEST_COLORS, zoneColor, type RGBA } from './colors';
import { Panel, type Layers, type Selection } from './Panel';
import { useLive } from './useLive';

/** Free CARTO basemap, no API key needed. */
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const INITIAL_VIEW: MapViewState = { longitude: 77.15, latitude: 28.61, zoom: 10.3, pitch: 0, bearing: 0 };

/** Requests with an agent on the way get a line from that agent to the pickup. */
const LINKED_STATES = new Set(['OFFERED', 'ASSIGNED']);
/** Settled requests are drawn small so the ones still needing an agent stand out. */
const SETTLED_STATES = new Set(['ASSIGNED', 'COMPLETED', 'CANCELLED']);

const isUrgent = (r: LiveRequest) => r.priority === 'high' || r.priority === 'critical';

interface Link {
  from: [number, number];
  to: [number, number];
  color: RGBA;
}

export function App() {
  const live = useLive();
  const [view, setView] = useState<MapViewState>(INITIAL_VIEW);
  const [layers, setLayers] = useState<Layers>({ agents: true, requests: true, links: true, zones: true });
  const [selection, setSelection] = useState<Selection>();
  const [priority, setPriority] = useState<Priority>('normal');
  const [clickToCreate, setClickToCreate] = useState(true);
  const [toast, setToast] = useState<string>();

  const snap = live.snapshot;

  const agentIndex = useMemo(() => {
    const index = new Map<string, number>();
    snap?.agents.ids.forEach((id, i) => index.set(id, i));
    return index;
  }, [snap]);

  const links = useMemo(() => {
    if (!snap) return [];
    const out: Link[] = [];
    for (const r of snap.requests) {
      if (!r.agentId || !LINKED_STATES.has(r.state)) continue;
      const i = agentIndex.get(r.agentId);
      if (i === undefined) continue;
      out.push({ from: [snap.agents.lng[i]!, snap.agents.lat[i]!], to: [r.lng, r.lat], color: REQUEST_COLORS[r.state] });
    }
    return out;
  }, [snap, agentIndex]);

  const deckLayers = useMemo(() => {
    if (!snap) return [];
    const agentCount = { length: snap.agents.ids.length };
    return [
      new PolygonLayer<LiveZone>({
        id: 'zones',
        visible: layers.zones,
        data: snap.zones,
        getPolygon: (z) => zonePolygon(z.zone),
        getFillColor: zoneColor,
        stroked: false,
        pickable: true,
      }),
      new LineLayer<Link>({
        id: 'links',
        visible: layers.links,
        data: links,
        getSourcePosition: (l) => l.from,
        getTargetPosition: (l) => l.to,
        getColor: (l) => l.color,
        getWidth: 1.5,
      }),
      // Agents are columns of parallel arrays; accessors read by index.
      new ScatterplotLayer({
        id: 'agents',
        visible: layers.agents,
        data: agentCount,
        getPosition: (_: unknown, { index }: { index: number }) => [snap.agents.lng[index]!, snap.agents.lat[index]!],
        getFillColor: (_: unknown, { index }: { index: number }) =>
          AGENT_COLORS[AGENT_LIVE_STATUSES[snap.agents.status[index]!]!],
        radiusUnits: 'pixels',
        getRadius: 2.5,
        radiusMinPixels: 1.5,
        pickable: true,
        autoHighlight: true,
      }),
      new ScatterplotLayer<LiveRequest>({
        id: 'requests',
        visible: layers.requests,
        data: snap.requests,
        getPosition: (r) => [r.lng, r.lat],
        getFillColor: (r) => REQUEST_COLORS[r.state],
        getLineColor: (r) => (isUrgent(r) ? [255, 255, 255, 255] : [0, 0, 0, 200]),
        getRadius: (r) => (SETTLED_STATES.has(r.state) ? 3 : 5.5),
        radiusUnits: 'pixels',
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: (r) => (isUrgent(r) ? 2 : 1),
        pickable: true,
        autoHighlight: true,
      }),
    ];
  }, [snap, links, layers]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(undefined), 2_000);
  };

  const onClick = (info: PickingInfo) => {
    const layerId = info.layer?.id;
    if (layerId === 'requests' && info.object) return setSelection({ kind: 'request', id: (info.object as LiveRequest).id });
    if (layerId === 'agents' && snap && info.index >= 0) {
      return setSelection({ kind: 'agent', id: snap.agents.ids[info.index]! });
    }
    if (!clickToCreate || !info.coordinate) return setSelection(undefined);

    const [lng, lat] = info.coordinate as [number, number];
    fetch('/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lat, lng, priority }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { id } = (await res.json()) as { id: string };
        setSelection({ kind: 'request', id });
        flash(`Request created (${priority})`);
      })
      .catch((err: Error) => flash(`Could not create request: ${err.message}`));
  };

  const getTooltip = (info: PickingInfo) => {
    const layerId = info.layer?.id;
    if (layerId === 'agents' && snap && info.index >= 0) {
      return `${snap.agents.ids[info.index]}\n${AGENT_LIVE_STATUSES[snap.agents.status[info.index]!]}`;
    }
    if (layerId === 'requests' && info.object) {
      const r = info.object as LiveRequest;
      return `${r.state} · ${r.priority}\nattempts ${r.attempts}${r.agentId ? `\n${r.agentId}` : ''}`;
    }
    if (layerId === 'zones' && info.object) {
      const z = info.object as LiveZone;
      return `free agents ${z.supply}\nwaiting requests ${z.demand}`;
    }
    return null;
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

  return (
    <div className="app">
      <div className="map">
        <DeckGL
          viewState={view}
          onViewStateChange={({ viewState }) => setView(viewState as MapViewState)}
          controller
          layers={deckLayers}
          onClick={onClick}
          getTooltip={getTooltip}
          getCursor={({ isHovering, isDragging }) => (isDragging ? 'grabbing' : isHovering || clickToCreate ? 'pointer' : 'grab')}
        >
          <BaseMap mapStyle={MAP_STYLE} />
        </DeckGL>
        {toast && <div className="toast">{toast}</div>}
      </div>
      <Panel
        live={live}
        layers={layers}
        onLayers={setLayers}
        selection={selection}
        onClearSelection={() => setSelection(undefined)}
        priority={priority}
        onPriority={setPriority}
        clickToCreate={clickToCreate}
        onClickToCreate={setClickToCreate}
        onZone={flyToZone}
      />
    </div>
  );
}
