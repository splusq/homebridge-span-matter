import type { EnergyReading } from './mapping.js';

export interface PowerDeadband {
  /** Smallest power change pushed in the next batch, in mW. */
  milliwatts: number;
  /** Or this share of the last pushed power, when that is larger. */
  percent: number;
}

/** Drift under the deadband, voltage drift and energy totals go out this often. */
export const HEARTBEAT_MS = 5 * 60_000;

/** A voltage swing that goes out in the next batch rather than with the heartbeat, in mV. */
export const VOLTAGE_STEP_MV = 2_000;

/** What was last sent for one electricalPowerMeasurement cluster. */
export interface PowerSent {
  activePower: number | null;
  activeCurrent?: number | null;
  voltage?: number | null;
  /** When power (and current with it) was last sent. */
  at: number;
  /** When voltage was last sent. */
  voltageAt: number;
}

const differs = (now: number | null | undefined, then: number | null | undefined) => (now ?? null) !== (then ?? null);

/**
 * The electricalPowerMeasurement attributes worth sending now, or nothing.
 *
 * A Mac's homed re-reads the whole bridge's structure for every attribute
 * that changes in a report, so each attribute left out of a batch saves a
 * walk over every endpoint. Power goes out once it moves past the deadband,
 * with current alongside since the two move together. Voltage is one
 * panel-wide value on every circuit and goes out on its own: on a real swing,
 * or with the heartbeat. Drift under the deadband also waits for the
 * heartbeat.
 */
export function powerUpdate(
  now: EnergyReading,
  sent: PowerSent | undefined,
  time: number,
  deadband: PowerDeadband,
): Partial<EnergyReading> | undefined {
  const hasCurrent = 'activeCurrent' in now;
  const hasVoltage = 'voltage' in now;
  if (!sent) {
    return {
      activePower: now.activePower,
      ...(hasCurrent ? { activeCurrent: now.activeCurrent } : {}),
      ...(hasVoltage ? { voltage: now.voltage } : {}),
    };
  }

  const update: Partial<EnergyReading> = {};
  let powerDue = false;
  if (differs(now.activePower, sent.activePower)) {
    powerDue = now.activePower === null || sent.activePower === null
      || Math.abs(now.activePower - sent.activePower)
        >= Math.max(deadband.milliwatts, Math.abs(sent.activePower) * deadband.percent / 100);
  }
  powerDue ||= time - sent.at >= HEARTBEAT_MS
    && (differs(now.activePower, sent.activePower) || (hasCurrent && differs(now.activeCurrent, sent.activeCurrent)));
  if (powerDue) {
    update.activePower = now.activePower;
    if (hasCurrent) {
      update.activeCurrent = now.activeCurrent;
    }
  }

  if (hasVoltage && differs(now.voltage, sent.voltage)) {
    const swing = now.voltage === null || now.voltage === undefined || sent.voltage === null || sent.voltage === undefined
      || Math.abs(now.voltage - sent.voltage) >= VOLTAGE_STEP_MV;
    if (swing || time - sent.voltageAt >= HEARTBEAT_MS) {
      update.voltage = now.voltage;
    }
  }
  return Object.keys(update).length ? update : undefined;
}

/** Folds a sent update into the record of what was sent. */
export function recordSent(sent: PowerSent | undefined, update: Partial<EnergyReading>, time: number): PowerSent {
  const next: PowerSent = sent ? { ...sent } : { activePower: null, at: time, voltageAt: time };
  if ('activePower' in update) {
    next.activePower = update.activePower ?? null;
    next.at = time;
  }
  if ('activeCurrent' in update) {
    next.activeCurrent = update.activeCurrent;
  }
  if ('voltage' in update) {
    next.voltage = update.voltage;
    next.voltageAt = time;
  }
  return next;
}
