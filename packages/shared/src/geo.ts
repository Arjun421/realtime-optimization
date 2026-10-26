export interface LatLng {
  lat: number;
  lng: number;
}

/** Simulation area: roughly Delhi NCR. */
export const CITY_BOUNDS = {
  minLat: 28.4,
  maxLat: 28.88,
  minLng: 76.84,
  maxLng: 77.35,
} as const;

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Move `meters` from `from` along `bearingRad` (0 = north, clockwise). */
export function offsetMeters(from: LatLng, meters: number, bearingRad: number): LatLng {
  const dLat = (meters * Math.cos(bearingRad)) / EARTH_RADIUS_M;
  const dLng = (meters * Math.sin(bearingRad)) / (EARTH_RADIUS_M * Math.cos(toRad(from.lat)));
  return { lat: from.lat + (dLat * 180) / Math.PI, lng: from.lng + (dLng * 180) / Math.PI };
}

/** Initial bearing from `a` to `b` in radians (0 = north, clockwise). */
export function bearingRad(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return Math.atan2(y, x);
}
