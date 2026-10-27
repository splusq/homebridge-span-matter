// SPAN v2 REST: identity, client registration and the broker's CA certificate.
//
// Registration needs either the panel's hopPassphrase or proof of proximity
// (the door switch pressed three times). A proximity registration returns the
// passphrase, so it only has to happen once; the credentials are kept on disk.

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { hostname as localHostname } from 'node:os';
import { join } from 'node:path';

export interface SpanStatus {
  serialNumber: string;
  firmwareVersion: string;
  proximityProven: boolean;
  hardwareVersion: string;
}

export interface SpanCredentials {
  serialNumber: string;
  hostname: string;
  clientName: string;
  accessToken: string;
  hopPassphrase?: string;
  ebusBrokerUsername: string;
  ebusBrokerPassword: string;
  ebusBrokerHost: string;
  ebusBrokerMqttsPort: number;
  registeredAt: string;
}

interface AuthOut {
  accessToken: string;
  hostname: string;
  serialNumber: string;
  hopPassphrase?: string | null;
  ebusBrokerUsername: string;
  ebusBrokerPassword?: string | null;
  ebusBrokerHost: string;
  ebusBrokerMqttsPort: number;
}

export class SpanHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(host: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://${host}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new SpanHttpError(response.status, `${init?.method ?? 'GET'} ${path}: HTTP ${response.status} ${text}`);
  }
  return (path.endsWith('/ca') ? text : JSON.parse(text)) as T;
}

export function getStatus(host: string): Promise<SpanStatus> {
  return request<SpanStatus>(host, '/api/v2/status');
}

export function getCaCertificate(host: string): Promise<string> {
  return request<string>(host, '/api/v2/certificate/ca');
}

async function register(host: string, hopPassphrase?: string): Promise<SpanCredentials> {
  // Client names must be unique, and a proximity proof is spent by a failed
  // attempt, so the name carries a timestamp.
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const suffix = Math.random().toString(16).slice(2, 6);
  const clientName = `homebridge-span-matter-${localHostname().split('.')[0]}-${stamp}-${suffix}`;
  const out = await request<AuthOut>(host, '/api/v2/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: clientName,
      description: 'Homebridge SPAN Matter energy bridge',
      ...(hopPassphrase ? { hopPassphrase } : {}),
    }),
  });
  const passphrase = out.hopPassphrase ?? hopPassphrase;
  const brokerPassword = out.ebusBrokerPassword ?? passphrase;
  if (!brokerPassword) {
    throw new Error('The panel registered this client but returned no eBus broker password');
  }
  return {
    serialNumber: out.serialNumber,
    hostname: out.hostname,
    clientName,
    accessToken: out.accessToken,
    hopPassphrase: passphrase ?? undefined,
    ebusBrokerUsername: out.ebusBrokerUsername,
    ebusBrokerPassword: brokerPassword,
    ebusBrokerHost: out.ebusBrokerHost,
    ebusBrokerMqttsPort: out.ebusBrokerMqttsPort,
    registeredAt: new Date().toISOString(),
  };
}

export class CredentialStore {
  constructor(private readonly directory: string) {}

  private file(serial: string): string {
    return join(this.directory, `${serial.toLowerCase()}.json`);
  }

  async load(serial: string): Promise<SpanCredentials | undefined> {
    try {
      return JSON.parse(await readFile(this.file(serial), 'utf8')) as SpanCredentials;
    } catch {
      return undefined;
    }
  }

  async save(credentials: SpanCredentials): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.file(credentials.serialNumber), JSON.stringify(credentials, null, 2), { mode: 0o600 });
  }

  async forget(serial: string): Promise<void> {
    await rm(this.file(serial), { force: true });
  }
}

export interface ObtainOptions {
  host: string;
  store: CredentialStore;
  hopPassphrase?: string;
  log: { info(message: string): void; warn(message: string): void };
  signal?: AbortSignal;
  /** How long to wait for the door switch before giving up, in ms. */
  proximityTimeoutMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

/**
 * Returns stored credentials for the panel at `host`, registering a new client
 * when there are none: with the configured passphrase if there is one,
 * otherwise by waiting for the door switch to be pressed three times.
 */
export async function obtainCredentials(options: ObtainOptions): Promise<SpanCredentials> {
  const { host, store, log, signal } = options;
  const status = await getStatus(host);
  const stored = await store.load(status.serialNumber);
  if (stored) {
    return stored;
  }

  let credentials: SpanCredentials;
  if (options.hopPassphrase) {
    log.info(`Registering with SPAN panel ${status.serialNumber} using the configured passphrase`);
    credentials = await register(host, options.hopPassphrase);
  } else {
    if (!status.proximityProven) {
      log.warn(`SPAN panel ${status.serialNumber} needs this bridge registered: open the panel door and press the door switch 3 times. Waiting...`);
      const deadline = Date.now() + (options.proximityTimeoutMs ?? 15 * 60_000);
      while (!(await getStatus(host)).proximityProven) {
        if (Date.now() > deadline) {
          throw new Error('Timed out waiting for the SPAN door switch. Restart the bridge to try again, or set hopPassphrase.');
        }
        await sleep(2500, signal);
      }
    }
    log.info('Door switch press detected, registering');
    credentials = await register(host);
    // A proximity registration carries reduced privileges. The passphrase it
    // returns gets a full one, which also survives a passphrase that was
    // never shown to the user.
    if (credentials.hopPassphrase) {
      try {
        credentials = await register(host, credentials.hopPassphrase);
      } catch (error) {
        log.warn(`Could not upgrade to a full-privilege token, continuing: ${(error as Error).message}`);
      }
    }
  }
  await store.save(credentials);
  log.info(`Registered as ${credentials.clientName}`);
  return credentials;
}
