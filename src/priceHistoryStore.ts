import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface PriceObservation {
  timestamp: number;
  price: number;
}

interface StoreData {
  /*
   * Every observed price (qualifying or not), pruned to the rolling
   * window. This is what lets the "is this a good deal" bar adapt
   * over time instead of being pinned forever to whatever price
   * happened to be seen first.
   */
  history: Record<string, PriceObservation[]>;
  /*
   * The price that actually triggered the last notification for a
   * key, so we don't re-notify at the same price repeatedly.
   */
  lastNotified: Record<string, number>;
}

const ROLLING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function emptyStore(): StoreData {
  return { history: {}, lastNotified: {} };
}

export class PriceHistoryStore {
  private readonly filePath: string;
  private data: StoreData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): StoreData {
    if (!existsSync(this.filePath)) {
      return emptyStore();
    }

    let raw: string;

    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch (error) {
      console.error(
        `[price-history-store] Failed to read ${this.filePath}, ` +
          `starting fresh: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );

      return emptyStore();
    }

    try {
      const parsed = JSON.parse(raw);

      return {
        history:
          parsed?.history &&
          typeof parsed.history === "object"
            ? parsed.history
            : {},

        lastNotified:
          parsed?.lastNotified &&
          typeof parsed.lastNotified === "object"
            ? parsed.lastNotified
            : {},
      };
    } catch (error) {
      /*
       * A corrupt/truncated file (e.g. the process was killed
       * mid-write) is a real, loud problem - the entire price
       * history for every route is about to be reset. Log it
       * clearly rather than silently returning an empty store.
       */
      console.error(
        `[price-history-store] ${this.filePath} is corrupt ` +
          `(${
            error instanceof Error
              ? error.message
              : String(error)
          }). Starting with an EMPTY price history - all ` +
          `previously recorded baselines for every route are lost.`
      );

      return emptyStore();
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), {
      recursive: true,
    });

    /*
     * Write to a temp file and rename over the real one. rename()
     * is atomic on both POSIX and NTFS, so a crash mid-write can
     * never leave the real file truncated/corrupt.
     */
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;

    writeFileSync(
      tmpPath,
      JSON.stringify(this.data, null, 2)
    );

    renameSync(tmpPath, this.filePath);
  }

  recordObservation(
    key: string,
    price: number,
    now: number = Date.now()
  ): void {
    const list = this.data.history[key] ?? [];

    list.push({ timestamp: now, price });

    this.data.history[key] = list.filter(
      (observation) =>
        now - observation.timestamp <=
        ROLLING_WINDOW_MS
    );

    this.persist();
  }

  /*
   * The Nth percentile (0-100) of prices observed in the rolling
   * window, or undefined if there isn't enough history yet to
   * trust a percentile (falls back to the caller's absolute
   * threshold during this bootstrap period).
   */
  getPercentile(
    key: string,
    percentile: number,
    minSamples: number
  ): number | undefined {
    const list = this.data.history[key];

    if (!list || list.length < minSamples) {
      return undefined;
    }

    const sorted = list
      .map((observation) => observation.price)
      .sort((a, b) => a - b);

    const index = Math.min(
      sorted.length - 1,
      Math.max(
        0,
        Math.floor(
          (percentile / 100) * sorted.length
        )
      )
    );

    return sorted[index];
  }

  getLastNotifiedPrice(
    key: string
  ): number | undefined {
    return this.data.lastNotified[key];
  }

  setLastNotifiedPrice(
    key: string,
    price: number
  ): void {
    this.data.lastNotified[key] = price;
    this.persist();
  }
}
