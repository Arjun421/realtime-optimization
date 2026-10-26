import { CITY_BOUNDS, type LatLng } from '@dispatch/shared';

/** Busy areas of Delhi NCR. Both supply and demand cluster around these. */
export const HOTSPOTS: (LatLng & { name: string; weight: number })[] = [
  { name: 'Connaught Place', lat: 28.6315, lng: 77.2167, weight: 3 },
  { name: 'Cyber City', lat: 28.495, lng: 77.089, weight: 3 },
  { name: 'Noida Sector 18', lat: 28.57, lng: 77.321, weight: 2 },
  { name: 'Saket', lat: 28.5245, lng: 77.2066, weight: 2 },
  { name: 'Karol Bagh', lat: 28.6519, lng: 77.1909, weight: 1.5 },
  { name: 'Dwarka', lat: 28.5921, lng: 77.046, weight: 1.5 },
  { name: 'Rohini', lat: 28.7495, lng: 77.0565, weight: 1 },
];

const totalWeight = HOTSPOTS.reduce((sum, h) => sum + h.weight, 0);

export const between = (min: number, max: number) => min + Math.random() * (max - min);

/** Standard normal sample (Box-Muller). */
function gaussian(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

export function clampToCity(p: LatLng): LatLng {
  return {
    lat: Math.min(CITY_BOUNDS.maxLat, Math.max(CITY_BOUNDS.minLat, p.lat)),
    lng: Math.min(CITY_BOUNDS.maxLng, Math.max(CITY_BOUNDS.minLng, p.lng)),
  };
}

export function isInCity(p: LatLng): boolean {
  return (
    p.lat >= CITY_BOUNDS.minLat && p.lat <= CITY_BOUNDS.maxLat &&
    p.lng >= CITY_BOUNDS.minLng && p.lng <= CITY_BOUNDS.maxLng
  );
}

export function uniformPoint(): LatLng {
  return {
    lat: between(CITY_BOUNDS.minLat, CITY_BOUNDS.maxLat),
    lng: between(CITY_BOUNDS.minLng, CITY_BOUNDS.maxLng),
  };
}

/** A point near a weighted-random hotspot (sigma ≈ 2 km), or anywhere with probability `uniformShare`. */
export function demandPoint(uniformShare = 0.3): LatLng {
  if (Math.random() < uniformShare) return uniformPoint();
  let pick = Math.random() * totalWeight;
  const spot = HOTSPOTS.find((h) => (pick -= h.weight) <= 0) ?? HOTSPOTS[0]!;
  const sigmaDeg = 0.018; // ~2 km
  return clampToCity({ lat: spot.lat + gaussian() * sigmaDeg, lng: spot.lng + gaussian() * sigmaDeg });
}
