import { CITY_BOUNDS, type LatLng } from './geo.js';

/**
 * Fixed grid of zones over the city, ~2.2 km × 2 km each. Used for the
 * supply/demand panel now and for zone-depletion scoring later. A plain grid
 * (not H3) keeps it dependency-free and identical on server and browser.
 */
export const ZONE_SIZE_DEG = 0.02;
export const ZONE_ROWS = Math.ceil((CITY_BOUNDS.maxLat - CITY_BOUNDS.minLat) / ZONE_SIZE_DEG);
export const ZONE_COLS = Math.ceil((CITY_BOUNDS.maxLng - CITY_BOUNDS.minLng) / ZONE_SIZE_DEG);

/** Zone index (row * ZONE_COLS + col), or -1 outside the city. */
export function zoneOf(p: LatLng): number {
  const row = Math.floor((p.lat - CITY_BOUNDS.minLat) / ZONE_SIZE_DEG);
  const col = Math.floor((p.lng - CITY_BOUNDS.minLng) / ZONE_SIZE_DEG);
  if (row < 0 || row >= ZONE_ROWS || col < 0 || col >= ZONE_COLS) return -1;
  return row * ZONE_COLS + col;
}

/** Corner coordinates of a zone as a closed [lng, lat] ring. */
export function zonePolygon(zone: number): [number, number][] {
  const row = Math.floor(zone / ZONE_COLS);
  const col = zone % ZONE_COLS;
  const minLat = CITY_BOUNDS.minLat + row * ZONE_SIZE_DEG;
  const minLng = CITY_BOUNDS.minLng + col * ZONE_SIZE_DEG;
  const maxLat = minLat + ZONE_SIZE_DEG;
  const maxLng = minLng + ZONE_SIZE_DEG;
  return [[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]];
}

export function zoneCenter(zone: number): LatLng {
  const row = Math.floor(zone / ZONE_COLS);
  const col = zone % ZONE_COLS;
  return {
    lat: CITY_BOUNDS.minLat + (row + 0.5) * ZONE_SIZE_DEG,
    lng: CITY_BOUNDS.minLng + (col + 0.5) * ZONE_SIZE_DEG,
  };
}

/** Human-readable zone label, e.g. "R12-C07". */
export function zoneLabel(zone: number): string {
  const row = Math.floor(zone / ZONE_COLS);
  const col = zone % ZONE_COLS;
  return `R${String(row).padStart(2, '0')}-C${String(col).padStart(2, '0')}`;
}
