#!/usr/bin/env node
// span-matter register <host> [--passphrase P] [--storage DIR]
// span-matter probe <host> [--storage DIR] [--json]
//
// `register` stores credentials where the plugin looks for them (the
// Homebridge storage directory, ~/.homebridge by default), so the bridge
// starts without waiting for the door switch. `probe` prints the Matter
// devices the plugin would publish, with their live values.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { discover, read } from './mapping.js';
import { CredentialStore, getCaCertificate, obtainCredentials } from './span/auth.js';
import { EbusClient } from './span/ebus.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    passphrase: { type: 'string' },
    storage: { type: 'string', default: join(homedir(), '.homebridge') },
    json: { type: 'boolean', default: false },
  },
});
const [command, host] = positionals;
if (!host || (command !== 'register' && command !== 'probe')) {
  console.error('usage: span-matter register|probe <panel-host> [--passphrase P] [--storage DIR] [--json]');
  process.exit(2);
}

const log = { info: (m: string) => console.error(m), warn: (m: string) => console.error(m) };
const store = new CredentialStore(join(values.storage!, 'span-matter'));
const credentials = await obtainCredentials({ host, store, hopPassphrase: values.passphrase, log });

if (command === 'register') {
  console.error(`Credentials for ${credentials.serialNumber} saved in ${join(values.storage!, 'span-matter')}`);
  process.exit(0);
}

const ebus = new EbusClient(credentials.serialNumber);
ebus.on('error', error => console.error(`eBus: ${error.message}`));
ebus.connect({
  host: new URL(`http://${host}`).hostname,
  port: credentials.ebusBrokerMqttsPort,
  username: credentials.ebusBrokerUsername,
  password: credentials.ebusBrokerPassword,
  ca: await getCaCertificate(host),
  servername: credentials.hostname,
});

let last = Date.now();
ebus.on('device', () => { last = Date.now(); });
const deadline = Date.now() + 30_000;
while (Date.now() < deadline && !(ebus.isComplete() && Date.now() - last > 1500)) {
  await new Promise(resolve => setTimeout(resolve, 250));
}

const specs = discover(ebus, { feedthrough: 'auto' });
const rows = specs.map(spec => ({ spec, reading: read(spec, ebus) }));
if (values.json) {
  const devices = Object.fromEntries([...ebus.devices].map(([id, device]) => [id, {
    type: device.type, state: device.state, children: device.children, values: Object.fromEntries(device.values),
  }]));
  console.log(JSON.stringify({ devices, endpoints: rows }, null, 2));
} else {
  const fmt = (milli: number | null | undefined, unit: string, digits = 1) =>
    milli === null || milli === undefined ? '-' : `${(milli / 1000).toFixed(digits)} ${unit}`;
  console.log(`${ebus.tree().length} eBus devices, ${specs.length} Matter endpoints\n`);
  for (const { spec, reading } of rows) {
    const e = reading?.energy;
    const extra = reading?.battery ? `  soc ${(reading.battery.batPercentRemaining ?? NaN) / 2}%` : '';
    console.log([
      spec.role.padEnd(11),
      spec.name.padEnd(32),
      fmt(e?.activePower, 'W').padStart(11),
      fmt(e?.voltage, 'V').padStart(8),
      fmt(e?.activeCurrent, 'A', 2).padStart(9),
      `in ${fmt(e?.imported ? e.imported / 1000 : e?.imported, 'kWh', 2)}`.padStart(16),
      `out ${fmt(e?.exported ? e.exported / 1000 : e?.exported, 'kWh', 2)}`.padStart(17),
      spec.feeds ? ` feeds ${spec.feeds}` : '',
      reading?.relayClosed === false ? ' [relay open]' : '',
      extra,
    ].join(' '));
  }
}
await ebus.close();
