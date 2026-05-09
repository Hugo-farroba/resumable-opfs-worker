// workers/lib/constants.ts
var FLUSH_BYTES = 4 * 1024 * 1024;
var SYNTHETIC_DOWNLOAD_PREFIX = "/_dl/";
var PART_EXT = ".part";

// workers/lib/logger.ts
function serializeError(err) {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause !== undefined ? serializeError(err.cause) : undefined
    };
  }
  return { name: "NonError", message: String(err) };
}
var consoleLogger = {
  log(level, event, ctx, err) {
    const payload = { event, ...ctx ?? {} };
    if (err !== undefined)
      payload.error = serializeError(err);
    const line = `[downloader] ${event}`;
    switch (level) {
      case "debug":
      case "info":
        console.log(line, payload);
        break;
      case "warn":
        console.warn(line, payload);
        break;
      case "error":
        console.error(line, payload);
        break;
    }
  }
};
async function tryOrAsync(logger, event, fn, ctx) {
  try {
    return await fn();
  } catch (err) {
    logger.log("warn", event, ctx, err);
    return;
  }
}

// workers/sw.ts
var logger = consoleLogger;
var activeReaders = new Map;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => {
  const data = event.data;
  const port = event.ports[0];
  const reply = (msg) => {
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
function cancelActiveReader(id, reason) {
  const reader = activeReaders.get(id);
  if (!reader)
    return;
  reader.cancel().catch((err) => logger.log("warn", "sw.reader.cancel.failed", { id, reason }, err));
  activeReaders.delete(id);
}
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET")
    return;
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith(SYNTHETIC_DOWNLOAD_PREFIX))
    return;
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
async function serveDownload(id, fileName) {
  const file = await tryOrAsync(logger, "sw.opfs.openPart.failed", async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(id + PART_EXT);
    return fh.getFile();
  }, { id });
  if (!file)
    return new Response("not found", { status: 404 });
  const sourceReader = file.stream().getReader();
  activeReaders.set(id, sourceReader);
  const respStream = new ReadableStream({
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
    }
  });
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Content-Length": String(file.size),
    "Cache-Control": "no-store"
  });
  return new Response(respStream, { status: 200, headers });
}
