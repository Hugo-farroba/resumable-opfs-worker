import { FLUSH_BYTES, FLUSH_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, PROGRESS_INTERVAL_MS } from "./constants.js";
import {
  deriveFileName,
  deriveFileNameFromUrl,
  parseByteRange,
  parseTotalBytes,
  pickIfRangeValidator,
  readValidator,
  sha256Id,
} from "./id.js";
import type { Logger } from "./logger.js";
import { consoleLogger, tryOr, tryOrAsync } from "./logger.js";
import type { DownloaderEvent, DownloadMeta, Store, SyncHandle, WorkerState } from "./types.js";

export const DOWNLOADER_DEFAULTS = {
  flushBytes: FLUSH_BYTES,
  flushInterval: FLUSH_INTERVAL_MS,
  progressInterval: PROGRESS_INTERVAL_MS,
  heartbeatInterval: HEARTBEAT_INTERVAL_MS,
} as const;

// Re-export for external callers that want to override one tunable in tests.
export { FLUSH_BYTES, FLUSH_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, PROGRESS_INTERVAL_MS };

interface DownloaderTunables {
  flushBytes: number;
  flushInterval: number;
  progressInterval: number;
  heartbeatInterval: number;
}

export interface DownloaderOptions {
  fetchFn?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  tunables?: Partial<DownloaderTunables>;
}

interface RunContext {
  downloadId: string;
  url: string;
  fileName: string;
  downloadedBytes: number;
  totalBytes: number | null;
  createdAt: number;
  etag: string | null;
  lastModified: string | null;
  // Some CDNs allowlist `Range` in CORS but not `If-Range`. Sending If-Range
  // then triggers a preflight that 403s, surfacing as a generic TypeError.
  // We try with If-Range once; on TypeError we retry without and flip this
  // flag for the rest of the session to skip the failed preflight on every
  // subsequent resume.
  skipIfRange: boolean;
  handle: SyncHandle;
  abortController: AbortController | null;
  startedAt: number;
  accumulatedPauseMs: number;
  currentPauseStartedAt: number;
  chunkCount: number;
}

// State machine for one download. EventTarget-based - no postMessage / OPFS
// knowledge. The Bus translates events to the wire protocol.
//
// Concurrency: every async run captures `runId` at entry. Any state transition
// (pause/resume/cancel/start) increments `generation`, so a stale loop bails at
// its next checkpoint without touching state that the new generation now owns.
// This replaces the implicit "queue serialises start/cancel" coupling with an
// explicit generation token.

export class Downloader extends EventTarget {
  private state: WorkerState = "idle";
  private generation = 0;
  private ctx: RunContext | null = null;
  // After a successful finalise, OPFS files are kept so the user can re-export
  // by clicking Download again (resumable: OPFS is the source of truth).
  // cancel() deletes them. Survives only the worker lifetime; on tab refresh,
  // listPending picks the entry up the same way it does for an incomplete .part.
  private lastCompletedId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private readonly tunables: DownloaderTunables;
  private readonly fetchFn: typeof fetch;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    options: DownloaderOptions = {},
  ) {
    super();
    // The browser's `fetch` must be called with the global as its receiver.
    // Storing it as a class field and invoking via `this.fetchFn(...)` would
    // call it with the Downloader as `this` > "Illegal invocation". Bind it
    // to the global scope (works for both real fetch and plain test stubs).
    this.fetchFn = (options.fetchFn ?? fetch).bind(globalThis);
    this.logger = options.logger ?? consoleLogger;
    this.now = options.now ?? (() => performance.now());
    this.tunables = { ...DOWNLOADER_DEFAULTS, ...(options.tunables ?? {}) };
  }

  on(handler: (e: DownloaderEvent) => void): () => void {
    const wrapped = (ev: Event) => handler((ev as CustomEvent<DownloaderEvent>).detail);
    this.addEventListener("event", wrapped);
    return () => this.removeEventListener("event", wrapped);
  }

  async start(url: string, fileName?: string): Promise<void> {
    if (this.state !== "idle") {
      this.emit({ type: "error", message: "A download is already active" });
      return;
    }

    const id = await sha256Id(url);
    const existing = await this.store.readMeta(id);
    const runId = ++this.generation;

    let handle: SyncHandle;
    try {
      handle = await this.store.openHandle(id);
    } catch (err) {
      this.handleOpenHandleError(err, { id, url });
      return;
    }
    if (this.isStaleRun(runId)) {
      tryOr(this.logger, "downloader.start.handle.close.stale", () => handle.close(), { id });
      return;
    }

    // getSize() is the authoritative resume offset. meta.downloadedBytes can
    // lag if the tab was killed between flushes.
    const downloadedBytes = handle.getSize();
    const finalFileName = existing?.fileName ?? fileName ?? deriveFileNameFromUrl(url);
    const totalBytes = existing?.totalBytes ?? null;
    const createdAt = existing?.createdAt ?? Date.now();

    // Reset elapsed timers on every start. The pause>resume flow uses resume()
    // which preserves them. After a process restart, start() is the entry
    // point and the previous in-memory startedAt is meaningless.
    this.ctx = {
      downloadId: id,
      url,
      fileName: finalFileName,
      downloadedBytes,
      totalBytes,
      createdAt,
      etag: existing?.etag ?? null,
      lastModified: existing?.lastModified ?? null,
      skipIfRange: existing?.skipIfRange ?? false,
      handle,
      abortController: null,
      startedAt: this.now(),
      accumulatedPauseMs: 0,
      currentPauseStartedAt: 0,
      chunkCount: 0,
    };
    if (!existing) await this.store.writeMeta(this.snapshotMeta());

    // Fast path: if the .part is already complete on disk, the user is
    // re-requesting the same file - re-export from OPFS without refetching.
    // OPFS is the source of truth for resumable downloads; we do not hit the
    // network for bytes we already have.
    if (totalBytes !== null && downloadedBytes >= totalBytes) {
      this.state = "downloading";
      void this.finalise(runId);
      return;
    }

    this.state = "downloading";
    this.startHeartbeat();
    void this.runLoop(runId);
  }

  // Heartbeat continues during pause - the master still owns the OPFS lock
  // and observer tabs need to know it's still alive.
  pause(): void {
    if (this.state !== "downloading" || !this.ctx) return;
    this.state = "paused";
    this.ctx.currentPauseStartedAt = this.now();
    this.ctx.abortController?.abort();
    // Kill the current loop; persistPauseStateIfRequested will write meta.
    this.generation++;
  }

  resume(): void {
    if (this.state !== "paused" || !this.ctx) return;
    this.ctx.accumulatedPauseMs += this.now() - this.ctx.currentPauseStartedAt;
    this.state = "downloading";
    void this.runLoop(++this.generation);
  }

  async cancel(): Promise<void> {
    const wasActive = this.state !== "idle";
    this.state = "cancelled";
    this.generation++;
    this.stopHeartbeat();
    const activeId = this.ctx?.downloadId ?? null;

    if (this.ctx) {
      this.ctx.abortController?.abort();
      tryOr(this.logger, "downloader.cancel.handle.close", () => this.ctx!.handle.close(), { id: activeId });
      this.ctx = null;
    }

    const idsToRemove = new Set<string>();
    if (activeId) idsToRemove.add(activeId);
    if (this.lastCompletedId) idsToRemove.add(this.lastCompletedId);
    this.lastCompletedId = null;
    for (const id of idsToRemove) {
      await tryOrAsync(this.logger, "downloader.cancel.store.remove", () => this.store.remove(id), { id });
    }
    this.state = "idle";
    if (wasActive || idsToRemove.size > 0) this.emit({ type: "status", status: "idle" });
  }

  async listPending(): Promise<DownloadMeta[]> {
    const all = await this.store.listAllMetas();
    return all.filter(isIncompleteMeta);
  }

  async clear(id: string): Promise<DownloadMeta[]> {
    if (this.ctx?.downloadId === id && this.state !== "idle") {
      // Refuse to delete files of an active download - caller should cancel first.
      this.emit({ type: "error", message: "Cannot clear an active download - cancel first." });
    } else {
      if (this.lastCompletedId === id) this.lastCompletedId = null;
      await tryOrAsync(this.logger, "downloader.clear.store.remove", () => this.store.remove(id), { id });
    }
    return this.listPending();
  }

  getSnapshot(): { state: WorkerState; ctx: Readonly<RunContext> | null; elapsed: number } {
    return { state: this.state, ctx: this.ctx, elapsed: this.elapsedMs() };
  }

  private async runLoop(runId: number): Promise<void> {
    const ctx = this.ctx!;
    ctx.abortController = new AbortController();
    const rangeStart = ctx.downloadedBytes;

    let response: Response;
    try {
      response = await this.fetchWithIfRangeFallback(ctx, rangeStart);
    } catch (err) {
      if (this.isStaleRun(runId)) return this.persistPauseStateIfRequested();
      return this.failAndReset("fetch.failed", err);
    }
    if (this.isStaleRun(runId)) return this.persistPauseStateIfRequested();

    if (!response.ok && response.status !== 206) {
      this.failAndReset("http.error", new Error(`HTTP ${response.status}: ${response.statusText}`));
      return;
    }

    if (rangeStart > 0 && response.status === 206) {
      const resumedRange = parseByteRange(response);
      if (!resumedRange || resumedRange.start !== rangeStart) {
        this.failAndReset(
          "range.invalid",
          new Error(`Server returned an invalid resumed range for byte ${rangeStart.toLocaleString()}.`),
        );
        return;
      }
    }

    // Range fallback: server returned 200 to a Range request, meaning either
    // no range support OR the resource changed (If-Range validator mismatch).
    // Truncate and write from offset 0. We prioritise byte-exact correctness
    // over preserving the existing bytes - the server's content may differ.
    let writeOffset: number;
    if (rangeStart > 0 && response.status === 200) {
      ctx.handle.truncate(0);
      ctx.downloadedBytes = 0;
      writeOffset = 0;
      const validatorMismatch = !!pickIfRangeValidator({ etag: ctx.etag, lastModified: ctx.lastModified });
      this.emit({
        type: "warning",
        code: validatorMismatch ? "validator-mismatch" : "range-unsupported",
        message: validatorMismatch
          ? `Server file changed since the partial download - restarting from 0 (${rangeStart.toLocaleString()} bytes discarded).`
          : `Server does not support resume - restarting from 0 (${rangeStart.toLocaleString()} bytes discarded).`,
      });
    } else {
      writeOffset = rangeStart;
    }

    ctx.totalBytes ??= parseTotalBytes(response, writeOffset);
    // Capture validators on the first response so future resumes can send
    // If-Range; also prefer server-provided filename now that we have it.
    const validator = readValidator(response);
    ctx.etag = validator.etag;
    ctx.lastModified = validator.lastModified;
    ctx.fileName = deriveFileName(response, ctx.url);

    await this.streamToDisk(runId, ctx, response);
  }

  private async streamToDisk(runId: number, ctx: RunContext, response: Response): Promise<void> {
    const reader = response.body!.getReader();
    let bytesSinceFlush = 0;
    let lastFlushAt = this.now();
    let lastProgressAt = 0;

    try {
      while (true) {
        if (this.isStaleRun(runId)) return this.cancelReaderAndExit(reader);

        const { done, value } = await reader.read();
        if (this.isStaleRun(runId)) return this.cancelReaderAndExit(reader);
        if (done) break;
        if (!value) continue;

        ctx.handle.write(value, { at: ctx.downloadedBytes });
        ctx.downloadedBytes += value.byteLength;
        ctx.chunkCount++;
        bytesSinceFlush += value.byteLength;

        const now = this.now();
        const flushDue =
          bytesSinceFlush >= this.tunables.flushBytes || now - lastFlushAt >= this.tunables.flushInterval;
        if (flushDue) {
          ctx.handle.flush();
          await this.store.writeMeta(this.snapshotMeta());
          if (this.isStaleRun(runId)) return this.persistPauseStateIfRequested();
          bytesSinceFlush = 0;
          lastFlushAt = now;
        }

        if (now - lastProgressAt >= this.tunables.progressInterval) {
          this.emitProgress();
          lastProgressAt = now;
        }
      }
    } catch (err) {
      if (this.isStaleRun(runId)) return this.persistPauseStateIfRequested();
      return this.failAndReset("stream.read.failed", err);
    }

    tryOr(this.logger, "downloader.stream.flush.failed", () => ctx.handle.flush());
    return this.finalise(runId);
  }

  private async cancelReaderAndExit(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    await tryOrAsync(this.logger, "downloader.reader.cancel.failed", () => reader.cancel());
    return this.persistPauseStateIfRequested();
  }

  private async finalise(runId: number): Promise<void> {
    if (this.isStaleRun(runId) || !this.ctx) return;
    const ctx = this.ctx;
    // For servers that omit Content-Length, fix up totalBytes from what we
    // actually wrote then emit a final progress.
    if (ctx.totalBytes === null) ctx.totalBytes = ctx.downloadedBytes;
    this.emitProgress();
    const elapsed = this.elapsedMs();
    const fileName = ctx.fileName;
    const id = ctx.downloadId;

    // Persist the final state to meta. Without this, the last batched
    // writeMeta during streaming leaves downloadedBytes lagging the actual
    // .part size, and the pending card on next page load shows a stale
    // partial count for a file that's actually complete.
    await this.store.writeMeta(this.snapshotMeta());

    tryOr(this.logger, "downloader.finalise.handle.close", () => ctx.handle.close(), { id });

    const totalBytes = ctx.totalBytes;
    this.state = "idle";
    this.ctx = null;
    this.stopHeartbeat();

    this.emit({ type: "complete", fileName, elapsed });
    // Delivery handled by the Service Worker - we only emit metadata, never
    // a File or ArrayBuffer. The UI registers `id` with the SW and navigates
    // to /_dl/<id>/<fileName>; the SW streams the .part as the response body
    // so OPFS isn't pinned by a main-thread blob URL.
    this.emit({ type: "data", id, fileName, totalBytes });
    this.lastCompletedId = id;
  }

  private isStaleRun(runId: number): boolean {
    return runId !== this.generation;
  }

  // Called when a stale loop exits. If pause was requested, persist meta
  // and announce status. Cancel paths clean up in cancel() itself.
  private async persistPauseStateIfRequested(): Promise<void> {
    if (this.state !== "paused" || !this.ctx) return;
    tryOr(this.logger, "downloader.pause.flush.failed", () => this.ctx!.handle.flush());
    await tryOrAsync(this.logger, "downloader.pause.writeMeta.failed", () => this.store.writeMeta(this.snapshotMeta()));
    this.emit({ type: "status", status: "paused" });
  }

  private failAndReset(event: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.log("error", `downloader.${event}`, { id: this.ctx?.downloadId, url: this.ctx?.url }, err);
    this.emit({ type: "error", message });
    if (this.ctx) {
      tryOr(this.logger, "downloader.fail.handle.close", () => this.ctx!.handle.close());
      this.ctx = null;
    }
    this.state = "idle";
    this.stopHeartbeat();
  }

  private handleOpenHandleError(err: unknown, ctx: { id: string; url: string }): void {
    const e = err as DOMException & Error;
    const exclusive = e?.name === "NoModificationAllowedError" || e?.name === "InvalidStateError";
    const message = exclusive
      ? "This download is already active in another tab."
      : `OPFS error: ${e?.message ?? String(err)}`;
    this.logger.log("error", exclusive ? "downloader.openHandle.locked" : "downloader.openHandle.failed", ctx, err);
    this.emit({ type: "error", message });
  }

  // Issues the resume fetch. If the first attempt sent If-Range and threw a
  // TypeError ("Failed to fetch") - the signature of a CORS preflight rejection
  // because the server allowlists Range but not If-Range - retry once without
  // If-Range and remember the decision for the rest of the session. Other
  // errors (abort, real network failure) propagate.
  private async fetchWithIfRangeFallback(ctx: RunContext, rangeStart: number): Promise<Response> {
    const signal = ctx.abortController!.signal;
    const headers = this.buildRequestHeaders(rangeStart, ctx);
    const sentIfRange = "If-Range" in headers;
    try {
      return await this.fetchFn(ctx.url, { signal, headers });
    } catch (err) {
      if (!sentIfRange || !isLikelyCorsPreflightFailure(err) || signal.aborted) throw err;
      this.logger.log("warn", "downloader.fetch.ifRangeStripped", { id: ctx.downloadId, url: ctx.url }, err);
      ctx.skipIfRange = true;
      // Persist so future runs (page refresh, pending-card resume) skip the
      // failed preflight on the very first attempt.
      await tryOrAsync(this.logger, "downloader.fetch.persistSkipIfRange.failed", () =>
        this.store.writeMeta(this.snapshotMeta()),
      );
      const retryHeaders = this.buildRequestHeaders(rangeStart, ctx);
      return this.fetchFn(ctx.url, { signal, headers: retryHeaders });
    }
  }

  private buildRequestHeaders(rangeStart: number, ctx: RunContext): Record<string, string> {
    if (rangeStart === 0) return {};
    const headers: Record<string, string> = { Range: `bytes=${rangeStart}-` };
    if (!ctx.skipIfRange) {
      const validator = pickIfRangeValidator({ etag: ctx.etag, lastModified: ctx.lastModified });
      if (validator) headers["If-Range"] = validator;
    }
    return headers;
  }

  // Heartbeats let observer tabs detect a dead master and take over without
  // a page refresh. Active only while a download is downloading or paused.
  private startHeartbeat(): void {
    if (this.heartbeatTimer || this.tunables.heartbeatInterval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.ctx) this.emit({ type: "heartbeat", url: this.ctx.url });
    }, this.tunables.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private snapshotMeta(): DownloadMeta {
    const c = this.ctx!;
    return {
      id: c.downloadId,
      url: c.url,
      fileName: c.fileName,
      downloadedBytes: c.downloadedBytes,
      totalBytes: c.totalBytes,
      createdAt: c.createdAt,
      etag: c.etag,
      lastModified: c.lastModified,
      skipIfRange: c.skipIfRange,
    };
  }

  private elapsedMs(): number {
    if (!this.ctx) return 0;
    const live =
      this.state === "paused"
        ? this.ctx.currentPauseStartedAt - this.ctx.startedAt - this.ctx.accumulatedPauseMs
        : this.now() - this.ctx.startedAt - this.ctx.accumulatedPauseMs;
    return Math.max(0, live);
  }

  private emitProgress(): void {
    const c = this.ctx!;
    const pct = c.totalBytes ? Math.round((c.downloadedBytes / c.totalBytes) * 100) : null;
    this.emit({
      type: "progress",
      payload: {
        downloaded: c.downloadedBytes,
        total: c.totalBytes,
        percentage: pct,
        chunks: c.chunkCount,
        elapsed: this.elapsedMs(),
      },
    });
  }

  private emit(detail: DownloaderEvent): void {
    this.dispatchEvent(new CustomEvent("event", { detail }));
  }
}

export function isIncompleteMeta(meta: DownloadMeta): boolean {
  return meta.downloadedBytes > 0 && (meta.totalBytes === null || meta.downloadedBytes < meta.totalBytes);
}

// CORS / network rejections in the browser are deliberately opaque - all we
// see is `TypeError: Failed to fetch`. We can't distinguish "server is down"
// from "preflight rejected If-Range", but we only attempt the fallback after
// having sent If-Range, so the false-positive cost is one extra request when
// the network is genuinely unreachable.
function isLikelyCorsPreflightFailure(err: unknown): boolean {
  return err instanceof TypeError;
}
