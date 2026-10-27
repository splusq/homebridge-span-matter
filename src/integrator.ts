// Energy for sources that only report power (the panel's power-flows and a
// supply-side BESS): a trapezoidal integral of the 1 Hz power samples, kept
// on disk so the counters survive restarts and stay monotonic, as Matter's
// cumulative energy requires.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface Total {
  /** Wh consumed (Matter imported). */
  imported: number;
  /** Wh produced (Matter exported). */
  exported: number;
}

export class EnergyIntegrator {
  private totals: Record<string, Total> = {};
  private readonly last = new Map<string, { at: number; watts: number }>();
  private dirty = false;

  /**
   * @param file where totals are kept
   * @param maxGapMs samples further apart than this are not bridged: the
   *   power during an outage of the feed is unknown
   */
  constructor(private readonly file?: string, private readonly maxGapMs = 10_000) {}

  async load(): Promise<void> {
    if (!this.file) {
      return;
    }
    try {
      this.totals = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, Total>;
    } catch {
      this.totals = {};
    }
  }

  async save(): Promise<void> {
    if (!this.file || !this.dirty) {
      return;
    }
    this.dirty = false;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.totals, null, 2));
  }

  /** Current totals in Matter units (mWh). */
  read(key: string): { imported: number; exported: number } {
    const total = this.totals[key] ?? { imported: 0, exported: 0 };
    return { imported: Math.round(total.imported * 1000), exported: Math.round(total.exported * 1000) };
  }

  /**
   * Adds a power sample (Matter sign: positive consumed) and returns the
   * totals in mWh.
   */
  sample(key: string, milliwatts: number | null, at = Date.now()): { imported: number; exported: number } {
    if (milliwatts === null) {
      this.last.delete(key);
      return this.read(key);
    }
    const watts = milliwatts / 1000;
    const previous = this.last.get(key);
    this.last.set(key, { at, watts });
    if (previous && at > previous.at && at - previous.at <= this.maxGapMs) {
      const total = this.totals[key] ??= { imported: 0, exported: 0 };
      const hours = (at - previous.at) / 3_600_000;
      // Split the trapezoid where the power crosses zero, so a flip between
      // samples does not net import against export.
      const [a, b] = [previous.watts, watts];
      if (a >= 0 === b >= 0) {
        const energy = ((a + b) / 2) * hours;
        if (energy >= 0) {
          total.imported += energy;
        } else {
          total.exported -= energy;
        }
      } else {
        const fraction = Math.abs(a) / (Math.abs(a) + Math.abs(b));
        const first = (a / 2) * hours * fraction;
        const second = (b / 2) * hours * (1 - fraction);
        for (const energy of [first, second]) {
          if (energy >= 0) {
            total.imported += energy;
          } else {
            total.exported -= energy;
          }
        }
      }
      this.dirty = true;
    }
    return this.read(key);
  }
}
