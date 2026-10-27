#!/usr/bin/env node
// A stand-in SPAN panel for development: the v2 REST endpoints the plugin uses
// and an MQTTS eBus broker streaming a Homie device tree with live values.
//
//   node scripts/mock-panel.mjs [--http 8080] [--mqtts 18883] [--dir /tmp/mock-span]
//
// Point the plugin at host "localhost:8080". The CA and server certificate are
// generated with openssl on first run.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Aedes } from 'aedes';

const { values } = parseArgs({
  options: {
    http: { type: 'string', default: '8080' },
    mqtts: { type: 'string', default: '18883' },
    dir: { type: 'string', default: join(process.env.TMPDIR ?? '/tmp', 'mock-span') },
  },
});

const SERIAL = 'nt-0000-mock1';
const PASSWORD = 'mock-passphrase';
const dir = values.dir;
mkdirSync(dir, { recursive: true });

if (!existsSync(join(dir, 'server.crt'))) {
  const run = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=Mock SPAN CA',
    '-keyout', 'ca.key', '-out', 'ca.crt');
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr');
  writeFileSync(join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-days', '30', '-extfile', 'san.ext', '-out', 'server.crt');
}
const caPem = readFileSync(join(dir, 'ca.crt'), 'utf8');

// --- device tree ---------------------------------------------------------

const f = { datatype: 'float' };
const s = { datatype: 'string' };
const circuitNodes = {
  info: { properties: { name: s, spaces: s } },
  switch: { properties: { relay: { datatype: 'enum', format: 'UNKNOWN,OPEN,CLOSED', settable: true }, 'relay-requester': { datatype: 'enum' }, 'relay-controllable': { datatype: 'boolean' } } },
  breaker: { properties: { rating: { datatype: 'integer' }, poles: { datatype: 'integer' } } },
  meter: { properties: { current: f, 'active-power': f, 'imported-energy': f, 'exported-energy': f } },
  connection: { properties: { 'feeds-device-id': s, 'feeds-device-type': s } },
};
const circuits = [
  { id: 'aa01', name: 'Kitchen', spaces: '1', poles: 1, load: 350 },
  { id: 'aa02', name: 'Refrigerator', spaces: '3', poles: 1, load: 140 },
  { id: 'aa03', name: 'HVAC', spaces: '5,7', poles: 2, load: 2800 },
  { id: 'aa04', name: 'Dryer', spaces: '9,11', poles: 2, load: 0 },
  { id: 'aa05', name: 'Office', spaces: '2', poles: 1, load: 210 },
  { id: 'aa06', name: 'EV Charger', spaces: '13,15', poles: 2, load: 7200 },
  { id: 'aa07', name: 'Solar', spaces: '17,19', poles: 2, solar: 5200, feeds: ['pv', `${SERIAL}-pv`] },
  { id: 'aa08', name: 'Powerwall', spaces: '21,23', poles: 2, battery: true, feeds: ['bess', `${SERIAL}-pw`] },
];
const state = Object.fromEntries(circuits.map(c => [c.id, { power: 0, imported: c.solar ? 9_000_000 : 1000 * Math.random(), exported: c.solar ? 600 : 400000 * Math.random(), relay: 'CLOSED' }]));
let soc = 62;
let gridImported = 5_400_000;
let gridExported = 2_100_000;

const broker = await Aedes.createBroker({
  authenticate: (client, username, password, done) => done(null, username === SERIAL && password?.toString() === PASSWORD),
});
const publish = (topic, payload) => broker.publish({ topic: `ebus/5/${topic}`, payload: String(payload), qos: 0, retain: true, cmd: 'publish', dup: false }, () => {});

function describeAll() {
  const describe = (id, type, nodes, children) => {
    publish(`${id}/$description`, JSON.stringify({ homie: '5.0', version: 1, type: `energy.ebus.device.${type}`, nodes, ...(children ? { children } : {}) }));
    publish(`${id}/$state`, 'ready');
  };
  describe(SERIAL, 'distribution-enclosure', {
    info: { properties: { 'serial-number': s, model: { datatype: 'enum' }, 'firmware-version': s } },
    meter: { properties: { 'voltage-a': f, 'voltage-b': f } },
    'power-flows': { properties: { pv: f, battery: f, grid: f, site: f } },
  }, [`${SERIAL}-lugs-up`, `${SERIAL}-lugs-dn`, ...circuits.map(c => c.id), `${SERIAL}-pw`, `${SERIAL}-pv`]);
  publish(`${SERIAL}/info/serial-number`, SERIAL);
  publish(`${SERIAL}/info/model`, 'MAIN_32');
  publish(`${SERIAL}/info/firmware-version`, 'spanos3/mock');
  const lugs = { info: { properties: { direction: { datatype: 'enum' } } }, meter: { properties: { 'current-a': f, 'current-b': f, 'active-power': f, 'imported-energy': f, 'exported-energy': f } } };
  describe(`${SERIAL}-lugs-up`, 'lugs', lugs);
  publish(`${SERIAL}-lugs-up/info/direction`, 'UPSTREAM');
  describe(`${SERIAL}-lugs-dn`, 'lugs', lugs);
  publish(`${SERIAL}-lugs-dn/info/direction`, 'DOWNSTREAM');
  for (const n of ['active-power', 'imported-energy', 'exported-energy']) {
    publish(`${SERIAL}-lugs-dn/meter/${n}`, 0);
  }
  for (const c of circuits) {
    describe(c.id, 'circuit', circuitNodes);
    publish(`${c.id}/info/name`, c.name);
    publish(`${c.id}/info/spaces`, c.spaces);
    publish(`${c.id}/breaker/poles`, c.poles);
    publish(`${c.id}/switch/relay-controllable`, String(!c.feeds));
    publish(`${c.id}/switch/relay`, state[c.id].relay);
    publish(`${c.id}/connection/feeds-device-type`, c.feeds ? `energy.ebus.device.${c.feeds[0]}` : '');
    publish(`${c.id}/connection/feeds-device-id`, c.feeds ? c.feeds[1] : '');
  }
  describe(`${SERIAL}-pw`, 'bess', {
    info: { properties: { model: s, 'serial-number': s, 'nameplate-capacity': f } },
    soc: { properties: { soc: f, soe: f } },
    meter: { properties: { 'active-power': f } },
  }, [`${SERIAL}-pw-mid`]);
  publish(`${SERIAL}-pw/info/model`, 'Powerwall 3');
  describe(`${SERIAL}-pw-mid`, 'mid', { grid: { properties: { 'grid-state': { datatype: 'enum' } } } });
  publish(`${SERIAL}-pw-mid/grid/grid-state`, 'UP');
  describe(`${SERIAL}-pv`, 'pv', { info: { properties: { model: s, 'nominal-power': f } } });
  publish(`${SERIAL}-pv/info/model`, 'Enphase IQ8');
}

// Every second: wobble loads, integrate energy, close the balance at the lugs.
function tick() {
  const va = 120 + Math.random() * 2;
  const vb = 120 + Math.random() * 2;
  let sum = 0;
  for (const c of circuits) {
    const st = state[c.id];
    let power;
    if (c.solar) {
      power = c.solar * (0.9 + 0.1 * Math.random());      // backfeed: positive
    } else if (c.battery) {
      power = -1500 * (0.8 + 0.4 * Math.random());         // charging: negative
      soc = Math.min(100, soc + 0.01);
    } else {
      power = st.relay === 'OPEN' ? 0 : -c.load * (0.85 + 0.3 * Math.random());
    }
    st.power = power;
    if (power > 0) st.imported += power / 3600; else st.exported += -power / 3600;
    sum += power;
    const volts = c.poles >= 2 ? va + vb : (va + vb) / 2;
    publish(`${c.id}/meter/active-power`, power.toFixed(1));
    publish(`${c.id}/meter/current`, (Math.abs(power) / volts).toFixed(2));
    publish(`${c.id}/meter/imported-energy`, st.imported.toFixed(2));
    publish(`${c.id}/meter/exported-energy`, st.exported.toFixed(2));
  }
  const grid = -sum;                                      // lugs-up: positive importing
  if (grid > 0) gridImported += grid / 3600; else gridExported += -grid / 3600;
  const legs = Math.abs(grid) / (va + vb);
  publish(`${SERIAL}/meter/voltage-a`, va.toFixed(1));
  publish(`${SERIAL}/meter/voltage-b`, vb.toFixed(1));
  publish(`${SERIAL}-lugs-up/meter/active-power`, grid.toFixed(1));
  publish(`${SERIAL}-lugs-up/meter/current-a`, legs.toFixed(2));
  publish(`${SERIAL}-lugs-up/meter/current-b`, legs.toFixed(2));
  publish(`${SERIAL}-lugs-up/meter/imported-energy`, gridImported.toFixed(2));
  publish(`${SERIAL}-lugs-up/meter/exported-energy`, gridExported.toFixed(2));
  const pw = state.aa08.power;
  publish(`${SERIAL}-pw/meter/active-power`, (pw).toFixed(1));
  publish(`${SERIAL}-pw/soc/soc`, soc.toFixed(1));
  publish(`${SERIAL}/power-flows/pv`, (-state.aa07.power).toFixed(1));
  publish(`${SERIAL}/power-flows/battery`, (-pw).toFixed(1));
  publish(`${SERIAL}/power-flows/grid`, (-grid).toFixed(1));
  publish(`${SERIAL}/power-flows/site`, (-sum + state.aa07.power + pw).toFixed(1));
}

broker.on('publish', packet => {
  const match = /^ebus\/5\/([^/]+)\/switch\/relay\/set$/.exec(packet.topic);
  if (match && state[match[1]]) {
    state[match[1]].relay = packet.payload.toString();
    publish(`${match[1]}/switch/relay`, state[match[1]].relay);
    console.log(`relay ${match[1]} -> ${state[match[1]].relay}`);
  }
});

describeAll();
tick();
setInterval(tick, 1000);

createTlsServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.crt')) }, broker.handle)
  .listen(Number(values.mqtts), () => console.log(`eBus MQTTS on :${values.mqtts}`));

createHttpServer((req, res) => {
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/api/v2/status') {
    return json(200, { serialNumber: SERIAL, firmwareVersion: 'spanos3/mock', proximityProven: true, hardwareVersion: '2.0' });
  }
  if (req.url === '/api/v2/certificate/ca') {
    res.writeHead(200, { 'content-type': 'application/x-pem-file' });
    return res.end(caPem);
  }
  if (req.url === '/api/v2/auth/register' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      console.log(`register ${body}`);
      json(200, {
        accessToken: 'mock-token', tokenType: 'bearer', iatMs: Date.now(), hostname: 'localhost', serialNumber: SERIAL,
        hopPassphrase: PASSWORD, ebusBrokerUsername: SERIAL, ebusBrokerPassword: PASSWORD, ebusBrokerHost: 'localhost',
        ebusBrokerMqttsPort: Number(values.mqtts), ebusBrokerWsPort: 0, ebusBrokerWssPort: 0,
      });
    });
    return;
  }
  json(404, { detail: 'not found' });
}).listen(Number(values.http), () => console.log(`REST on :${values.http}`));
