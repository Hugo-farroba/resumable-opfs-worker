/// <reference lib="webworker" />

// Worker entry. All real logic lives in ./lib - this file wires:
//
//   1. Comlink expose: typed control API for the owning tab. Methods like
//      `start`, `pause`, `cancel`, `listPending` become local-feeling async
//      calls in the UI.
//   2. BroadcastBus: cross-tab state events (progress / heartbeat / status /
//      goodbye / state-snapshot etc.) so observer tabs stay in sync.
//   3. Direct postMessage for two messages that MUST go to the owning tab
//      only: `ping` (workerId handshake) and `data` (delivery cue).

import * as Comlink from "comlink";
import { BroadcastBus } from "./lib/bus.js";
import { Downloader } from "./lib/downloader.js";
import type { DownloaderEvent, DownloadMeta, ProgressPayload, StatusValue, WarningCode } from "./lib/types.js";
import { OpfsStore } from "./lib/opfs-store.js";
import { consoleLogger } from "./lib/logger.js";

declare const self: DedicatedWorkerGlobalScope;

const workerId = crypto.randomUUID();
const logger = consoleLogger;
const bus = new BroadcastBus(workerId, logger);
const downloader = new Downloader(new OpfsStore(logger), { logger });

// Subscribers to fan events out to the owning tab via Comlink (callback proxy)
// alongside BroadcastChannel.
type WorkerEventListener = (event: WorkerEventEnvelope) => void;
const eventListeners = new Set<WorkerEventListener>();

export type WorkerEventEnvelope =
  | { type: "progress"; payload: ProgressPayload }
  | { type: "status"; status: StatusValue }
  | { type: "complete"; fileName: string; elapsed: number }
  | { type: "error"; message: string }
  | { type: "warning"; code: WarningCode; message: string }
  | { type: "heartbeat"; url: string }
  | { type: "pending"; downloads: DownloadMeta[] };

// The Comlink-exposed control API. Any of these called from the UI are
// awaitable and typed end-to-end. Events still arrive via two channels:
// `subscribe` (own-tab Comlink callback) and the BroadcastChannel (all tabs).
export interface WorkerApi {
  readonly workerId: string;
  start(url: string, fileName?: string): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
  listPending(): Promise<DownloadMeta[]>;
  clear(id: string): Promise<DownloadMeta[]>;
  // Subscribe to own-tab events. Returns an unsubscribe Comlink-proxied fn.
  subscribe(listener: WorkerEventListener): () => void;
}

const api: WorkerApi = {
  workerId,
  start: (url, fileName) => downloader.start(url, fileName),
  pause: () => downloader.pause(),
  resume: () => downloader.resume(),
  cancel: () => downloader.cancel(),
  listPending: () => downloader.listPending(),
  clear: (id) => downloader.clear(id),
  subscribe(listener) {
    eventListeners.add(listener);
    return Comlink.proxy(() => {
      eventListeners.delete(listener);
    });
  },
};

Comlink.expose(api);

// Translate Downloader events to (a) own-tab Comlink subscribers and (b) the
// cross-tab BroadcastChannel. `data` is own-tab only - the SW-streamed
// delivery happens in the originating tab.
downloader.on((e: DownloaderEvent) => {
  switch (e.type) {
    case "progress":
      fanOutOwnTab({ type: "progress", payload: e.payload });
      bus.emit({ type: "progress", ...e.payload });
      break;
    case "status":
      fanOutOwnTab({ type: "status", status: e.status });
      bus.emit({ type: "status", status: e.status });
      break;
    case "complete":
      fanOutOwnTab({ type: "complete", fileName: e.fileName, elapsed: e.elapsed });
      bus.emit({ type: "complete", fileName: e.fileName, elapsed: e.elapsed });
      break;
    case "error":
      fanOutOwnTab({ type: "error", message: e.message });
      bus.emit({ type: "error", message: e.message });
      break;
    case "warning":
      fanOutOwnTab({ type: "warning", code: e.code, message: e.message });
      bus.emit({ type: "warning", code: e.code, message: e.message });
      break;
    case "heartbeat":
      fanOutOwnTab({ type: "heartbeat", url: e.url });
      bus.emit({ type: "heartbeat", url: e.url });
      break;
    case "pending":
      fanOutOwnTab({ type: "pending", downloads: e.downloads });
      bus.emit({ type: "pending-downloads", downloads: e.downloads });
      break;
    case "data":
      // Own-tab only. Carried via a direct postMessage so observer tabs
      // don't trigger the SW save flow. The UI listens with worker.onmessage
      // for `{ type: "data", ... }`.
      self.postMessage({ type: "data", id: e.id, fileName: e.fileName, totalBytes: e.totalBytes });
      break;
    case "state-snapshot":
      bus.emit({ type: "state-snapshot", state: e.state });
      break;
  }
});

function fanOutOwnTab(env: WorkerEventEnvelope): void {
  for (const listener of eventListeners) {
    try {
      listener(env);
    } catch (err) {
      logger.log("warn", "downloadWorker.listener.failed", { type: env.type }, err);
    }
  }
}

// Tabs that load while a download is active ask for a snapshot so their UI
// can render the current progress immediately.
bus.onMessage((env) => {
  if (env.type !== "request-state") return;
  const { state, ctx, elapsed } = downloader.getSnapshot();
  if (state !== "downloading" && state !== "paused") return;
  if (!ctx) return;
  const pct = ctx.totalBytes ? Math.round((ctx.downloadedBytes / ctx.totalBytes) * 100) : null;
  bus.emit({
    type: "state-snapshot",
    state: {
      url: ctx.url,
      status: state,
      downloaded: ctx.downloadedBytes,
      total: ctx.totalBytes,
      percentage: pct,
      fileName: ctx.fileName,
      chunks: ctx.chunkCount,
      elapsed,
    },
  });
});

// Boot handshake: identify ourselves to the owning tab.
self.postMessage({ type: "ping", workerId });
