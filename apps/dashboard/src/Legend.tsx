import { cssColor, type Palette, type RGBA } from './colors';

export interface Layers {
  busy: boolean;
  matched: boolean;
  shortAreas: boolean;
  alerts: boolean;
  jumps: boolean;
}

type Mark = 'dot' | 'customer' | 'ring' | 'line' | 'square';

function Swatch({ mark, color, ring }: { mark: Mark; color: RGBA; ring?: RGBA }) {
  const c = cssColor(color);
  const style =
    mark === 'customer' ? { background: c, boxShadow: `0 0 0 2px ${cssColor(ring ?? color)}, 0 0 0 3px ${c}` }
    : mark === 'ring' ? { border: `2px solid ${c}` }
    : mark === 'square' ? { border: `2px solid ${c}` }
    : mark === 'line' ? { background: c }
    : { background: c };
  return <i className={`sw sw-${mark}`} style={style} />;
}

function Item({ mark, color, ring, label, toggle }: {
  mark: Mark;
  color: RGBA;
  ring?: RGBA;
  label: string;
  toggle?: { on: boolean; set(on: boolean): void };
}) {
  const body = (
    <>
      <Swatch mark={mark} color={color} ring={ring} />
      <span>{label}</span>
    </>
  );
  if (!toggle) return <div className="legend-item">{body}</div>;
  return (
    <label className={`legend-item toggle ${toggle.on ? '' : 'off'}`}>
      <input type="checkbox" checked={toggle.on} onChange={(e) => toggle.set(e.target.checked)} />
      {body}
    </label>
  );
}

/** What every mark on the map means, with switches for the optional ones. */
export function Legend({ palette: p, layers, onLayers }: { palette: Palette; layers: Layers; onLayers(l: Layers): void }) {
  const set = (k: keyof Layers) => (on: boolean) => onLayers({ ...layers, [k]: on });
  return (
    <div className="legend" aria-label="Map legend">
      <div className="legend-group">Drivers</div>
      <Item mark="dot" color={p.free} label="Free" />
      <Item mark="dot" color={p.offered} label="Deciding on an offer" />
      <Item mark="dot" color={p.busy} label="Busy on a trip" toggle={{ on: layers.busy, set: set('busy') }} />
      <Item mark="dot" color={p.noGps} label="GPS lost (gets no jobs)" />

      <div className="legend-group">Customers</div>
      <Item mark="customer" color={p.waiting} ring={p.ring} label="Waiting for a driver" />
      <Item mark="ring" color={p.waiting} label="No driver found" />
      <Item mark="line" color={p.offered} label="Offer sent to that driver" />
      <Item mark="dot" color={p.matched} label="Driver on the way" toggle={{ on: layers.matched, set: set('matched') }} />

      <div className="legend-group">Areas</div>
      <Item mark="square" color={p.critical} label="Short of drivers (alert)" toggle={{ on: layers.alerts, set: set('alerts') }} />
      <Item mark="square" color={[...p.shortArea.slice(0, 3), 110] as RGBA} label="More waiting than free, now" toggle={{ on: layers.shortAreas, set: set('shortAreas') }} />
      <Item mark="ring" color={p.jump} label="Blocked GPS jump" toggle={{ on: layers.jumps, set: set('jumps') }} />
    </div>
  );
}
