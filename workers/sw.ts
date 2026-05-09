/// <reference lib="webworker" />

// Service Worker for download delivery.
//
// Why this exists: previously the dedicated worker transferred the OPFS-
// backed File to the main thread which created a blob URL. The browser
// pinned the OPFS .part for the lifetime of any in-flight download stream,
// so Discard's removeEntry call failed silently and the cached file
// survived - making the next Download fast-path the stale copy.
//
// Flow:
//   1. UI receives `data { id, fileName, totalBytes }` from the dedicated worker.
//   2. UI navigates a hidden anchor to `/_dl/<id>/<encoded-filename>`.
//   3. SW intercepts that fetch, opens the OPFS .part by id, streams it as
//      the response body. Content-Length comes from the OPFS file's size,
//      Content-Disposition filename from the URL.
//   4. Browser's downloads UI saves the streamed response as a file.
//   5. When the stream finishes (or is cancelled), the SW drops its OPFS
//      reference. The .part is then unpinned.
//   6. Discard sends `abort-delivery`, SW cancels the active stream, then
//      the dedicated worker's removeEntry succeeds.
//
// Important: there is no in-memory registration map. Service Workers can be
// terminated by the browser between any two events, so any state that lives
// only in JS variables can vanish silently. OPFS itself is the source of
// truth - if the .part exists, the URL is valid; if it doesn't, 404.
//
// We deliberately do NOT use Comlink here. SW lifetime is unpredictable;
// a Comlink port goes dead on restart while the UI's cached proxy still
// looks valid. Plain postMessage on `navigator.serviceWorker.controller`
// always re-resolves to the current active SW.

import { PART_EXT, SYNTHETIC_DOWNLOAD_PREFIX } from "./lib/constants.js";
import { consoleLogger, tryOrAsync } from "./lib/logger.js";

declare const self: ServiceWorkerGlobalScope;

const logger = consoleLogger;
// activeReaders is best-effort cancel-on-discard. If the SW restarts the map
// is empty and the in-flight Response is already broken anyway - whoever was
// reading it gets a network error and the OPFS handle releases naturally.
const activeReaders = new Map<string, ReadableStreamDefaultReader<Uint8Array>>();

export type SwRequest = { type: "abort-delivery"; id: string } | { type: "ping" };

export type SwReply = { type: "aborted" } | { type: "pong" };

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const data = event.data as SwRequest | undefined;
  const port = event.ports[0];
  const reply = (msg: SwReply) => {
    try {
      port?.postMessage(msg);
    } catch (err) {
      logger.log("warn", "sw.reply.failed", { type: data?.type }, err);
    }
  };
  switch (data?.type) {
    case "abort-delivery":
      cancelActiveReader(data.id, "abort");
      reply({ type: "aborted" });
      break;
    case "ping":
      reply({ type: "pong" });
      break;
  }
});

function cancelActiveReader(id: string, reason: string): void {
  const reader = activeReaders.get(id);
  if (!reader) return;
  reader.cancel().catch((err) => logger.log("warn", "sw.reader.cancel.failed", { id, reason }, err));
  activeReaders.delete(id);
}

self.addEventListener("fetch", (event) => {
  // Hard guard: only ever consider GETs to our synthetic delivery prefix.
  // Anything else - app HTML, the dedicated worker bundle, Next.js HMR
  // websockets, third-party fetches - falls through untouched.
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(SYNTHETIC_DOWNLOAD_PREFIX)) return;
  // /_dl/<id>/<encoded-filename> - both id and fileName are extracted from
  // the URL itself so no UI-side state needs to survive an SW restart.
  const tail = url.pathname.slice(SYNTHETIC_DOWNLOAD_PREFIX.length);
  const slash = tail.indexOf("/");
  if (slash < 0) {
    event.respondWith(new Response("bad request", { status: 400 }));
    return;
  }
  const id = tail.slice(0, slash);
  const fileName = decodeURIComponent(tail.slice(slash + 1));
  event.respondWith(serveDownload(id, fileName));
});

async function serveDownload(id: string, fileName: string): Promise<Response> {
  const file = await tryOrAsync(
    logger,
    "sw.opfs.openPart.failed",
    async () => {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(id + PART_EXT);
      return fh.getFile();
    },
    { id },
  );
  if (!file) return new Response("not found", { status: 404 });

  const sourceReader = file.stream().getReader();
  activeReaders.set(id, sourceReader);

  const respStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await sourceReader.read();
        if (done) {
          controller.close();
          activeReaders.delete(id);
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        logger.log("warn", "sw.stream.pull.failed", { id }, err);
        controller.error(err);
        activeReaders.delete(id);
      }
    },
    cancel() {
      cancelActiveReader(id, "stream-cancel");
    },
  });

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Content-Length": String(file.size),
    "Cache-Control": "no-store",
  });

  return new Response(respStream, { status: 200, headers });
}
