import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEARTBEAT_MS, shouldPushPower } from '../throttle.js';

const deadband = { milliwatts: 5_000, percent: 2 };
const circuit = (activePower: number | null, voltage = 120_000, activeCurrent = 1_000) => ({ activePower, voltage, activeCurrent });

test('the first reading always goes out', () => {
  assert.equal(shouldPushPower(circuit(0), undefined, 0, deadband), true);
});

test('power pushes past the larger of the floor and the percentage', () => {
  assert.equal(shouldPushPower(circuit(104_000), circuit(100_000), 1_000, deadband), false, '4 W is under the 5 W floor');
  assert.equal(shouldPushPower(circuit(105_000), circuit(100_000), 1_000, deadband), true);
  assert.equal(shouldPushPower(circuit(2_030_000), circuit(2_000_000), 1_000, deadband), false, '30 W is under 2% of 2 kW');
  assert.equal(shouldPushPower(circuit(1_960_000), circuit(2_000_000), 1_000, deadband), true, 'falls count too');
  assert.equal(shouldPushPower(circuit(null), circuit(0), 1_000, deadband), true, 'losing a reading');
  assert.equal(shouldPushPower(circuit(0), circuit(null), 1_000, deadband), true, 'regaining one');
});

test('voltage and current wait for the heartbeat', () => {
  const last = circuit(100_000);
  const drifted = circuit(102_000, 121_500, 1_300);
  assert.equal(shouldPushPower(drifted, last, HEARTBEAT_MS - 1, deadband), false);
  assert.equal(shouldPushPower(drifted, last, HEARTBEAT_MS, deadband), true);
});

test('an unchanged reading never goes out, even with no deadband', () => {
  assert.equal(shouldPushPower(circuit(100_000), circuit(100_000), 10 * HEARTBEAT_MS, deadband), false);
  assert.equal(shouldPushPower(circuit(100_000), circuit(100_000), 1_000, { milliwatts: 0, percent: 0 }), false);
});
