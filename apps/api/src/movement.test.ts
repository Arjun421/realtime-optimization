import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { offsetMeters } from '@dispatch/shared';
import { checkMovement } from './movement.js';

const start = { lat: 28.6, lng: 77.2 };
const at = (meters: number, ts: number) => ({ ...offsetMeters(start, meters, 0), ts });

describe('checkMovement', () => {
  it('accepts normal driving', () => {
    assert.equal(checkMovement('drive', at(0, 0)).accept, true);
    assert.equal(checkMovement('drive', at(30, 3_000)).accept, true); // 10 m/s
  });

  it('rejects a single 10 km jump in 3 s, then carries on from the last good fix', () => {
    checkMovement('glitch', at(0, 0));
    const jump = checkMovement('glitch', at(10_000, 3_000));
    assert.equal(jump.accept, false);
    assert.equal(jump.anomaly?.reanchored, false);
    assert.ok((jump.anomaly?.speedKmh ?? 0) > 10_000);
    assert.equal(checkMovement('glitch', at(60, 6_000)).accept, true);
  });

  it('believes a relocation after repeated consistent fixes', () => {
    checkMovement('moved', at(0, 0));
    assert.equal(checkMovement('moved', at(10_000, 3_000)).accept, false);
    assert.equal(checkMovement('moved', at(10_020, 6_000)).accept, false);
    const third = checkMovement('moved', at(10_040, 9_000));
    assert.equal(third.accept, true);
    assert.equal(third.anomaly?.reanchored, true);
  });

  it('ignores small GPS noise even over a tiny interval', () => {
    checkMovement('noise', at(0, 0));
    assert.equal(checkMovement('noise', at(150, 100)).accept, true);
  });

  it('accepts a long move after a long gap (GPS was off, not teleporting)', () => {
    checkMovement('tunnel', at(0, 0));
    assert.equal(checkMovement('tunnel', at(5_000, 600_000)).accept, true); // 5 km in 10 min
  });
});
