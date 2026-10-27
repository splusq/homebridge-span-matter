import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { EnergyIntegrator } from '../integrator.js';

test('integrates power into import and export, splitting at zero crossings', () => {
  const energy = new EnergyIntegrator();
  energy.sample('k', 3_600_000, 0);                // 3.6 kW
  assert.deepEqual(energy.sample('k', 3_600_000, 1000), { imported: 1000, exported: 0 }, '1 Wh in 1 s (mWh)');
  // 3.6 kW to -3.6 kW over 2 s: half a watt-hour each way, not zero net.
  assert.deepEqual(energy.sample('k', -3_600_000, 3000), { imported: 1500, exported: 500 });
});

test('does not bridge gaps or missing readings', () => {
  const energy = new EnergyIntegrator(undefined, 10_000);
  energy.sample('k', 1_000_000, 0);
  assert.equal(energy.sample('k', 1_000_000, 60_000).imported, 0, 'a minute without samples is unknown');
  energy.sample('k', null, 61_000);
  assert.equal(energy.sample('k', 1_000_000, 62_000).imported, 0);
});

test('totals persist across restarts', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'span-energy-')), 'energy.json');
  const first = new EnergyIntegrator(file);
  first.sample('k', 3_600_000, 0);
  first.sample('k', 3_600_000, 1000);
  await first.save();
  const second = new EnergyIntegrator(file);
  await second.load();
  assert.equal(second.read('k').imported, 1000);
});
