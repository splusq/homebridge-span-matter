import type { EnergyReading } from './mapping.js';

export interface PowerDeadband {
  /** Smallest power change pushed straight away, in mW. */
  milliwatts: number;
  /** Or this share of the last pushed power, when that is larger. */
  percent: number;
}

/** A change smaller than the deadband still goes out this often. */
export const HEARTBEAT_MS = 60_000;

const differs = (now: number | null | undefined, then: number | null | undefined) => (now ?? null) !== (then ?? null);

/**
 * Whether a power reading is worth pushing. Every push reaches every Apple
 * device subscribed to the bridge, so only power past the deadband goes out
 * at once. Voltage is one panel-wide value on every circuit: letting it push
 * would send every circuit together whenever the mains wobbles. Voltage and
 * current ride along with power, and any leftover drift goes out with the
 * heartbeat.
 */
export function shouldPushPower(
  now: EnergyReading,
  last: EnergyReading | undefined,
  sinceLastMs: number,
  deadband: PowerDeadband,
): boolean {
  if (!last) {
    return true;
  }
  if (differs(now.activePower, last.activePower)) {
    if (now.activePower === null || last.activePower === null) {
      return true;
    }
    const threshold = Math.max(deadband.milliwatts, Math.abs(last.activePower) * deadband.percent / 100);
    if (Math.abs(now.activePower - last.activePower) >= threshold) {
      return true;
    }
  }
  return sinceLastMs >= HEARTBEAT_MS && (differs(now.activePower, last.activePower)
    || differs(now.voltage, last.voltage)
    || differs(now.activeCurrent, last.activeCurrent));
}
