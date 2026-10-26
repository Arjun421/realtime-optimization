import type { LatLng } from '@dispatch/shared';

/**
 * Decodes the score Redis stores for each member of a GEO set back into a
 * position, matching what GEOPOS returns.
 *
 * Why: reading 10k positions with GEOSEARCH/GEOPOS makes Redis do the decoding,
 * and Redis runs one command at a time, so dispatch waits behind it. A plain
 * ZRANGE WITHSCORES is cheap for Redis and the decode here is pure arithmetic.
 *
 * The score is a 52-bit interleaved geohash: latitude bits in even positions,
 * longitude bits in odd positions, 26 bits each (see geohash.c in Redis).
 */

const STEP = 26;
const LAT_MIN = -85.05112878;
const LAT_MAX = 85.05112878;
const LNG_MIN = -180;
const LNG_MAX = 180;
const TWO_32 = 2 ** 32;

/** Collects the even bits (0, 2, …, 30) of a 32-bit value into the low 16 bits. */
function evenBits(x: number): number {
  x &= 0x55555555;
  x = (x | (x >>> 1)) & 0x33333333;
  x = (x | (x >>> 2)) & 0x0f0f0f0f;
  x = (x | (x >>> 4)) & 0x00ff00ff;
  x = (x | (x >>> 8)) & 0x0000ffff;
  return x;
}

export function decodeGeoScore(score: number): LatLng {
  // JS bitwise ops are 32-bit, so split the 52-bit score into two halves.
  const lo = score % TWO_32 >>> 0;
  const hi = Math.floor(score / TWO_32) >>> 0;
  const latBits = evenBits(lo) + evenBits(hi) * 2 ** 16;
  const lngBits = evenBits(lo >>> 1) + evenBits(hi >>> 1) * 2 ** 16;
  // Each value is a cell index; return the cell centre like GEOPOS does.
  return {
    lat: LAT_MIN + ((latBits + 0.5) / 2 ** STEP) * (LAT_MAX - LAT_MIN),
    lng: LNG_MIN + ((lngBits + 0.5) / 2 ** STEP) * (LNG_MAX - LNG_MIN),
  };
}
