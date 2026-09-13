import { describe, expect, it } from "vitest";
import { LatestPendingWorker } from "./latestPendingWorker";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LatestPendingWorker", () => {
  it("keeps one running item and only the latest pending item per key", async () => {
    const firstGate = deferred();
    const thirdDone = deferred();
    const processed: number[] = [];
    const worker = new LatestPendingWorker<string, number>({
      run: async (_key, value) => {
        processed.push(value);
        if (value === 1) await firstGate.promise;
        if (value === 3) thirdDone.resolve();
      },
    });

    worker.schedule("bus-a", 1);
    worker.schedule("bus-a", 2);
    worker.schedule("bus-a", 3);

    expect(worker.stats()).toMatchObject({
      activeKeys: 1,
      pendingKeys: 1,
      coalesced: 1,
    });
    firstGate.resolve();
    await thirdDone.promise;
    await Promise.resolve();

    expect(processed).toEqual([1, 3]);
    expect(worker.stats()).toMatchObject({
      activeKeys: 0,
      pendingKeys: 0,
      coalesced: 1,
      processed: 2,
    });
  });

  it("keeps different keys isolated", async () => {
    const gateA = deferred();
    const gateB = deferred();
    const started = new Set<string>();
    const bothStarted = deferred();
    const worker = new LatestPendingWorker<string, number>({
      run: async (key) => {
        started.add(key);
        if (started.size === 2) bothStarted.resolve();
        await (key === "bus-a" ? gateA.promise : gateB.promise);
      },
    });

    worker.schedule("bus-a", 1);
    worker.schedule("bus-b", 1);
    await bothStarted.promise;

    expect(started).toEqual(new Set(["bus-a", "bus-b"]));
    expect(worker.stats().activeKeys).toBe(2);
    gateA.resolve();
    gateB.resolve();
  });

  it("continues with pending work after a worker failure", async () => {
    const firstGate = deferred();
    const secondDone = deferred();
    const errors: string[] = [];
    const processed: number[] = [];
    const worker = new LatestPendingWorker<string, number>({
      run: async (_key, value) => {
        processed.push(value);
        if (value === 1) {
          await firstGate.promise;
          throw new Error("match failed");
        }
        secondDone.resolve();
      },
      onError: (_key, error) => {
        errors.push(error instanceof Error ? error.message : String(error));
      },
    });

    worker.schedule("bus-a", 1);
    worker.schedule("bus-a", 2);
    firstGate.resolve();
    await secondDone.promise;
    await Promise.resolve();

    expect(processed).toEqual([1, 2]);
    expect(errors).toEqual(["match failed"]);
    expect(worker.stats().activeKeys).toBe(0);
  });

  it("tracks pending queue age without counting replaced samples as processed", async () => {
    let now = 100;
    const firstGate = deferred();
    const secondDone = deferred();
    const worker = new LatestPendingWorker<string, number>({
      now: () => now,
      run: async (_key, value) => {
        if (value === 1) await firstGate.promise;
        if (value === 2) secondDone.resolve();
      },
    });

    worker.schedule("bus-a", 1);
    now = 200;
    worker.schedule("bus-a", 2);
    now = 250;
    firstGate.resolve();
    await secondDone.promise;
    await Promise.resolve();

    expect(worker.stats()).toMatchObject({
      coalesced: 0,
      processed: 2,
      lastQueueAgeMs: 50,
      maxQueueAgeMs: 50,
    });
  });
});
