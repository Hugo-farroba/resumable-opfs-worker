// Test fixtures: in-memory Store + programmable fetch.
// Not exported from production code - only imported by *.test.ts files.

import type { DownloadMeta, Store, SyncHandle } from "./types.js";

class MemoryHandle implements SyncHandle {
  constructor(
    private bag: { bytes: Uint8Array },
    private onClose?: () => void,
  ) {}
  private closed = false;
  write(buf: ArrayBuffer | ArrayBufferView, opts: { at: number }): number {
    if (this.closed) throw new Error("handle closed");
    const view =
      buf instanceof ArrayBuffer
        ? new Uint8Array(buf)
        : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const end = opts.at + view.byteLength;
    if (end > this.bag.bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.bag.bytes);
      this.bag.bytes = grown;
    }
    this.bag.bytes.set(view, opts.at);
    return view.byteLength;
  }
  flush(): void {
    /* no-op in memory */
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.onClose?.();
    }
  }
  getSize(): number {
    return this.bag.bytes.byteLength;
  }
  truncate(size: number): void {
    const grown = new Uint8Array(size);
    grown.set(this.bag.bytes.subarray(0, Math.min(size, this.bag.bytes.byteLength)));
    this.bag.bytes = grown;
  }
}

export class MemoryStore implements Store {
  private parts = new Map<string, { bytes: Uint8Array }>();
  private metas = new Map<string, DownloadMeta>();
  private locks = new Set<string>();

  async readMeta(id: string): Promise<DownloadMeta | null> {
    return this.metas.get(id) ?? null;
  }
  async writeMeta(meta: DownloadMeta): Promise<void> {
    this.metas.set(meta.id, structuredClone(meta));
  }
  async remove(id: string): Promise<void> {
    this.parts.delete(id);
    this.metas.delete(id);
    this.locks.delete(id);
  }
  async listAllMetas(): Promise<DownloadMeta[]> {
    return Array.from(this.metas.values()).map((m) => structuredClone(m));
  }
  async openHandle(id: string): Promise<SyncHandle> {
    if (this.locks.has(id)) {
      const err = new Error("locked");
      (err as Error & { name: string }).name = "NoModificationAllowedError";
      throw err;
    }
    this.locks.add(id);
    if (!this.parts.has(id)) this.parts.set(id, { bytes: new Uint8Array(0) });
    return new MemoryHandle(this.parts.get(id)!, () => this.locks.delete(id));
  }
  async getFile(id: string): Promise<Blob> {
    const part = this.parts.get(id);
    if (!part) throw new Error("no part");
    const copy = new ArrayBuffer(part.bytes.byteLength);
    new Uint8Array(copy).set(part.bytes);
    return new Blob([copy]);
  }

  // Test helpers
  bytesOf(id: string): Uint8Array {
    return this.parts.get(id)?.bytes ?? new Uint8Array(0);
  }
  metaOf(id: string): DownloadMeta | undefined {
    return this.metas.get(id);
  }
  // Simulates the OS releasing the OPFS exclusive lock when a tab/worker dies.
  forceUnlock(id: string): void {
    this.locks.delete(id);
  }
}

// ---------------- Programmable fetch ----------------

export interface ScriptedResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  // Either a static body or a generator that yields chunks (with optional delays).
  chunks: Uint8Array[];
  // If set, throw this error after the Nth chunk emit.
  throwAfter?: number;
  // Delay in ms between chunks. Default 0.
  chunkDelayMs?: number;
}

export interface ScriptEntry {
  // If set, this entry only matches when the request has Range header starting at this byte.
  rangeStart?: number;
  // If true, match only when no Range header is present.
  noRange?: boolean;
  response: ScriptedResponse;
}

export function makeFakeFetch(scripts: ScriptEntry[]): typeof fetch {
  const fn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("range");
    const rangeStart = range ? parseInt(range.match(/bytes=(\d+)-/)?.[1] ?? "0", 10) : null;

    const entry = scripts.find((s) => {
      if (s.noRange) return rangeStart === null;
      if (s.rangeStart !== undefined) return rangeStart === s.rangeStart;
      return true;
    });
    if (!entry) throw new Error(`no script matched (rangeStart=${rangeStart})`);

    const r = entry.response;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let i = 0;
        for (const chunk of r.chunks) {
          if (init?.signal?.aborted) {
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          if (r.throwAfter !== undefined && i >= r.throwAfter) {
            controller.error(new Error("connection reset"));
            return;
          }
          controller.enqueue(chunk);
          i++;
          await new Promise((res) => setTimeout(res, r.chunkDelayMs ?? 0));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: r.status ?? 200,
      statusText: r.statusText ?? "OK",
      headers: r.headers,
    });
  };
  return fn;
}

export function chunkBytes(total: number, chunkSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i += chunkSize) {
    const len = Math.min(chunkSize, total - i);
    const c = new Uint8Array(len);
    for (let j = 0; j < len; j++) c[j] = (i + j) & 0xff;
    out.push(c);
  }
  return out;
}

// Drain all events from a Downloader into an array for assertions.
import type { Downloader } from "./downloader.js";
import type { DownloaderEvent } from "./types.js";
export function recordEvents(d: Downloader): { events: DownloaderEvent[]; off: () => void } {
  const events: DownloaderEvent[] = [];
  const off = d.on((e) => events.push(e));
  return { events, off };
}
