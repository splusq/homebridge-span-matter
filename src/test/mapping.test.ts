import assert from 'node:assert/strict';
import { test } from 'node:test';

import { discover, read } from '../mapping.js';
import { EbusModel } from '../span/ebus.js';

const SERIAL = 'nt-0000-abcde';
const meter = { datatype: 'float' };

function describe(model: EbusModel, id: string, type: string, nodes: Record<string, Record<string, object>>, children?: string[]) {
  model.ingest(`ebus/5/${id}/$description`, JSON.stringify({
    homie: '5.0',
    type: `energy.ebus.device.${type}`,
    children,
    nodes: Object.fromEntries(Object.entries(nodes).map(([node, properties]) => [node, { properties }])),
  }));
  model.ingest(`ebus/5/${id}/$state`, 'ready');
}

function set(model: EbusModel, id: string, values: Record<string, string>) {
  for (const [path, value] of Object.entries(values)) {
    model.ingest(`ebus/5/${id}/${path}`, value);
  }
}

const circuitNodes = {
  info: { name: { datatype: 'string' }, spaces: { datatype: 'string' } },
  switch: { relay: { datatype: 'enum' }, 'relay-controllable': { datatype: 'boolean' } },
  breaker: { poles: { datatype: 'integer' } },
  meter: { current: meter, 'active-power': meter, 'imported-energy': meter, 'exported-energy': meter },
  connection: { 'feeds-device-id': { datatype: 'string' }, 'feeds-device-type': { datatype: 'string' } },
};

// SPAN's worked example (power-and-energy-conventions.md): 6 kW of PV on a
// breaker, 2 kW of house load, a battery on a breaker charging at 1 kW, and
// 3 kW exported to the grid.
function middayPanel(): EbusModel {
  const model = new EbusModel(SERIAL);
  // Values may arrive before descriptions; the model must cope.
  set(model, 'c-load', { 'meter/active-power': '-2000' });

  describe(model, SERIAL, 'distribution-enclosure', {
    info: { 'serial-number': { datatype: 'string' }, model: { datatype: 'enum' } },
    meter: { 'voltage-a': meter, 'voltage-b': meter },
    'power-flows': { pv: meter, battery: meter, grid: meter, site: meter },
  }, [`${SERIAL}-lugs-up`, `${SERIAL}-lugs-dn`, 'c-load', 'c-pv', 'c-bess', `${SERIAL}-pw`, `${SERIAL}-pv`]);
  set(model, SERIAL, {
    'info/serial-number': SERIAL, 'info/model': 'MAIN_32',
    'meter/voltage-a': '121.0', 'meter/voltage-b': '119.0',
    'power-flows/pv': '-6000', 'power-flows/battery': '1000', 'power-flows/grid': '3000', 'power-flows/site': '2000',
  });

  const lugsNodes = {
    info: { direction: { datatype: 'enum' } },
    meter: { 'current-a': meter, 'current-b': meter, 'active-power': meter, 'imported-energy': meter, 'exported-energy': meter },
  };
  describe(model, `${SERIAL}-lugs-up`, 'lugs', lugsNodes);
  set(model, `${SERIAL}-lugs-up`, {
    'info/direction': 'UPSTREAM', 'meter/active-power': '-3000',
    'meter/current-a': '12.4', 'meter/current-b': '12.6',
    'meter/imported-energy': '1234567.5', 'meter/exported-energy': '7654321.25',
  });
  describe(model, `${SERIAL}-lugs-dn`, 'lugs', lugsNodes);
  set(model, `${SERIAL}-lugs-dn`, { 'info/direction': 'DOWNSTREAM', 'meter/active-power': '0', 'meter/imported-energy': '0', 'meter/exported-energy': '0' });

  describe(model, 'c-load', 'circuit', circuitNodes);
  set(model, 'c-load', {
    'info/name': 'Kitchen', 'info/spaces': '5', 'breaker/poles': '1', 'meter/current': '16.7',
    'meter/imported-energy': '0', 'meter/exported-energy': '500000', 'switch/relay': 'CLOSED', 'switch/relay-controllable': 'true',
  });
  describe(model, 'c-pv', 'circuit', circuitNodes);
  set(model, 'c-pv', {
    'info/name': 'Solar', 'info/spaces': '17,19', 'breaker/poles': '2', 'meter/active-power': '6000', 'meter/current': '25',
    'meter/imported-energy': '9000000', 'meter/exported-energy': '1200',
    'connection/feeds-device-type': 'energy.ebus.device.pv', 'connection/feeds-device-id': `${SERIAL}-pv`,
  });
  describe(model, 'c-bess', 'circuit', circuitNodes);
  set(model, 'c-bess', {
    'info/name': 'Powerwall', 'info/spaces': '21,23', 'breaker/poles': '2', 'meter/active-power': '-1000',
    'meter/imported-energy': '300000', 'meter/exported-energy': '350000',
    'connection/feeds-device-type': 'energy.ebus.device.bess', 'connection/feeds-device-id': `${SERIAL}-pw`,
  });
  describe(model, `${SERIAL}-pw`, 'bess', {
    soc: { soc: meter }, meter: { 'active-power': meter }, info: { model: { datatype: 'string' } },
  }, [`${SERIAL}-pw-mid`]);
  set(model, `${SERIAL}-pw`, { 'soc/soc': '64.5', 'meter/active-power': '-1000' });
  describe(model, `${SERIAL}-pv`, 'pv', { info: { model: { datatype: 'string' } } });
  return model;
}

test('the model is incomplete until every descendant has described itself', () => {
  const model = middayPanel();
  assert.equal(model.isComplete(), false, 'the MID grandchild has not described itself');
  describe(model, `${SERIAL}-pw-mid`, 'mid', {});
  assert.equal(model.isComplete(), true);
});

test('discovers grid, circuits and DERs, folding DER circuits into their roles', () => {
  const specs = discover(middayPanel());
  assert.deepEqual(specs.map(spec => [spec.role, spec.name]), [
    ['grid', 'SPAN Grid'],
    ['circuit', 'Kitchen'],
    ['solar', 'Solar'],
    ['battery', 'Powerwall'],
  ]);
  assert.equal(specs[0]!.model, 'SPAN Main 32');
  assert.equal(specs[1]!.relayControllable, true);
  assert.equal(specs[3]!.socId, `${SERIAL}-pw`);
});

test('grid lugs map straight through: Matter and eBus agree on the grid sign', () => {
  const model = middayPanel();
  const grid = discover(model)[0]!;
  assert.deepEqual(read(grid, model)!.energy, {
    activePower: -3_000_000,
    voltage: 240_000,
    activeCurrent: -12_500,
    imported: 1_234_567_500,
    exported: 7_654_321_250,
  });
});

test('circuits flip sign and swap counters into the device frame', () => {
  const model = middayPanel();
  const [, kitchen, solar, battery] = discover(model);
  assert.deepEqual(read(kitchen!, model), {
    energy: { activePower: 2_000_000, voltage: 120_000, activeCurrent: 16_700, imported: 500_000_000, exported: 0 },
    relayClosed: true,
  });
  const pv = read(solar!, model)!.energy;
  assert.equal(pv.activePower, -6_000_000, 'a producer is negative in Matter');
  assert.equal(pv.activeCurrent, -25_000);
  assert.equal(pv.voltage, 240_000, 'two-pole breaker sees line to line');
  assert.equal(pv.exported, 9_000_000_000);
  const pw = read(battery!, model)!;
  assert.equal(pw.energy.activePower, 1_000_000, 'charging consumes');
  assert.deepEqual(pw.battery, { batPercentRemaining: 129, batChargeLevel: 0, batChargeState: 1 });
});

test('the device frame balances: grid = sum of everything behind it', () => {
  const model = middayPanel();
  const [grid, ...rest] = discover(model).map(spec => read(spec, model)!.energy.activePower!);
  assert.equal(grid, rest.reduce((sum, power) => sum + power, 0));
});

test('supply-side DERs fall back to the BESS meter and power-flows', () => {
  const model = middayPanel();
  // Unwire the DER circuits: the battery and PV are now upstream of the panel.
  set(model, 'c-pv', { 'connection/feeds-device-type': '', 'connection/feeds-device-id': '' });
  set(model, 'c-bess', { 'connection/feeds-device-type': '', 'connection/feeds-device-id': '' });
  const specs = discover(model);
  const battery = specs.find(spec => spec.role === 'battery')!;
  const solar = specs.find(spec => spec.role === 'solar')!;
  assert.equal(battery.source, 'bess');
  assert.equal(battery.derivedEnergy, true);
  assert.equal(read(battery, model)!.energy.activePower, 1_000_000, 'BESS meter is positive discharging; charging is consumption');
  assert.equal(solar.source, 'power-flows');
  assert.equal(read(solar, model)!.energy.activePower, -6_000_000);
});

test('exclusions, feed-through and Matter text limits', () => {
  const model = middayPanel();
  set(model, 'c-load', { 'info/name': 'A circuit name that is far too long for Matter' });
  let specs = discover(model, { excludeCircuits: ['solar'], feedthrough: 'always' });
  assert.ok(!specs.some(spec => spec.name === 'Solar'));
  assert.ok(specs.some(spec => spec.role === 'feedthrough'));
  assert.ok(specs.every(spec => spec.name.length <= 32 && spec.serialNumber.length <= 32));
  specs = discover(model);
  assert.ok(!specs.some(spec => spec.role === 'feedthrough'), 'idle feed-through hidden in auto');
});

test('battery charge level and state', () => {
  const model = middayPanel();
  const battery = discover(model).find(spec => spec.role === 'battery')!;
  set(model, `${SERIAL}-pw`, { 'soc/soc': '7' });
  set(model, 'c-bess', { 'meter/active-power': '2500' });
  assert.deepEqual(read(battery, model)!.battery, { batPercentRemaining: 14, batChargeLevel: 1, batChargeState: 3 });
  set(model, `${SERIAL}-pw`, { 'soc/soc': '100' });
  assert.equal(read(battery, model)!.battery!.batChargeState, 2);
});

// The wiring of a Powerwall gateway install: battery and PV upstream of the
// panel, so the upstream lugs see the panel's load and only power-flows sees
// the utility.
function gatewayPanel(): EbusModel {
  const model = middayPanel();
  set(model, 'c-pv', { 'connection/feeds-device-type': '', 'connection/feeds-device-id': '' });
  set(model, 'c-bess', { 'connection/feeds-device-type': '', 'connection/feeds-device-id': '' });
  describe(model, `${SERIAL}-lugs-up`, 'lugs', {
    info: { direction: { datatype: 'enum' } },
    meter: { 'current-a': meter, 'current-b': meter, 'active-power': meter, 'imported-energy': meter, 'exported-energy': meter },
    connection: { 'fed-by-device-type': { datatype: 'string' } },
  });
  set(model, `${SERIAL}-lugs-up`, { 'connection/fed-by-device-type': 'energy.ebus.device.bess', 'meter/active-power': '3200' });
  set(model, SERIAL, { 'power-flows/grid': '-2500' });
  // A derived feed-through that drifts both ways with nothing connected.
  set(model, `${SERIAL}-lugs-dn`, { 'meter/active-power': '-3.7', 'meter/imported-energy': '11355179', 'meter/exported-energy': '11300590' });
  return model;
}

test('a DER upstream moves the whole-home meter to the utility flow', () => {
  const model = gatewayPanel();
  const specs = discover(model);
  const grid = specs.find(spec => spec.role === 'grid')!;
  const panel = specs.find(spec => spec.role === 'panel')!;
  assert.equal(grid.name, 'Utility Grid');
  assert.equal(grid.derivedEnergy, true);
  assert.equal(read(grid, model)!.energy.activePower, 2_500_000, 'utility delivering is import');
  assert.equal(panel.name, 'SPAN Panel');
  assert.equal(read(panel, model)!.energy.activePower, 3_200_000);
  assert.ok(!specs.some(spec => spec.role === 'feedthrough'), 'drifting feed-through hidden');
  assert.ok(specs.filter(spec => spec.derivedEnergy).map(spec => spec.role).sort().join() === 'battery,grid,solar');

  const swapped = discover(model, { wholeHomeMeter: 'panel' });
  assert.equal(swapped.find(spec => spec.role === 'grid')!.name, 'SPAN Panel');
});

test('downstream lugs report no current: theirs is a copy of the service entrance', () => {
  const model = gatewayPanel();
  const feed = discover(model, { feedthrough: 'always' }).find(spec => spec.role === 'feedthrough')!;
  assert.equal(read(feed, model)!.energy.activeCurrent, null);
});
