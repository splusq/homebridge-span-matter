// eBus -> Matter.
//
// SPAN's eBus `meter` capability and Matter's ElectricalPowerMeasurement /
// ElectricalEnergyMeasurement clusters describe the same thing, so the mapping
// is units and one sign:
//
//   eBus (W, Wh, V, A)          Matter (mW, mWh, mV, mA)
//   meter/active-power      ->  activePower        x1000
//   meter/imported-energy   ->  cumulativeEnergy*  x1000
//   meter/voltage-a/b       ->  voltage            x1000
//   meter/current(-a/-b)    ->  activeCurrent      x1000
//
// Matter measures from the device: positive power and "imported" energy are
// consumed by it. eBus measures from the panel busbar. For the grid lugs the
// two frames agree (the home is the device, the utility the source); for a
// circuit they are mirror images, so a circuit's sign flips and its imported
// and exported counters swap. See SPAN's power-and-energy-conventions.md.

import type { EbusDevice, EbusModel } from './span/ebus.js';

/**
 * `grid` is the whole-home meter Apple Home uses for "All Home". `panel` is
 * the upstream lugs when a DER (a Powerwall gateway, say) sits between them
 * and the utility, so they measure the panel's load rather than the grid.
 */
export type Role = 'grid' | 'panel' | 'feedthrough' | 'circuit' | 'solar' | 'battery';

export interface EndpointSpec {
  /** Stable key; seeds the Matter UUID, so changing it re-creates the device in Home. */
  key: string;
  role: Role;
  name: string;
  /** eBus device the power and energy come from. */
  sourceId: string;
  /** How the source is read: a circuit or lugs meter, a BESS meter, or the panel's power-flows. */
  source: 'circuit' | 'lugs' | 'bess' | 'power-flows';
  /** For power-flows: which flow. */
  flow?: 'grid' | 'pv';
  /** BESS device holding state of charge, for a battery. */
  socId?: string;
  /** For a circuit: the eBus class of the device it feeds (pv, bess, evse). */
  feeds?: string;
  relayControllable: boolean;
  hasEnergy: boolean;
  /**
   * The source has no energy counters, so energy is integrated from power by
   * the platform. Only set where hasEnergy is true.
   */
  derivedEnergy?: boolean;
  serialNumber: string;
  model: string;
  firmwareVersion?: string;
}

export interface EnergyReading {
  activePower: number | null;
  voltage?: number | null;
  activeCurrent?: number | null;
  imported?: number | null;
  exported?: number | null;
}

export interface BatteryReading {
  /** Matter PowerSource batPercentRemaining: half-percent units, 0-200. */
  batPercentRemaining: number | null;
  /** 0 ok, 1 warning, 2 critical. */
  batChargeLevel: number;
  /** 0 unknown, 1 charging, 2 at full charge, 3 not charging. */
  batChargeState: number;
}

export interface Reading {
  energy: EnergyReading;
  battery?: BatteryReading;
  relayClosed?: boolean;
}

export interface DiscoverOptions {
  /**
   * When set, the only plain circuits published, by name or eBus id. Solar
   * and battery circuits are not affected; exclude them by name.
   */
  includeCircuits?: string[];
  /** Circuit names or eBus ids to leave out. */
  excludeCircuits?: string[];
  /** Publish the downstream (feed-through) lugs; by default only when they have carried energy. */
  feedthrough?: 'auto' | 'always' | 'never';
  /**
   * Keys already published. An `auto` feed-through stays once shown, so its
   * drifting counters cannot add and remove it from Home.
   */
  publishedKeys?: ReadonlySet<string>;
  /**
   * What carries the ElectricalMeter tag when a DER feeds the upstream lugs:
   * the utility connection from power-flows (default), or the panel's lugs.
   */
  wholeHomeMeter?: 'utility' | 'panel';
}

const MATTER_TEXT_MAX = 32;

const milli = (value: number | undefined): number | null =>
  value === undefined ? null : Math.round(value * 1000);

const text = (value: string): string => value.length > MATTER_TEXT_MAX ? value.slice(0, MATTER_TEXT_MAX) : value;

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();

export function discover(model: EbusModel, options: DiscoverOptions = {}): EndpointSpec[] {
  const panel = model.root;
  if (!panel) {
    return [];
  }
  const serial = panel.string('info', 'serial-number') ?? panel.id;
  const panelModel = panel.string('info', 'model');
  const firmwareVersion = panel.string('info', 'firmware-version');
  const devices = model.tree();
  const byType = (type: string) => devices.filter(device => device.type === type);
  const included = new Set((options.includeCircuits ?? []).map(entry => entry.toLowerCase()));
  const excluded = new Set((options.excludeCircuits ?? []).map(entry => entry.toLowerCase()));
  const specs: EndpointSpec[] = [];
  const base = {
    relayControllable: false,
    hasEnergy: true,
    model: text(panelModel ? `SPAN ${titleCase(panelModel.replace(/_/g, ' '))}` : 'SPAN Panel'),
    firmwareVersion,
  };

  const upstream = byType('lugs').find(lugs => lugs.string('info', 'direction') !== 'DOWNSTREAM');
  const downstream = byType('lugs').find(lugs => lugs.string('info', 'direction') === 'DOWNSTREAM');
  // A DER on the supply side means the lugs see the panel's load, and only
  // the panel's derived power-flows sees the utility.
  const derUpstream = Boolean(upstream?.string('connection', 'fed-by-device-type'));
  const utilityIsMeter = derUpstream && options.wholeHomeMeter !== 'panel';

  if (upstream) {
    specs.push({
      ...base,
      key: upstream.id,
      role: utilityIsMeter ? 'panel' : 'grid',
      name: derUpstream ? 'SPAN Panel' : 'SPAN Grid',
      sourceId: upstream.id,
      source: 'lugs',
      serialNumber: text(`${serial}-${derUpstream ? 'panel' : 'grid'}`),
    });
  }
  if (derUpstream) {
    specs.push({
      ...base,
      key: `${panel.id}-utility`,
      role: utilityIsMeter ? 'grid' : 'panel',
      name: 'Utility Grid',
      sourceId: panel.id,
      source: 'power-flows',
      flow: 'grid',
      derivedEnergy: true,
      serialNumber: text(`${serial}-utility`),
    });
  }
  if (downstream && options.feedthrough !== 'never') {
    // The downstream lugs' counters are derived and drift in both directions
    // even with nothing connected; a real sub-panel shows a clear net import.
    const imported = downstream.number('meter', 'imported-energy') ?? 0;
    const exported = downstream.number('meter', 'exported-energy') ?? 0;
    const reference = upstream?.number('meter', 'imported-energy') ?? 0;
    const net = imported - exported;
    if (options.feedthrough === 'always' || options.publishedKeys?.has(downstream.id)
      || (net > 1000 && net > 0.05 * reference)) {
      specs.push({
        ...base,
        key: downstream.id,
        role: 'feedthrough',
        name: 'SPAN Feed-through',
        sourceId: downstream.id,
        source: 'lugs',
        serialNumber: text(`${serial}-feed`),
      });
    }
  }

  const bess = byType('bess')[0];
  const pv = byType('pv')[0];
  let solarFromCircuit = false;
  let batteryFromCircuit = false;

  for (const circuit of byType('circuit')) {
    const name = circuit.string('info', 'name') ?? `Circuit ${circuit.string('info', 'spaces') ?? circuit.id}`;
    const feeds = circuit.string('connection', 'feeds-device-type')?.replace(/^energy\.ebus\.device\./, '');
    const feedsId = circuit.string('connection', 'feeds-device-id');
    // A DER on a circuit is that circuit, published or not: excluding it must
    // not bring it back through the power-flows fallback.
    solarFromCircuit ||= feeds === 'pv';
    batteryFromCircuit ||= feeds === 'bess';
    if (excluded.has(name.toLowerCase()) || excluded.has(circuit.id.toLowerCase())) {
      continue;
    }
    if (included.size && feeds !== 'pv' && feeds !== 'bess'
      && !included.has(name.toLowerCase()) && !included.has(circuit.id.toLowerCase())) {
      continue;
    }
    const spec: EndpointSpec = {
      ...base,
      key: circuit.id,
      role: 'circuit',
      name: text(name),
      sourceId: circuit.id,
      source: 'circuit',
      feeds,
      relayControllable: circuit.boolean('switch', 'relay-controllable') === true,
      serialNumber: text(`${serial}-${circuit.string('info', 'spaces') ?? circuit.id.slice(0, 8)}`),
    };
    if (feeds === 'pv') {
      spec.role = 'solar';
    } else if (feeds === 'bess') {
      spec.role = 'battery';
      spec.socId = feedsId ?? bess?.id;
    }
    specs.push(spec);
  }

  // DERs on the supply side of the panel have no circuit, only the panel's
  // derived power-flows (or, for a battery, its own meter). Those carry no
  // energy counters, so energy is integrated from power.
  if (bess && !batteryFromCircuit) {
    specs.push({
      ...base,
      key: bess.id,
      role: 'battery',
      name: text(bess.string('info', 'model') ?? 'Battery'),
      sourceId: bess.id,
      source: 'bess',
      socId: bess.id,
      derivedEnergy: true,
      model: text(bess.string('info', 'model') ?? 'Battery'),
      firmwareVersion: bess.string('info', 'firmware-version'),
      serialNumber: text(bess.string('info', 'serial-number') ?? `${serial}-battery`),
    });
  }
  if (pv && !solarFromCircuit) {
    specs.push({
      ...base,
      key: pv.id,
      role: 'solar',
      name: 'Solar',
      sourceId: panel.id,
      source: 'power-flows',
      flow: 'pv',
      derivedEnergy: true,
      model: text(pv.string('info', 'model') ?? 'Solar'),
      firmwareVersion: pv.string('info', 'firmware-version'),
      serialNumber: text(pv.string('info', 'serial-number') ?? `${serial}-solar`),
    });
  }
  return specs;
}

/** Sign the magnitude of a current the way Matter signs power: positive when consumed. */
function signedCurrent(amps: number | undefined, milliwatts: number | null): number | null {
  if (amps === undefined) {
    return null;
  }
  const magnitude = Math.round(Math.abs(amps) * 1000);
  return milliwatts !== null && milliwatts < 0 ? -magnitude : magnitude;
}

function panelVoltage(panel: EbusDevice | undefined, poles: number | undefined): number | undefined {
  const a = panel?.number('meter', 'voltage-a');
  const b = panel?.number('meter', 'voltage-b');
  if (a === undefined || b === undefined) {
    return a ?? b;
  }
  // Split phase: a two-pole load sees line to line, a single pole one leg.
  return (poles ?? 1) >= 2 ? a + b : (a + b) / 2;
}

function readCircuit(circuit: EbusDevice, panel: EbusDevice | undefined): EnergyReading {
  const power = circuit.number('meter', 'active-power');
  const activePower = milli(power === undefined ? undefined : -power);
  return {
    activePower,
    voltage: milli(panelVoltage(panel, circuit.number('breaker', 'poles'))),
    activeCurrent: signedCurrent(circuit.number('meter', 'current'), activePower),
    imported: milli(circuit.number('meter', 'exported-energy')),
    exported: milli(circuit.number('meter', 'imported-energy')),
  };
}

function readLugs(lugs: EbusDevice, panel: EbusDevice | undefined): EnergyReading {
  const activePower = milli(lugs.number('meter', 'active-power'));
  // Both lugs republish the service entrance's leg currents; they only
  // describe the upstream side.
  const upstream = lugs.string('info', 'direction') !== 'DOWNSTREAM';
  const a = upstream ? lugs.number('meter', 'current-a') : undefined;
  const b = upstream ? lugs.number('meter', 'current-b') : undefined;
  // The legs are in series through a 240 V load and in parallel for 120 V
  // ones; their mean, against line-to-line voltage, gives the power.
  const current = a !== undefined && b !== undefined ? (Math.abs(a) + Math.abs(b)) / 2 : a ?? b;
  return {
    activePower,
    voltage: milli(panelVoltage(panel, 2)),
    activeCurrent: signedCurrent(current, activePower),
    imported: milli(lugs.number('meter', 'imported-energy')),
    exported: milli(lugs.number('meter', 'exported-energy')),
  };
}

function readBattery(bess: EbusDevice | undefined, energy: EnergyReading): BatteryReading {
  const soc = bess?.number('soc', 'soc');
  const watts = energy.activePower === null ? 0 : energy.activePower / 1000;
  let batChargeState = 0;
  if (soc !== undefined && soc >= 99.5) {
    batChargeState = 2;
  } else if (watts > 25) {
    batChargeState = 1;
  } else if (energy.activePower !== null) {
    batChargeState = 3;
  }
  return {
    batPercentRemaining: soc === undefined ? null : Math.max(0, Math.min(200, Math.round(soc * 2))),
    batChargeLevel: soc === undefined || soc >= 10 ? 0 : soc >= 5 ? 1 : 2,
    batChargeState,
  };
}

export function read(spec: EndpointSpec, model: EbusModel): Reading | undefined {
  const panel = model.root;
  const source = model.devices.get(spec.sourceId);
  if (!source) {
    return undefined;
  }
  let energy: EnergyReading;
  switch (spec.source) {
    case 'circuit':
      energy = readCircuit(source, panel);
      break;
    case 'lugs':
      energy = readLugs(source, panel);
      break;
    case 'bess': {
      // The BESS meter is positive while discharging: the battery is producing.
      const power = source.number('meter', 'active-power');
      energy = { activePower: milli(power === undefined ? undefined : -power) };
      break;
    }
    case 'power-flows': {
      // power-flows signs toward the named entity. pv is negative while
      // generating, which is how Matter signs a producer; grid is positive
      // while exporting, the opposite of a meter's import.
      const flow = source.number('power-flows', spec.flow ?? 'pv');
      energy = { activePower: milli(flow === undefined ? undefined : spec.flow === 'grid' ? -flow : flow) };
      break;
    }
  }
  const reading: Reading = { energy };
  if (spec.role === 'battery') {
    reading.battery = readBattery(spec.socId ? model.devices.get(spec.socId) : undefined, energy);
  }
  if (spec.source === 'circuit') {
    const relay = source.string('switch', 'relay');
    reading.relayClosed = relay === undefined ? undefined : relay !== 'OPEN';
  }
  return reading;
}
