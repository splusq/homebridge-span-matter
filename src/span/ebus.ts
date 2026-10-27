// The panel's eBus broker: Homie 5 over MQTTS.
//
// Every device publishes a retained `$description` (its capabilities and, for
// parents, its children) and one retained topic per property, so subscribing
// to `ebus/5/#` replays the whole panel and then streams changes.

import { EventEmitter } from 'node:events';
import mqtt, { type MqttClient } from 'mqtt';

export const HOMIE_PREFIX = 'ebus/5';

export type DeviceType =
  | 'distribution-enclosure'
  | 'lugs'
  | 'circuit'
  | 'bess'
  | 'pv'
  | 'evse'
  | 'mid'
  | string;

export interface HomieProperty {
  name?: string;
  datatype: 'integer' | 'float' | 'boolean' | 'string' | 'enum' | 'color' | 'datetime' | 'duration' | 'json';
  format?: string;
  settable?: boolean;
  retained?: boolean;
  unit?: string;
}

export interface HomieDescription {
  homie?: string;
  version?: number;
  name?: string;
  type?: string;
  children?: string[];
  parent?: string;
  root?: string;
  nodes?: Record<string, { name?: string; type?: string; properties?: Record<string, HomieProperty> }>;
}

export type PropertyValue = number | boolean | string | undefined;

export class EbusDevice {
  state = 'unknown';
  description?: HomieDescription;
  readonly values = new Map<string, PropertyValue>();

  constructor(readonly id: string) {}

  /** Short class name: `circuit`, `lugs`, `bess`, ... */
  get type(): DeviceType | undefined {
    return this.description?.type?.replace(/^energy\.ebus\.device\./, '');
  }

  get children(): string[] {
    return this.description?.children ?? [];
  }

  property(capability: string, property: string): HomieProperty | undefined {
    return this.description?.nodes?.[capability]?.properties?.[property];
  }

  get(capability: string, property: string): PropertyValue {
    return this.values.get(`${capability}/${property}`);
  }

  number(capability: string, property: string): number | undefined {
    const value = this.get(capability, property);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  string(capability: string, property: string): string | undefined {
    const value = this.get(capability, property);
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  boolean(capability: string, property: string): boolean | undefined {
    const value = this.get(capability, property);
    return typeof value === 'boolean' ? value : undefined;
  }
}

export function parseValue(raw: string, schema: HomieProperty | undefined): PropertyValue {
  if (raw === '') {
    return undefined;
  }
  switch (schema?.datatype) {
    case 'integer':
    case 'float': {
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    }
    case 'boolean':
      return raw === 'true';
    case undefined: {
      // A value can arrive before its device's $description. Keep numbers as
      // numbers; the description, when it comes, re-parses the raw values.
      if (raw === 'true' || raw === 'false') {
        return raw === 'true';
      }
      const value = Number(raw);
      return raw.trim() !== '' && Number.isFinite(value) ? value : raw;
    }
    default:
      return raw;
  }
}

export interface EbusEvents {
  device: [device: EbusDevice];
  value: [device: EbusDevice, capability: string, property: string, value: PropertyValue];
  state: [device: EbusDevice];
  connect: [];
  offline: [];
  error: [error: Error];
}

/**
 * Holds the panel's device tree. `ingest` takes raw topic/payload pairs, so the
 * model can be driven by the broker or by a recording in tests.
 */
export class EbusModel extends EventEmitter<EbusEvents> {
  readonly devices = new Map<string, EbusDevice>();
  private readonly raw = new Map<string, string>();

  constructor(readonly rootId: string) {
    super();
  }

  get root(): EbusDevice | undefined {
    return this.devices.get(this.rootId);
  }

  private device(id: string): EbusDevice {
    let device = this.devices.get(id);
    if (!device) {
      device = new EbusDevice(id);
      this.devices.set(id, device);
    }
    return device;
  }

  /** Devices reachable from the panel, walking `children` recursively. */
  tree(): EbusDevice[] {
    const seen = new Set<string>();
    const out: EbusDevice[] = [];
    const walk = (id: string) => {
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      const device = this.devices.get(id);
      if (!device) {
        return;
      }
      out.push(device);
      device.children.forEach(walk);
    };
    walk(this.rootId);
    return out;
  }

  /** True once every device in the tree has published its description. */
  isComplete(): boolean {
    const root = this.root;
    if (!root?.description) {
      return false;
    }
    const pending = [...root.children];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const device = this.devices.get(id);
      if (!device?.description) {
        return false;
      }
      pending.push(...device.children);
    }
    return true;
  }

  ingest(topic: string, payload: string): void {
    if (!topic.startsWith(`${HOMIE_PREFIX}/`)) {
      return;
    }
    const [deviceId, first, second, ...rest] = topic.slice(HOMIE_PREFIX.length + 1).split('/');
    if (!deviceId || !first || rest.length) {
      return;
    }
    const device = this.device(deviceId);

    if (first === '$state' && second === undefined) {
      device.state = payload;
      this.emit('state', device);
      return;
    }
    if (first === '$description' && second === undefined) {
      if (!payload) {
        return;
      }
      try {
        device.description = JSON.parse(payload) as HomieDescription;
      } catch {
        return;
      }
      for (const [key, raw] of this.raw) {
        if (key.startsWith(`${deviceId}/`)) {
          const [, capability, property] = key.split('/');
          device.values.set(`${capability}/${property}`, parseValue(raw, device.property(capability!, property!)));
        }
      }
      this.emit('device', device);
      return;
    }
    if (first.startsWith('$') || second === undefined || second.startsWith('$')) {
      return;
    }

    this.raw.set(`${deviceId}/${first}/${second}`, payload);
    const value = parseValue(payload, device.property(first, second));
    if (device.values.get(`${first}/${second}`) === value) {
      return;
    }
    device.values.set(`${first}/${second}`, value);
    this.emit('value', device, first, second, value);
  }
}

export interface EbusConnectOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  ca: string;
  /** Name the TLS certificate is checked against; defaults to `host`. */
  servername?: string;
}

export class EbusClient extends EbusModel {
  private client?: MqttClient;

  connect(options: EbusConnectOptions): void {
    const client = mqtt.connect({
      protocol: 'mqtts',
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      ca: options.ca,
      servername: options.servername ?? options.host,
      rejectUnauthorized: true,
      clientId: `hb-span-matter-${Math.random().toString(16).slice(2, 10)}`,
      reconnectPeriod: 5000,
      connectTimeout: 15_000,
      keepalive: 30,
    });
    this.client = client;

    client.on('connect', () => {
      client.subscribe(`${HOMIE_PREFIX}/#`, { qos: 0 }, error => {
        if (error) {
          this.emit('error', error);
        }
      });
      this.emit('connect');
    });
    client.on('message', (topic, payload) => this.ingest(topic, payload.toString('utf8')));
    client.on('offline', () => this.emit('offline'));
    client.on('error', error => this.emit('error', error));
  }

  async set(deviceId: string, capability: string, property: string, value: string): Promise<void> {
    if (!this.client) {
      throw new Error('Not connected to the SPAN eBus broker');
    }
    await this.client.publishAsync(`${HOMIE_PREFIX}/${deviceId}/${capability}/${property}/set`, value, { qos: 1, retain: false });
  }

  async close(): Promise<void> {
    await this.client?.endAsync();
  }
}
