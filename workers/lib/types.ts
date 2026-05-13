// Shared types for the download worker.
//
// `DownloaderEvent` is what the Downloader emits via EventTarget. The Bus
// translates these into the wire `OutgoingMessage` shape - keeping the
// Downloader free of any postMessage / BroadcastChannel knowledge so it
// can be unit-tested in plain Node.

export interface DownloadMeta {
  id: string;
  url: string;
  fileName: string;
  downloadedBytes: number;
  totalBytes: number | null;
  createdAt: number; // wall-clock ms (Date.now)
  etag?: string | null;
  lastModified?: string | null;
  // True once we've observed a CORS preflight reject `If-Range` for this URL
  // (the CDN allowlists Range but not If-Range). Persisted so future resumes
  // skip the failed preflight on every run, not just within one session.
  skipIfRange?: boolean;
}

export type WorkerState = "idle" | "downloading" | "paused" | "cancelled";

export type StatusValue = "idle" | "downloading" | "paused" | "complete";

export interface ProgressPayload {
  downloaded: number;
  total: number | null;
  percentage: number | null;
  chunks: number;
  elapsed: number;
}

export interface StateSnapshot {
  url: string;
  status: "downloading" | "paused";
  downloaded: number;
  total: number | null;
  percentage: number | null;
  fileName: string | null;
  chunks: number;
  elapsed: number;
}

export type WarningCode = "range-unsupported" | "validator-mismatch";

export type DownloaderEvent =
  | { type: "progress"; payload: ProgressPayload }
  | { type: "status"; status: StatusValue }
  | { type: "complete"; fileName: string; elapsed: number }
  | { type: "data"; id: string; fileName: string; totalBytes: number | null }
  | { type: "error"; message: string }
  | { type: "warning"; code: WarningCode; message: string }
  | { type: "heartbeat"; url: string }
  | { type: "pending"; downloads: DownloadMeta[] }
  | { type: "state-snapshot"; state: StateSnapshot };

// Every broadcast carries `_wid` so observers can tell self vs other.
// `goodbye` is broadcast-only (the master tab announcing its imminent close).

export type BroadcastMessage =
  | ({ type: "progress" } & ProgressPayload)
  | { type: "complete"; fileName: string; elapsed: number }
  | { type: "error"; message: string }
  | { type: "warning"; code: WarningCode; message: string }
  | { type: "status"; status: StatusValue }
  | { type: "pending-downloads"; downloads: DownloadMeta[] }
  | { type: "state-snapshot"; state: StateSnapshot }
  | { type: "heartbeat"; url: string }
  | { type: "request-state" }
  | { type: "goodbye"; url: string | null };

export type BroadcastEnvelope = BroadcastMessage & { _wid: string };

// With Comlink wired up, control-plane calls (`start`, `pause`, ...) are
// typed methods on `WorkerApi` rather than wire messages. The remaining
// direct postMessages are:
//   - `ping` from worker > UI on boot (carries workerId).
//   - `data` from worker > UI to trigger SW-streamed delivery.

export type WorkerToUiMessage =
  | { type: "ping"; workerId: string }
  | { type: "data"; id: string; fileName: string; totalBytes: number | null };

// ---------------- Storage abstraction ----------------

export interface SyncHandle {
  write(buffer: ArrayBuffer | ArrayBufferView, opts: { at: number }): number;
  flush(): void;
  close(): void;
  getSize(): number;
  truncate(size: number): void;
}

export interface Store {
  readMeta(id: string): Promise<DownloadMeta | null>;
  writeMeta(meta: DownloadMeta): Promise<void>;
  remove(id: string): Promise<void>;
  listAllMetas(): Promise<DownloadMeta[]>;
  openHandle(id: string): Promise<SyncHandle>;
  getFile(id: string): Promise<File | Blob>;
}
