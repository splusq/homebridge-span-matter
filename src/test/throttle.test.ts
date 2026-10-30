import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEARTBEAT_MS, powerUpdate, recordSent, VOLTAGE_STEP_MV } from '../throttle.js';

const deadband = { milliwatts: 5_000, percent: 2 };
const circuit = (activePower: number | null, voltage = 120_000, activeCurrent = 1_000) => ({ activePower, voltage, activeCurrent });
const sentAt = (reading: ReturnType<typeof circuit>, at = 0) => recordSent(undefined, reading, at);

test('the first reading sends everything', () => {
  assert.deepEqual(powerUpdate(circuit(0), undefined, 0, deadband), circuit(0));
  assert.deepEqual(powerUpdate({ activePower: 5 }, undefined, 0, deadband), { activePower: 5 }, 'no voltage or current where there are none');
});

test('power goes out past the larger of the floor and the percentage, with current', () => {
  const sent = sentAt(circuit(100_000));
  assert.equal(powerUpdate(circuit(104_000, 120_000, 1_100), sent, 30_000, deadband), undefined, '4 W is under the 5 W floor');
  assert.deepEqual(powerUpdate(circuit(105_000, 120_000, 1_100), sent, 30_000, deadband), { activePower: 105_000, activeCurrent: 1_100 });
  const big = sentAt(circuit(2_000_000));
  assert.equal(powerUpdate(circuit(2_030_000), big, 30_000, deadband), undefined, '30 W is under 2% of 2 kW');
  assert.equal(powerUpdate(circuit(1_960_000), big, 30_000, deadband)?.activePower, 1_960_000, 'falls count too');
  assert.equal(powerUpdate(circuit(null), sent, 30_000, deadband)?.activePower, null, 'losing a reading');
});

test('voltage never rides along with power', () => {
  const sent = sentAt(circuit(100_000, 120_000));
  assert.deepEqual(Object.keys(powerUpdate(circuit(200_000, 121_500), sent, 30_000, deadband)!), ['activePower', 'activeCurrent']);
});

test('voltage goes out on a real swing, or with the heartbeat', () => {
  const sent = sentAt(circuit(100_000, 120_000));
  assert.deepEqual(powerUpdate(circuit(100_000, 120_000 + VOLTAGE_STEP_MV), sent, 30_000, deadband), { voltage: 122_000 });
  assert.equal(powerUpdate(circuit(100_000, 121_500), sent, HEARTBEAT_MS - 1, deadband), undefined);
  assert.deepEqual(powerUpdate(circuit(100_000, 121_500), sent, HEARTBEAT_MS, deadband), { voltage: 121_500 });
});

test('drift under the deadband waits for the heartbeat', () => {
  const sent = sentAt(circuit(100_000));
  assert.equal(powerUpdate(circuit(102_000, 120_000, 1_020), sent, HEARTBEAT_MS - 1, deadband), undefined);
  assert.deepEqual(powerUpdate(circuit(102_000, 120_000, 1_020), sent, HEARTBEAT_MS, deadband), { activePower: 102_000, activeCurrent: 1_020 });
});

test('an unchanged reading never goes out', () => {
  const sent = sentAt(circuit(100_000));
  assert.equal(powerUpdate(circuit(100_000), sent, 10 * HEARTBEAT_MS, deadband), undefined);
  assert.equal(powerUpdate(circuit(100_000), sent, 1_000, { milliwatts: 0, percent: 0 }), undefined);
});

test('recording a send keeps power and voltage clocks apart', () => {
  let sent = sentAt(circuit(100_000), 0);
  sent = recordSent(sent, { voltage: 122_000 }, 60_000);
  assert.equal(sent.at, 0);
  assert.equal(sent.voltageAt, 60_000);
  sent = recordSent(sent, { activePower: 200_000, activeCurrent: 2_000 }, 90_000);
  assert.deepEqual(sent, { activePower: 200_000, activeCurrent: 2_000, voltage: 122_000, at: 90_000, voltageAt: 60_000 });
});
