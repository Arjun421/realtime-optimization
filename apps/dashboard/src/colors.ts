import type { LiveZone } from '@dispatch/shared';

export type RGBA = [number, number, number, number];
export type Theme = 'light' | 'dark';

const hex = (h: string, alpha = 255): RGBA => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
  alpha,
];

/**
 * Map colours per theme. Free drivers, offered drivers and waiting customers
 * are the three things to tell apart at a glance, so they get blue / amber /
 * red, checked to stay distinct for colour-blind viewers in both themes
 * (red vs green was not). Busy drivers are grey on purpose: they are
 * background. Customers are also bigger, ringed circles, so shape separates
 * them from drivers too.
 */
export interface Palette {
  free: RGBA;
  offered: RGBA;
  busy: RGBA;
  noGps: RGBA;
  waiting: RGBA;
  matched: RGBA;
  ring: RGBA;
  warning: RGBA;
  critical: RGBA;
  jump: RGBA;
  shortArea: RGBA;
  mapStyle: string;
}

export const PALETTES: Record<Theme, Palette> = {
  light: {
    free: hex('#2a78d6'),
    offered: hex('#eda100'),
    busy: hex('#8b8f97', 120),
    noGps: hex('#b4b7bd', 200),
    waiting: hex('#e34948'),
    matched: hex('#8b8f97', 200),
    ring: hex('#ffffff'),
    warning: hex('#ec835a'),
    critical: hex('#d03b3b'),
    jump: hex('#6250d6'),
    shortArea: hex('#e34948'),
    mapStyle: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  },
  dark: {
    free: hex('#3987e5'),
    offered: hex('#c98500'),
    busy: hex('#6b6f78', 150),
    noGps: hex('#4a4d54', 220),
    waiting: hex('#d03b3b'),
    matched: hex('#6b6f78', 220),
    ring: hex('#111214'),
    warning: hex('#ec835a'),
    critical: hex('#d03b3b'),
    jump: hex('#9085e9'),
    shortArea: hex('#d03b3b'),
    mapStyle: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
};

/** Faint red tile where waiting customers outnumber free drivers; nothing elsewhere. */
export function zoneColor(z: LiveZone, p: Palette): RGBA {
  const gap = z.demand - z.supply;
  const [r, g, b] = p.shortArea;
  return gap > 0 ? [r, g, b, 40 + Math.min(gap, 4) * 25] : [r, g, b, 0];
}

export const cssColor = ([r, g, b, a]: RGBA) => `rgb(${r} ${g} ${b} / ${(a / 255).toFixed(2)})`;
