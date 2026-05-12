import { describe, it, expect } from "vitest";
import { Downloader } from "./downloader.js";
import { sha256Id } from "./id.js";
import { MemoryStore, makeFakeFetch, chunkBytes, recordEvents } from "./test-fixtures.js";
import type { DownloaderEvent } from "./types.js";

const URL_A = "https://example.com/file.bin";
// Tiny tunables so tests don't wait around. heartbeatInterval=0 disables
// the liveness ticks (irrelevant for most tests; a dedicated test sets it).
const T = { flushBytes: 16, flushInterval: 5, progressInterval: 0, heartbeatInterval: 0 };

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function lastOfType<K extends DownloaderEvent["type"]>(
  events: DownloaderEvent[],
  type: K,
): Extract<DownloaderEvent, { type: K }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i] as Extract<DownloaderEvent, { type: K }>;
  }
  return undefined;
}

describe("progress reaches 100% before complete", () => {
  // The UI's progress bar binds to dl.percentage. If the final progress event
  // doesn't show 100% the bar visually stops short of full even though the
  // download succeeded. Captures every progress event and asserts the last
  // one is 100%.
  it("on a streaming download", async () => {
    const store = new MemoryStore();
    const total = 256;
    const fetchFn = makeFakeFetch([
      {
        noRange: true,
        response: { status: 200, headers: { "content-length": String(total) }, chunks: chunkBytes(total, 16) },
      },
    ]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "complete"));

    // Last progress before complete must be 100%.
    const completeIdx = events.findIndex((e) => e.type === "complete");
    const lastProgressBeforeComplete = events
      .slice(0, completeIdx)
      .reverse()
      .find((e) => e.type === "progress");
    expect(lastProgressBeforeComplete?.type).toBe("progress");
    if (lastProgressBeforeComplete?.type === "progress") {
      expect(lastProgressBeforeComplete.payload.percentage).toBe(100);
      expect(lastProgressBeforeComplete.payload.downloaded).toBe(total);
    }
  });

  it("on a server with no content-length", async () => {
    const store = new MemoryStore();
    const total = 64;
    const fetchFn = makeFakeFetch([
      { noRange: true, response: { status: 200, chunks: chunkBytes(total, 16) } }, // no headers
    ]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "complete"));

    const completeIdx = events.findIndex((e) => e.type === "complete");
    const lastProgressBeforeComplete = events
      .slice(0, completeIdx)
      .reverse()
      .find((e) => e.type === "progress");
    expect(lastProgressBeforeComplete?.type).toBe("progress");
    if (lastProgressBeforeComplete?.type === "progress") {
      expect(lastProgressBeforeComplete.payload.percentage).toBe(100);
    }
  });
});

describe("heartbeat lifecycle", () => {
  // Heartbeats let observer tabs detect a dead master and offer takeover.
  // They must tick while downloading or paused, and stop on cancel/complete.
  it("emits while downloading and stops on complete", async () => {
    const store = new MemoryStore();
    const total = 64;
    const fetchFn = makeFakeFetch([{ noRange: true, response: { chunks: chunkBytes(total, 16), chunkDelayMs: 8 } }]);
    const d = new Downloader(store, { fetchFn, tunables: { ...T, heartbeatInterval: 10 } });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    // Let a couple of heartbeats fire.
    await new Promise((r) => setTimeout(r, 35));
    const beforeComplete = events.filter((e) => e.type === "heartbeat").length;
    expect(beforeComplete).toBeGreaterThan(0);

    await waitFor(() => events.some((e) => e.type === "complete"));
    const atComplete = events.filter((e) => e.type === "heartbeat").length;
    // No new heartbeats after complete.
    await new Promise((r) => setTimeout(r, 30));
    const afterComplete = events.filter((e) => e.type === "heartbeat").length;
    expect(afterComplete).toBe(atComplete);
  });

  it("stops on cancel", async () => {
    const store = new MemoryStore();
    const fetchFn = makeFakeFetch([{ noRange: true, response: { chunks: chunkBytes(1024, 16), chunkDelayMs: 50 } }]);
    const d = new Downloader(store, { fetchFn, tunables: { ...T, heartbeatInterval: 10 } });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await new Promise((r) => setTimeout(r, 25));
    expect(events.some((e) => e.type === "heartbeat")).toBe(true);

    await d.cancel();
    const atCancel = events.filter((e) => e.type === "heartbeat").length;
    await new Promise((r) => setTimeout(r, 30));
    expect(events.filter((e) => e.type === "heartbeat").length).toBe(atCancel);
  });
});

describe("listPending filters out completed files", () => {
  // Completed files stay in OPFS for fast re-export but must not appear in
  // the "pick up where you left off" UI - they're already saved. The filter
  // lives on Downloader (single source of truth); Store.listAllMetas returns
  // every meta on disk.
  it("returns only entries with downloadedBytes < totalBytes", async () => {
    const store = new MemoryStore();
    await store.writeMeta({
      id: "aaaa",
      url: "https://x/a",
      fileName: "a",
      downloadedBytes: 100,
      totalBytes: 100,
      createdAt: Date.now(),
    });
    await store.writeMeta({
      id: "bbbb",
      url: "https://x/b",
      fileName: "b",
      downloadedBytes: 50,
      totalBytes: 100,
      createdAt: Date.now(),
    });
    const d = new Downloader(store, { tunables: T });
    const pending = await d.listPending();
    expect(pending.map((p) => p.id)).toEqual(["bbbb"]);
  });
});

describe("finalise persists complete state to meta", () => {
  // Regression: meta lagged the last batched flush, so on page refresh the
  // pending card showed "8 MB / 9.56 MB saved" for a file that was actually
  // complete on disk.
  it("writes meta with downloadedBytes === totalBytes after complete", async () => {
    const store = new MemoryStore();
    const total = 256;
    const fetchFn = makeFakeFetch([
      {
        noRange: true,
        response: { status: 200, headers: { "content-length": String(total) }, chunks: chunkBytes(total, 32) },
      },
    ]);
    // Use a large flushBytes so the loop's last writeMeta lags behind total.
    const d = new Downloader(store, {
      fetchFn,
      tunables: { flushBytes: 9999, flushInterval: 9999, progressInterval: 9999 },
    });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "complete"));

    const id = await sha256Id(URL_A);
    const meta = store.metaOf(id);
    expect(meta).toBeDefined();
    expect(meta!.downloadedBytes).toBe(total);
    expect(meta!.totalBytes).toBe(total);
  });
});

describe("happy path", () => {
  it("downloads, flushes, finalises with full bytes", async () => {
    const store = new MemoryStore();
    const total = 256;
    const fetchFn = makeFakeFetch([
      {
        noRange: true,
        response: { status: 200, headers: { "content-length": String(total) }, chunks: chunkBytes(total, 32) },
      },
    ]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);

    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "data"));

    const data = events.find((e) => e.type === "data");
    expect(data?.type).toBe("data");
    if (data?.type === "data") {
      expect(data.id).toBe(await sha256Id(URL_A));
      expect(data.totalBytes).toBe(total);
      // Bytes are read by the SW from OPFS, not transferred via the event.
      expect(store.bytesOf(data.id).byteLength).toBe(total);
    }
    expect(lastOfType(events, "complete")?.fileName).toBe("file.bin");
  });
});

describe("Range fallback (bug 1.1)", () => {
  it("truncates and writes from 0 when server returns 200 to a Range request", async () => {
    const store = new MemoryStore();
    const total = 128;

    // Pre-seed: simulate a previous partial download of 40 garbage bytes.
    const id = await sha256Id(URL_A);
    const handle = await store.openHandle(id);
    handle.write(new Uint8Array(40).fill(0xaa), { at: 0 });
    handle.close();
    await store.writeMeta({
      id,
      url: URL_A,
      fileName: "file.bin",
      downloadedBytes: 40,
      totalBytes: total,
      createdAt: Date.now(),
    });

    // Server doesn't support Range - returns 200 with the full file.
    const fetchFn = makeFakeFetch([
      {
        rangeStart: 40,
        response: { status: 200, headers: { "content-length": String(total) }, chunks: chunkBytes(total, 32) },
      },
    ]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);

    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "data"));

    const data = events.find((e) => e.type === "data");
    if (data?.type !== "data") throw new Error("no data");
    const buf = store.bytesOf(data.id);
    expect(buf.byteLength).toBe(total);
    // Bytes [0, total) should match the deterministic chunk pattern: byte i === i & 0xff.
    for (let i = 0; i < total; i++) expect(buf[i]).toBe(i & 0xff);
  });
});

describe("Range fallback emits a warning", () => {
  it("emits a range-unsupported warning when truncating", async () => {
    const store = new MemoryStore();
    const total = 64;
    const id = await sha256Id(URL_A);
    const handle = await store.openHandle(id);
    handle.write(new Uint8Array(20).fill(0xaa), { at: 0 });
    handle.close();
    await store.writeMeta({
      id,
      url: URL_A,
      fileName: "file.bin",
      downloadedBytes: 20,
      totalBytes: total,
      createdAt: Date.now(),
    });
    const fetchFn = makeFakeFetch([{ rangeStart: 20, response: { status: 200, chunks: chunkBytes(total, 16) } }]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "data"));
    const w = events.find((e) => e.type === "warning");
    expect(w?.type).toBe("warning");
    if (w?.type === "warning") expect(w.code).toBe("range-unsupported");
  });
});

describe("cancel mid-flight (bug 1.5)", () => {
  it("does not emit a spurious error when cancelled during streaming", async () => {
    const store = new MemoryStore();
    const fetchFn = makeFakeFetch([
      { noRange: true, response: { chunks: chunkBytes(1024, 32) } }, // many chunks > time to cancel
    ]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);

    await d.start(URL_A);
    await new Promise((r) => setTimeout(r, 5));
    await d.cancel();
    await new Promise((r) => setTimeout(r, 30));

    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(0);
    const id = await sha256Id(URL_A);
    expect(await store.readMeta(id)).toBeNull(); // cancel removed it
  });
});

describe("pause / resume preserves bytes", () => {
  it("resumes from the exact byte and produces the correct file", async () => {
    const store = new MemoryStore();
    const total = 256;

    // First leg: server hands out chunks slowly so the test can pause partway.
    const fetchFirst = makeFakeFetch([
      { noRange: true, response: { chunks: chunkBytes(total, 32), chunkDelayMs: 10 } },
    ]);
    const d1 = new Downloader(store, { fetchFn: fetchFirst, tunables: T });
    const ev1 = recordEvents(d1);

    await d1.start(URL_A);
    await waitFor(() => {
      const p = ev1.events.filter((e) => e.type === "progress").pop();
      return p?.type === "progress" && p.payload.downloaded >= 64;
    });
    d1.pause();
    await waitFor(() => ev1.events.some((e) => e.type === "status" && e.status === "paused"));

    const id = await sha256Id(URL_A);
    const partial = store.bytesOf(id).byteLength;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(total);

    // Simulate the worker dying - the OS releases the OPFS exclusive lock.
    store.forceUnlock(id);

    // Resume in a fresh Downloader - simulates page refresh.
    const fetchResume = makeFakeFetch([
      {
        rangeStart: partial,
        response: {
          status: 206,
          headers: { "content-range": `bytes ${partial}-${total - 1}/${total}` },
          chunks: chunkBytes(total, 32).flatMap((c, i) => (i * 32 < partial ? [] : [c])),
        },
      },
    ]);
    const d2 = new Downloader(store, { fetchFn: fetchResume, tunables: T });
    const ev2 = recordEvents(d2);
    await d2.start(URL_A);
    await waitFor(() => ev2.events.some((e) => e.type === "data"));

    const data = ev2.events.find((e) => e.type === "data");
    expect(data?.type).toBe("data");
    if (data?.type === "data") {
      const buf = store.bytesOf(data.id);
      expect(buf.byteLength).toBe(total);
      for (let i = 0; i < total; i++) expect(buf[i]).toBe(i & 0xff);
    }
  });
});

describe("resume range validation", () => {
  it("fails instead of appending when a 206 response starts at the wrong byte", async () => {
    const store = new MemoryStore();
    const total = 256;
    const id = await sha256Id(URL_A);
    const handle = await store.openHandle(id);
    handle.write(chunkBytes(64, 64)[0], { at: 0 });
    handle.close();
    await store.writeMeta({
      id,
      url: URL_A,
      fileName: "file.bin",
      downloadedBytes: 64,
      totalBytes: total,
      createdAt: Date.now(),
    });

    const fetchFn = makeFakeFetch([
      {
        rangeStart: 64,
        response: {
          status: 206,
          headers: { "content-range": `bytes 0-${total - 1}/${total}` },
          chunks: chunkBytes(total, 32),
        },
      },
    ]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);

    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "error"));

    expect(events.some((e) => e.type === "data")).toBe(false);
    expect(store.bytesOf(id).byteLength).toBe(64);
    const err = events.find((e) => e.type === "error");
    expect(err?.type).toBe("error");
    if (err?.type === "error") {
      expect(err.message).toContain("invalid resumed range");
    }
  });
});

describe("elapsed math (bug 1.3)", () => {
  it("produces non-negative elapsed time on a fresh start", async () => {
    const store = new MemoryStore();
    const fetchFn = makeFakeFetch([
      { noRange: true, response: { chunks: chunkBytes(64, 16), headers: { "content-length": "64" } } },
    ]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "data"));

    for (const e of events) {
      if (e.type === "progress") expect(e.payload.elapsed).toBeGreaterThanOrEqual(0);
      if (e.type === "complete") expect(e.elapsed).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("batched flush (perf 3.1)", () => {
  it("does not writeMeta on every chunk", async () => {
    const store = new MemoryStore();
    const writeMetaSpy: number[] = [];
    const orig = store.writeMeta.bind(store);
    store.writeMeta = async (m) => {
      writeMetaSpy.push(m.downloadedBytes);
      return orig(m);
    };

    const total = 1024;
    const chunkSize = 32; // 32 chunks of 32 bytes
    const fetchFn = makeFakeFetch([
      {
        noRange: true,
        response: { chunks: chunkBytes(total, chunkSize), headers: { "content-length": String(total) } },
      },
    ]);

    // flushBytes = 128 > expect ~total/128 = 8 batched flushes plus 1 initial.
    const d = new Downloader(store, {
      fetchFn,
      tunables: { flushBytes: 128, flushInterval: 9999, progressInterval: 9999 },
    });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "data"));

    expect(writeMetaSpy.length).toBeLessThan(total / chunkSize);
    expect(writeMetaSpy.length).toBeGreaterThan(0);
  });
});

describe("re-download of completed file re-exports from OPFS", () => {
  // OPFS is the source of truth for resumable downloads. Clicking Download on
  // a URL whose .part is already complete must NOT refetch - it re-exports
  // the cached file. The UI should still show real numbers (regression: it
  // sat in "Complete with 0 B / 0 chunks" because no progress fired).
  it("emits data without hitting the network and shows correct totals", async () => {
    const store = new MemoryStore();
    const total = 64;
    const id = await sha256Id(URL_A);
    const handle = await store.openHandle(id);
    handle.write(chunkBytes(total, 64)[0], { at: 0 });
    handle.close();
    await store.writeMeta({
      id,
      url: URL_A,
      fileName: "file.bin",
      downloadedBytes: total,
      totalBytes: total,
      createdAt: Date.now(),
    });

    let fetched = false;
    const fetchFn: typeof fetch = async () => {
      fetched = true;
      throw new Error("should not fetch");
    };
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "data"));

    expect(fetched).toBe(false);
    const p = events.filter((e) => e.type === "progress").pop();
    expect(p?.type).toBe("progress");
    if (p?.type === "progress") {
      expect(p.payload.downloaded).toBe(total);
      expect(p.payload.percentage).toBe(100);
    }
    // OPFS files remain - Reset/cancel cleans them.
    expect(await store.readMeta(id)).not.toBeNull();
  });
});

describe("cancel after complete clears OPFS", () => {
  it("removes the cached completed file (Reset behaviour)", async () => {
    const store = new MemoryStore();
    const total = 64;
    const fetchFn = makeFakeFetch([
      {
        noRange: true,
        response: { status: 200, headers: { "content-length": String(total) }, chunks: chunkBytes(total, 16) },
      },
    ]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await waitFor(() => events.some((e) => e.type === "complete"));

    const id = await sha256Id(URL_A);
    expect(await store.readMeta(id)).not.toBeNull(); // kept after complete

    await d.cancel();
    expect(await store.readMeta(id)).toBeNull(); // Reset cleared it
  });
});

describe("clear refuses active download (bug 1.9)", () => {
  it("does not delete files of the active download", async () => {
    const store = new MemoryStore();
    const fetchFn = makeFakeFetch([{ noRange: true, response: { chunks: chunkBytes(2048, 32) } }]);
    const d = new Downloader(store, { fetchFn, tunables: T });
    const { events } = recordEvents(d);
    await d.start(URL_A);
    await new Promise((r) => setTimeout(r, 5));

    const id = await sha256Id(URL_A);
    await d.clear(id);
    expect(await store.readMeta(id)).not.toBeNull();
    expect(events.some((e) => e.type === "error" && e.message.includes("active"))).toBe(true);

    await d.cancel();
  });
});
