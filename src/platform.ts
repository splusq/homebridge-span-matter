import { join } from 'node:path';
import type {
  API,
  DynamicPlatformPlugin,
  Logging,
  MatterAPI,
  MatterAccessory,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { EnergyIntegrator } from './integrator.js';
import { discover, read, type EndpointSpec, type Reading } from './mapping.js';
import { CredentialStore, getCaCertificate, obtainCredentials, type SpanCredentials } from './span/auth.js';
import { EbusClient } from './span/ebus.js';

export const PLUGIN_NAME = 'homebridge-span-matter';
export const PLATFORM_NAME = 'SpanMatter';

// Matter device type ids. Apple Home takes an endpoint that also declares
// ElectricalMeter as the whole-home meter for "All Home"; keeping
// ElectricalSensor as its base type lets Homebridge restore it from cache.
const ELECTRICAL_METER = 0x0514;
const ELECTRICAL_SENSOR = 0x0510;

export interface SpanMatterConfig extends PlatformConfig {
  host?: string;
  hopPassphrase?: string;
  circuits?: {
    mode?: 'sensor' | 'outlet';
    allowRelayControl?: boolean;
    exclude?: string[];
  };
  feedthrough?: 'auto' | 'always' | 'never';
  wholeHomeMeter?: 'utility' | 'panel';
  batteryLevel?: boolean;
  batteryMode?: 'outlet' | 'sensor';
  updateIntervalSeconds?: number;
  powerDeadbandWatts?: number;
}

interface Published {
  spec: EndpointSpec;
  accessory: MatterAccessory;
  pushed: {
    power?: Reading['energy'];
    energy?: { imported?: number | null; exported?: number | null; at: number };
    battery?: string;
    onOff?: boolean;
  };
}

const energyStruct = (milliwattHours: number | null | undefined) =>
  milliwattHours === null || milliwattHours === undefined ? null : { energy: milliwattHours };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class SpanMatterPlatform implements DynamicPlatformPlugin {
  private readonly config: SpanMatterConfig;
  private readonly cached = new Map<string, MatterAccessory>();
  private readonly published = new Map<string, Published>();
  /** UUIDs registered with Homebridge by this process. */
  private readonly registered = new Set<string>();
  /** eBus devices seen at the last sync; anything else is new. */
  private knownDevices = new Set<string>();
  private ebus?: EbusClient;
  private integrator = new EnergyIntegrator();
  private lastSave = 0;
  private flushTimer?: NodeJS.Timeout;
  private resyncTimer?: NodeJS.Timeout;
  private syncing = false;
  private stopped = false;

  constructor(private readonly log: Logging, config: PlatformConfig, private readonly api: API) {
    this.config = config as SpanMatterConfig;
    api.on('didFinishLaunching', () => {
      this.start().catch(error => this.log.error(`SPAN bridge failed to start: ${(error as Error).stack ?? error}`));
    });
    api.on('shutdown', () => void this.stop());
  }

  configureAccessory(_accessory: PlatformAccessory): void {
    // This plugin publishes Matter accessories only.
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private get matter(): MatterAPI {
    return this.api.matter!;
  }

  private async start(): Promise<void> {
    if (!this.api.matter) {
      this.log.error('Matter is not enabled on the bridge running this plugin. Enable Matter for it in the Homebridge UI (Homebridge 2.4 or later) and restart.');
      return;
    }
    const host = this.config.host?.trim();
    if (!host) {
      this.log.error('Set "host" to the SPAN panel\'s address, for example span-nj-1234-abcde.local');
      return;
    }

    const store = new CredentialStore(join(this.api.user.storagePath(), 'span-matter'));
    let credentials: SpanCredentials | undefined;
    while (!credentials && !this.stopped) {
      try {
        credentials = await obtainCredentials({ host, store, hopPassphrase: this.config.hopPassphrase, log: this.log });
      } catch (error) {
        this.log.warn(`Could not reach or register with the SPAN panel at ${host}: ${(error as Error).message}. Retrying in 30 s.`);
        await sleep(30_000);
      }
    }
    if (!credentials) {
      return;
    }

    const interval = Math.max(0.5, this.config.updateIntervalSeconds ?? 1) * 1000;
    this.integrator = new EnergyIntegrator(
      join(this.api.user.storagePath(), 'span-matter', `${credentials.serialNumber.toLowerCase()}-energy.json`),
      Math.max(10_000, 3 * interval),
    );
    await this.integrator.load();

    const ca = await getCaCertificate(host);
    const ebus = new EbusClient(credentials.serialNumber);
    this.ebus = ebus;
    ebus.on('connect', () => this.log.info(`Connected to SPAN eBus on ${host}:${credentials.ebusBrokerMqttsPort}`));
    ebus.on('offline', () => this.log.warn('SPAN eBus connection lost, reconnecting'));
    ebus.on('error', error => {
      const message = error.message;
      if (/not authorized|bad user ?name or password/i.test(message)) {
        this.log.error('The SPAN broker rejected the stored credentials (was the passphrase regenerated?). They have been cleared; restart Homebridge to register again.');
        void store.forget(credentials.serialNumber);
        void ebus.close();
        return;
      }
      this.log.debug(`SPAN eBus: ${message}`);
    });
    ebus.on('device', device => {
      if (this.published.size && !this.isKnown(device.id)) {
        this.scheduleResync(`new device ${device.id}`);
      }
    });
    ebus.on('value', (device, capability, property) => {
      if (capability === 'info' && property === 'name' && this.published.size) {
        this.scheduleResync(`circuit ${device.id} renamed`);
      }
    });
    ebus.connect({
      host: new URL(`http://${host}`).hostname,
      port: credentials.ebusBrokerMqttsPort,
      username: credentials.ebusBrokerUsername,
      password: credentials.ebusBrokerPassword,
      ca,
      // The broker's certificate names the panel's .local host and its IPs;
      // check it against the .local name even when `host` is an address.
      servername: credentials.hostname,
    });

    await this.waitForTree(ebus);
    await this.sync();

    this.flushTimer = setInterval(() => void this.flush(), interval);
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.flushTimer);
    clearTimeout(this.resyncTimer);
    await this.integrator.save().catch(() => undefined);
    await this.ebus?.close();
  }

  // The panel replays every description after a reconnect; only a device
  // missing from the last sync is new.
  private isKnown(deviceId: string): boolean {
    return this.knownDevices.has(deviceId);
  }

  /**
   * Waits for the retained replay to describe the whole device tree. Values
   * stream continuously, so "quiet" means no new device description.
   */
  private async waitForTree(ebus: EbusClient): Promise<void> {
    const deadline = Date.now() + 60_000;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    ebus.on('device', touch);
    try {
      while (Date.now() < deadline && !(ebus.isComplete() && Date.now() - last > 1500)) {
        await sleep(250);
      }
    } finally {
      ebus.off('device', touch);
    }
    if (!ebus.isComplete()) {
      this.log.warn('The SPAN device tree was still incomplete after 60 s; publishing what has arrived');
    }
  }

  private scheduleResync(reason: string): void {
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.log.info(`Updating devices: ${reason}`);
      void this.sync();
    }, 10_000);
  }

  // An outlet gets its own UUID, so its own endpoint. Re-using a sensor's
  // endpoint under a different device type leaves the Home app showing
  // neither (found by homebridge-sunsynk on iOS 27).
  private uuid(spec: EndpointSpec): string {
    return this.matter.uuid.generate(`${PLUGIN_NAME}:${spec.key}${this.mode(spec) === 'outlet' ? ':outlet' : ''}`);
  }

  /**
   * Apple Home gives an Electrical Sensor no room tile, and shows one that
   * also carries a battery as "Not Supported". An outlet is a type it
   * renders: a tile with live power, and the battery level in its details.
   */
  private mode(spec: EndpointSpec): 'sensor' | 'outlet' {
    if (spec.role === 'circuit') {
      return this.config.circuits?.mode === 'outlet' ? 'outlet' : 'sensor';
    }
    if (spec.role === 'battery') {
      return this.config.batteryMode === 'sensor' ? 'sensor' : 'outlet';
    }
    return 'sensor';
  }

  private buildAccessory(spec: EndpointSpec): MatterAccessory {
    const matter = this.matter;
    const reading = read(spec, this.ebus!);
    const energy = reading?.energy && spec.derivedEnergy
      ? { ...reading.energy, ...this.integrator.read(spec.key) }
      : reading?.energy;
    const uuid = this.uuid(spec);

    const clusters: Record<string, Record<string, unknown>> = {
      electricalPowerMeasurement: {
        activePower: energy?.activePower ?? null,
        ...(spec.source === 'circuit' || spec.source === 'lugs'
          ? { voltage: energy?.voltage ?? null, activeCurrent: energy?.activeCurrent ?? null }
          : {}),
      },
    };
    if (spec.hasEnergy) {
      clusters.electricalEnergyMeasurement = {
        cumulativeEnergyImported: energyStruct(energy?.imported),
        cumulativeEnergyExported: energyStruct(energy?.exported),
      };
    }
    if (spec.role === 'grid') {
      clusters.descriptor = {
        deviceTypeList: [
          { deviceType: ELECTRICAL_METER, revision: 1 },
          { deviceType: ELECTRICAL_SENSOR, revision: 1 },
        ],
      };
    }
    // A sensor with a battery is "Not Supported" in Apple Home, so a battery
    // left as a sensor gets no level.
    if (spec.role === 'battery' && this.config.batteryLevel !== false && this.mode(spec) === 'outlet') {
      const battery = reading?.battery;
      clusters.powerSource = {
        status: 1,
        order: 0,
        description: 'Battery',
        batPercentRemaining: battery?.batPercentRemaining ?? null,
        batChargeLevel: battery?.batChargeLevel ?? 0,
        batChargeState: battery?.batChargeState ?? 0,
        batReplaceability: 1,
        batFunctionalWhileCharging: true,
      };
    }

    const accessory: MatterAccessory = {
      UUID: uuid,
      displayName: spec.name,
      deviceType: matter.deviceTypes.ElectricalSensor,
      serialNumber: spec.serialNumber,
      manufacturer: 'SPAN',
      model: spec.model,
      firmwareRevision: spec.firmwareVersion,
      context: { key: spec.key, role: spec.role, mode: this.mode(spec) },
      clusters: clusters as MatterAccessory['clusters'],
    };

    if (this.mode(spec) === 'outlet') {
      accessory.deviceType = matter.deviceTypes.OnOffOutlet;
      clusters.onOff = { onOff: reading?.relayClosed ?? true };
      const command = (on: boolean) => async () => {
        // Only a plain circuit switches its relay: never a battery's breaker.
        if (spec.role === 'circuit' && this.config.circuits?.allowRelayControl && spec.relayControllable) {
          this.log.info(`${spec.name}: ${on ? 'closing' : 'opening'} circuit relay`);
          await this.ebus!.set(spec.sourceId, 'switch', 'relay', on ? 'CLOSED' : 'OPEN');
          return;
        }
        // Not allowed to switch it: put the tile back the way the relay is.
        // Refusing the command instead logs a stack trace on every tap.
        setTimeout(() => {
          const closed = read(spec, this.ebus!)?.relayClosed ?? true;
          void matter.updateAccessoryState(uuid, 'onOff', { onOff: closed }).catch(() => undefined);
        }, 500);
      };
      accessory.handlers = {
        onOff: {
          on: command(true),
          off: command(false),
        },
      };
    }
    return accessory;
  }

  private async sync(): Promise<void> {
    if (this.syncing || !this.ebus) {
      return;
    }
    this.syncing = true;
    try {
      const matter = this.matter;
      const specs = discover(this.ebus, {
        excludeCircuits: this.config.circuits?.exclude,
        feedthrough: this.config.feedthrough,
        wholeHomeMeter: this.config.wholeHomeMeter,
      });
      this.knownDevices = new Set(this.ebus.tree().map(device => device.id));
      const accessories = specs.map(spec => this.buildAccessory(spec));
      const wanted = new Set(accessories.map(accessory => accessory.UUID));

      // A device whose type changed (sensor <-> outlet) must be re-created:
      // its cached endpoint keeps the old clusters.
      const modes = new Map(accessories.map(accessory => [accessory.UUID, accessory.context.mode]));
      const stale = [...this.cached.values()].filter(cached => !wanted.has(cached.UUID)
        || (cached.context?.mode ?? 'sensor') !== modes.get(cached.UUID));
      if (stale.length) {
        this.log.info(`Removing ${stale.length} device(s) no longer on the panel or whose type changed`);
        await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
        stale.forEach(accessory => {
          this.cached.delete(accessory.UUID);
          this.registered.delete(accessory.UUID);
        });
      }
      for (const [uuid] of this.published) {
        if (!wanted.has(uuid)) {
          this.published.delete(uuid);
        }
      }

      // Unlike HAP, every accessory is registered on every start: handlers
      // cannot be cached. A resync registers only what is new (Homebridge
      // rejects a second registration) and refreshes names.
      const renamed = accessories.filter(accessory => {
        const cached = this.cached.get(accessory.UUID);
        return cached && cached.displayName !== accessory.displayName;
      });
      const fresh = accessories.filter(accessory => !this.registered.has(accessory.UUID));
      if (fresh.length) {
        await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, fresh);
        fresh.forEach(accessory => this.registered.add(accessory.UUID));
      }
      if (renamed.length) {
        await matter.updatePlatformAccessories(renamed);
      }
      accessories.forEach(accessory => this.cached.set(accessory.UUID, accessory));

      if (!(await this.waitUntilRegistered(fresh.map(accessory => accessory.UUID)))) {
        this.log.warn('Some devices were slow to register; their first updates may be late');
      }

      const counts = specs.reduce<Record<string, number>>((all, spec) => ({ ...all, [spec.role]: (all[spec.role] ?? 0) + 1 }), {});
      this.log.info(`Publishing ${specs.length} SPAN device(s): ${Object.entries(counts).map(([role, n]) => `${n} ${role}`).join(', ')}`);

      specs.forEach((spec, index) => {
        const uuid = accessories[index]!.UUID;
        const previous = this.published.get(uuid);
        this.published.set(uuid, { spec, accessory: accessories[index]!, pushed: previous?.pushed ?? {} });
      });
      // Restored accessories keep their cached state, so push everything now.
      this.published.forEach(entry => { entry.pushed = {}; });
      await this.flush();
    } catch (error) {
      this.log.error(`Could not publish SPAN devices: ${(error as Error).stack ?? error}`);
    } finally {
      this.syncing = false;
    }
  }

  // registerPlatformAccessories() can resolve before the endpoints exist on a
  // child bridge, and state pushed before then is dropped.
  private async waitUntilRegistered(uuids: string[], timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let pending = uuids;
    while (pending.length && Date.now() < deadline) {
      const states = await Promise.all(pending.map(uuid =>
        Promise.resolve(this.matter.getAccessoryState(uuid, 'electricalPowerMeasurement')).catch(() => undefined)));
      pending = pending.filter((_, index) => states[index] === undefined);
      if (pending.length) {
        await sleep(250);
      }
    }
    return pending.length === 0;
  }

  private async flush(): Promise<void> {
    if (!this.ebus || this.syncing && this.published.size === 0) {
      return;
    }
    const deadband = Math.max(0, this.config.powerDeadbandWatts ?? 1) * 1000;
    const now = Date.now();
    const updates: Promise<unknown>[] = [];

    for (const [uuid, entry] of this.published) {
      const reading = read(entry.spec, this.ebus);
      if (!reading) {
        continue;
      }
      const { energy } = reading;
      if (entry.spec.derivedEnergy) {
        Object.assign(energy, this.integrator.sample(entry.spec.key, energy.activePower, now));
      }
      const last = entry.pushed;
      const update = (cluster: string, state: Record<string, unknown>) => updates.push(
        this.matter.updateAccessoryState(uuid, cluster, state).catch(error =>
          this.log.debug(`${entry.spec.name}: ${cluster} update failed: ${(error as Error).message}`)));

      const changed = (now: number | null | undefined, then: number | null | undefined, threshold: number) =>
        (now ?? null) !== (then ?? null) && (now === null || now === undefined || then === null || then === undefined || Math.abs(now - then) >= threshold);
      if (!last.power
        || changed(energy.activePower, last.power.activePower, deadband)
        || changed(energy.voltage, last.power.voltage, 500)
        || changed(energy.activeCurrent, last.power.activeCurrent, 50)) {
        const state: Record<string, unknown> = { activePower: energy.activePower };
        if ('voltage' in energy) {
          state.voltage = energy.voltage;
          state.activeCurrent = energy.activeCurrent;
        }
        update('electricalPowerMeasurement', state);
        last.power = energy;
      }

      // Counters tick every second under load; whole watt hours are plenty.
      if (entry.spec.hasEnergy && (!last.energy
        || changed(energy.imported, last.energy.imported, 1000)
        || changed(energy.exported, last.energy.exported, 1000)
        || (now - last.energy.at > 60_000 && (energy.imported !== last.energy.imported || energy.exported !== last.energy.exported)))) {
        update('electricalEnergyMeasurement', {
          cumulativeEnergyImported: energyStruct(energy.imported),
          cumulativeEnergyExported: energyStruct(energy.exported),
        });
        last.energy = { imported: energy.imported, exported: energy.exported, at: now };
      }

      if (reading.battery && entry.accessory.clusters?.powerSource) {
        const key = JSON.stringify(reading.battery);
        if (key !== last.battery) {
          update('powerSource', { ...reading.battery });
          last.battery = key;
        }
      }

      if (entry.accessory.clusters?.onOff && reading.relayClosed !== undefined && reading.relayClosed !== last.onOff) {
        update('onOff', { onOff: reading.relayClosed });
        last.onOff = reading.relayClosed;
      }
    }
    await Promise.all(updates);
    if (now - this.lastSave > 60_000) {
      this.lastSave = now;
      await this.integrator.save().catch(error => this.log.warn(`Could not save energy totals: ${(error as Error).message}`));
    }
  }
}
