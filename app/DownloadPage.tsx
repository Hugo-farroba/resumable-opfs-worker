"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as Comlink from "comlink";
import prettyBytes from "pretty-bytes";
import prettyMs from "pretty-ms";
import {
  ABORT_DELIVERY_TIMEOUT_MS,
  BROADCAST_CHANNEL_NAME,
  SPEED_WINDOW_MS,
  STALE_AFTER_MS,
  SW_CONTROLLER_WAIT_MS,
} from "../workers/lib/constants";
import { consoleLogger } from "../workers/lib/logger";
import { parseBroadcastEnvelope } from "../workers/lib/wire";
import type { WorkerApi } from "../workers/download-worker";
import type { SwReply, SwRequest } from "../workers/sw";
import type { DownloadMeta } from "../workers/lib/types";

type DownloadStatus = "idle" | "downloading" | "paused" | "complete" | "error";

interface DownloadState {
  status: DownloadStatus;
  downloaded: number;
  total: number | null;
  percentage: number | null;
  error: string | null;
  warning: string | null;
  fileName: string | null;
  chunks: number;
  elapsedMs: number;
  // false when this tab is observing another tab's active download
  isLocal: boolean;
}

const INITIAL_STATE: DownloadState = {
  status: "idle",
  downloaded: 0,
  total: null,
  percentage: null,
  error: null,
  warning: null,
  fileName: null,
  chunks: 0,
  elapsedMs: 0,
  isLocal: false,
};

const log = consoleLogger;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// The SW (workers/sw.ts) intercepts /_dl/<id>/<fileName> fetches and streams
// the OPFS .part as the response body.
//
// Each call grabs the live `navigator.serviceWorker.controller` and uses a
// fresh MessagePort for the reply. Comlink would cache a port that goes dead
// when the browser terminates the SW idly - typed RPC isn't worth a hung download.

let swReadyPromise: Promise<ServiceWorker | null> | null = null;

function ensureSwController(): Promise<ServiceWorker | null> {
  if (swReadyPromise) return swReadyPromise;
  swReadyPromise = (async () => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return waitForController(reg);
  })();
  return swReadyPromise;
}

function waitForController(reg: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (navigator.serviceWorker.controller) return Promise.resolve(navigator.serviceWorker.controller);
  return new Promise((resolve) => {
    const onChange = () => {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.removeEventListener("controllerchange", onChange);
        resolve(navigator.serviceWorker.controller);
      }
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    setTimeout(() => resolve(reg.active ?? null), SW_CONTROLLER_WAIT_MS);
  });
}

function swRequest(req: SwRequest, timeoutMs: number): Promise<SwReply> {
  // Always re-read the controller - the browser may have replaced it since
  // the last call (SW restart, skipWaiting transition).
  const sw = navigator.serviceWorker.controller;
  if (!sw) return Promise.reject(new Error("Service Worker not available"));
  return new Promise<SwReply>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => reject(new Error(`SW ${req.type} timed out`)), timeoutMs);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data as SwReply);
    };
    sw.postMessage(req, [channel.port2]);
  });
}

async function deliverViaServiceWorker(id: string, fileName: string): Promise<void> {
  // Wait for the SW to be controlling - otherwise the browser sends /_dl/...
  // straight to the network (Next.js dev server / 404). Once we have a
  // controller, the OPFS .part itself authorises the URL; no registration
  // round-trip required, so there's nothing to lose if the SW restarts.
  const sw = await ensureSwController();
  if (!sw) throw new Error("Service Worker not available");
  if (!navigator.serviceWorker.controller) {
    // SW activated but this client isn't yet controlled (first-install
    // sequence). Wait for clients.claim() to take effect; the alternative is
    // a 404 from the dev server because the iframe fetch bypasses the SW.
    await new Promise<void>((resolve) => {
      const onChange = () => {
        navigator.serviceWorker.removeEventListener("controllerchange", onChange);
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", onChange);
      setTimeout(resolve, SW_CONTROLLER_WAIT_MS);
    });
  }

  // Hidden iframe trick: navigating an iframe to a synthetic URL whose
  // response carries `Content-Disposition: attachment` causes the browser to
  // hand the response off to the download manager. The iframe stays empty.
  // This is more reliable across browsers than `<a download>.click()`, which
  // has historically been hit-and-miss when the anchor isn't in the DOM.
  const url = `/_dl/${encodeURIComponent(id)}/${encodeURIComponent(fileName)}`;
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = url;
  document.body.appendChild(iframe);
  // Keep the iframe alive long enough for the response to land in the
  // download manager, then clean up. 60s is well past any reasonable header
  // round-trip - the body itself streams through the download manager
  // independent of the iframe.
  setTimeout(() => iframe.remove(), 60_000);
}

async function abortDelivery(id: string): Promise<void> {
  const sw = await ensureSwController();
  if (!sw) return;
  try {
    await swRequest({ type: "abort-delivery", id }, ABORT_DELIVERY_TIMEOUT_MS);
  } catch (err) {
    log.log("warn", "ui.swAbort.failed", { id }, err);
  }
}

function barWidth(dl: DownloadState): number {
  if (dl.status === "complete") return 100;
  if (dl.total && dl.total > 0) return Math.min(100, Math.round((dl.downloaded / dl.total) * 100));
  return dl.status === "downloading" ? 5 : 0;
}

function formatBytes(bytes: number): string {
  return prettyBytes(bytes, { maximumFractionDigits: 2 });
}

function formatElapsed(ms: number): string {
  return prettyMs(ms, { secondsDecimalDigits: 0 });
}

function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export default function DownloadPage() {
  const [url, setUrl] = useState("");
  const [dl, setDl] = useState<DownloadState>(INITIAL_STATE);
  const [workerReady, setWorkerReady] = useState(false);
  const [pending, setPending] = useState<DownloadMeta[]>([]);
  const workerRef = useRef<Worker | null>(null);
  const apiRef = useRef<Comlink.Remote<WorkerApi> | null>(null);
  const workerIdRef = useRef<string | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const lastDeliveryIdRef = useRef<string | null>(null);

  const speedSamplesRef = useRef<{ t: number; bytes: number }[]>([]);
  const [speed, setSpeed] = useState<number | null>(null);

  // Master-tab liveness tracking. While observing another tab's download, its
  // worker broadcasts heartbeats every HEARTBEAT_INTERVAL_MS. If we stop seeing
  // them for STALE_AFTER_MS, the master is presumed dead and we surface a
  // Take over button. Click > we send `start` to our own worker, which acquires
  // the OPFS lock (released by the dead tab) and resumes the download.
  const [remote, setRemote] = useState<{ url: string | null; lastBeatAt: number }>({ url: null, lastBeatAt: 0 });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void ensureSwController();

    const worker = new Worker("/workers/download-worker.js", { type: "module" });
    workerRef.current = worker;
    const api = Comlink.wrap<WorkerApi>(worker);
    apiRef.current = api;

    const bc = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    bcRef.current = bc;

    worker.onerror = (e: ErrorEvent) => {
      setDl((prev) => ({ ...prev, status: "error", error: `Worker error: ${e.message}` }));
    };

    // Direct postMessages from the worker: `ping` (workerId handshake) and
    // `data` (delivery cue). Everything else flows over BroadcastChannel.
    worker.addEventListener("message", (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === "ping" && typeof msg.workerId === "string") {
        workerIdRef.current = msg.workerId;
        setWorkerReady(true);
        void api
          .listPending()
          .then(setPending)
          .catch((err) => log.log("warn", "ui.listPending.failed", {}, err));
        bc.postMessage({ type: "request-state", _wid: msg.workerId });
      } else if (msg?.type === "data" && typeof msg.id === "string") {
        const { id, fileName } = msg as { id: string; fileName: string };
        deliverViaServiceWorker(id, fileName).catch((err) => {
          setDl((prev) => ({ ...prev, status: "error", error: `Delivery failed: ${err?.message ?? String(err)}` }));
        });
        lastDeliveryIdRef.current = id;
      }
    });

    bc.onmessage = (e: MessageEvent) => {
      const env = parseBroadcastEnvelope(e.data, log);
      if (!env) return;
      const isLocal = env._wid === workerIdRef.current;
      handleBroadcast(env, isLocal);
    };

    function handleBroadcast(msg: ReturnType<typeof parseBroadcastEnvelope> & object, isLocal: boolean) {
      if (!msg) return;
      switch (msg.type) {
        case "progress": {
          if (!isLocal) setRemote((prev) => ({ ...prev, lastBeatAt: Date.now() }));
          if (isLocal) updateSpeed(msg.downloaded);
          setDl((prev) => {
            if (!isLocal && prev.isLocal) return prev;
            // Forward progress means the previous error/warning is stale.
            return {
              ...prev,
              isLocal,
              status: "downloading",
              error: null,
              warning: null,
              downloaded: msg.downloaded,
              total: msg.total,
              percentage: msg.percentage,
              chunks: msg.chunks,
              elapsedMs: msg.elapsed,
            };
          });
          break;
        }
        case "status":
          setDl((prev) => {
            if (!isLocal && prev.isLocal) return prev;
            if (msg.status === "idle" && !isLocal) return INITIAL_STATE;
            // downloading / paused are forward-progress states - drop stale error.
            const clearError = msg.status === "downloading" || msg.status === "paused";
            return {
              ...prev,
              isLocal,
              status: msg.status,
              error: clearError ? null : prev.error,
              warning: clearError ? null : prev.warning,
            };
          });
          break;
        case "complete":
          setDl((prev) => {
            if (!isLocal && prev.isLocal) return prev;
            return {
              ...prev,
              isLocal,
              status: "complete",
              error: null,
              warning: null,
              fileName: msg.fileName,
              elapsedMs: msg.elapsed,
            };
          });
          if (isLocal) {
            resetSpeed();
            void api
              .listPending()
              .then(setPending)
              .catch((err) => log.log("warn", "ui.listPending.failed", {}, err));
          }
          break;
        case "pending-downloads":
          setPending(msg.downloads);
          break;
        case "error":
          setDl((prev) => {
            if (!isLocal && prev.isLocal) return prev;
            return { ...prev, isLocal, status: "error", error: msg.message };
          });
          if (isLocal) resetSpeed();
          break;
        case "warning":
          setDl((prev) => {
            if (!isLocal && prev.isLocal) return prev;
            return { ...prev, isLocal, warning: msg.message };
          });
          break;
        case "heartbeat":
          if (!isLocal) setRemote({ url: msg.url, lastBeatAt: Date.now() });
          break;
        case "goodbye":
          // Master tab closing gracefully; observers go stale on next render.
          if (!isLocal) {
            setRemote((prev) => ({
              url: msg.url ?? prev.url,
              lastBeatAt: 1, // any value > 0 but old enough to be stale next render
            }));
          }
          break;
        case "state-snapshot": {
          const s = msg.state;
          if (!isLocal) setRemote({ url: s.url, lastBeatAt: Date.now() });
          setDl((prev) =>
            prev.isLocal
              ? prev
              : {
                  ...prev,
                  isLocal: false,
                  status: s.status,
                  // A live snapshot from the master means any error we
                  // previously latched from a transient broadcast is stale.
                  error: null,
                  warning: null,
                  downloaded: s.downloaded,
                  total: s.total,
                  percentage: s.percentage,
                  fileName: s.fileName,
                  chunks: s.chunks,
                  elapsedMs: s.elapsed,
                },
          );
          break;
        }
        case "request-state":
          // Handled by worker, not the UI.
          break;
      }
    }

    function updateSpeed(downloaded: number) {
      const t = performance.now();
      const buf = speedSamplesRef.current;
      let cut = 0;
      while (cut < buf.length && t - buf[cut].t >= SPEED_WINDOW_MS) cut++;
      if (cut > 0) buf.splice(0, cut);
      buf.push({ t, bytes: downloaded });
      if (buf.length >= 2) {
        const dt = (buf[buf.length - 1].t - buf[0].t) / 1000;
        setSpeed(dt > 0 ? (buf[buf.length - 1].bytes - buf[0].bytes) / dt : null);
      }
    }

    function resetSpeed() {
      setSpeed(null);
      speedSamplesRef.current = [];
    }

    return () => {
      worker.terminate();
      bc.close();
    };
  }, []);

  const observing = !dl.isLocal && (dl.status === "downloading" || dl.status === "paused");
  useEffect(() => {
    if (!observing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [observing]);

  const isMaster = dl.isLocal && (dl.status === "downloading" || dl.status === "paused");
  useEffect(() => {
    if (!isMaster) return;
    const handler = () => {
      const wid = workerIdRef.current;
      if (!wid) return;
      bcRef.current?.postMessage({ type: "goodbye", _wid: wid, url: url || dl.fileName });
    };
    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", handler);
    };
  }, [isMaster, url, dl.fileName]);

  const remoteStale = observing && remote.lastBeatAt > 0 && now - remote.lastBeatAt > STALE_AFTER_MS;
  const busy = dl.status === "paused" && dl.isLocal;

  const startDownload = (targetUrl: string) => {
    speedSamplesRef.current = [];
    setSpeed(null);
    setDl({ ...INITIAL_STATE, status: "downloading", isLocal: true });
    void apiRef.current?.start(targetUrl).catch((err) => log.log("error", "ui.start.failed", { targetUrl }, err));
  };

  const handleStart = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    startDownload(trimmed);
  };

  const handlePause = () => {
    setDl((prev) => ({ ...prev, status: "paused" }));
    void apiRef.current?.pause();
  };

  const handleResume = () => {
    setDl((prev) => ({ ...prev, status: "downloading" }));
    void apiRef.current?.resume();
  };

  const handleCancel = () => {
    void apiRef.current?.cancel();
    speedSamplesRef.current = [];
    setSpeed(null);
    setDl(INITIAL_STATE);
    void apiRef.current
      ?.listPending()
      .then(setPending)
      .catch(() => {});
  };

  // Discard deletes the OPFS files and returns the UI to its initial empty state.
  // Order matters: tell the SW to abort any active delivery stream FIRST,
  // so OPFS isn't held by the SW's response when the worker's removeEntry
  // runs. The worker's cancel is fired in parallel - by the time the SW's
  // abort round-trip returns, the worker has the OPFS lock free to delete.
  const handleReset = () => {
    const id = lastDeliveryIdRef.current;
    lastDeliveryIdRef.current = null;
    if (id) void abortDelivery(id);
    void apiRef.current?.cancel();
    speedSamplesRef.current = [];
    setSpeed(null);
    setDl(INITIAL_STATE);
    void apiRef.current
      ?.listPending()
      .then(setPending)
      .catch(() => {});
  };

  const handleTakeover = () => {
    const targetUrl = remote.url;
    if (!targetUrl) return;
    setRemote({ url: null, lastBeatAt: 0 });
    startDownload(targetUrl);
  };

  const handleResumePending = (p: DownloadMeta) => {
    setUrl(p.url);
    startDownload(p.url);
  };

  const handleDiscardPending = (id: string) => {
    void apiRef.current
      ?.clear(id)
      .then(setPending)
      .catch((err) => log.log("warn", "ui.clear.failed", { id }, err));
  };

  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-start justify-center p-8">
      <div className="w-full max-w-xl mt-16 space-y-6">
        {pending.length > 0 && dl.status === "idle" && (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-3">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
              Incomplete downloads - pick up where you left off
            </p>
            {pending.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-zinc-800 dark:text-zinc-200 truncate">{p.fileName}</p>
                  <p className="text-xs text-zinc-500">
                    {formatBytes(p.downloadedBytes)}
                    {p.totalBytes ? ` / ${formatBytes(p.totalBytes)}` : ""} saved
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <ActionButton onClick={() => handleResumePending(p)} variant="primary">
                    Resume
                  </ActionButton>
                  <ActionButton onClick={() => handleDiscardPending(p.id)} variant="danger">
                    Discard
                  </ActionButton>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && dl.status === "idle" && handleStart()}
            placeholder="https://example.com/file.zip"
            disabled={busy}
            className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900
                       px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400
                       focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          />
          <button
            onClick={handleStart}
            disabled={busy || !url.trim()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white
                       hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Download
          </button>
        </div>

        {dl.status !== "idle" && (
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <StatusBadge status={dl.status} stalled={!dl.isLocal && remoteStale} />
              <WorkerBadge ready={workerReady} />
              {dl.fileName && (
                <span className="text-xs text-zinc-500 truncate max-w-[55%]">{safeDecode(dl.fileName)}</span>
              )}
            </div>

            <div className="w-full h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-150 ${
                  !dl.isLocal && remoteStale ? "bg-zinc-400 dark:bg-zinc-600" : "bg-blue-500"
                }`}
                style={{ width: `${barWidth(dl)}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <Metric label="Downloaded">
                {formatBytes(dl.downloaded)}
                {dl.total !== null && ` / ${formatBytes(dl.total)}`}
                {dl.total !== null && dl.total > 0 && ` (${barWidth(dl)}%)`}
              </Metric>
              <Metric label="Speed">{speed != null ? formatSpeed(speed) : "-"}</Metric>
              <Metric label="Chunks">{dl.chunks > 0 ? dl.chunks : "-"}</Metric>
              <Metric label="Elapsed">{dl.elapsedMs > 0 ? formatElapsed(dl.elapsedMs) : "-"}</Metric>
            </div>

            {dl.warning && (
              <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 rounded p-2">
                {dl.warning}
              </p>
            )}

            {dl.error && <p className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 rounded p-2">{dl.error}</p>}

            <div className="flex gap-2 flex-wrap justify-end">
              {!dl.isLocal && (dl.status === "downloading" || dl.status === "paused") && !remoteStale && (
                <span className="text-xs text-zinc-400 self-center">Active in another tab</span>
              )}
              {!dl.isLocal && (dl.status === "downloading" || dl.status === "paused") && remoteStale && (
                <ActionButton onClick={handleTakeover} variant="primary">
                  Take over
                </ActionButton>
              )}
              {dl.isLocal && dl.status === "downloading" && (
                <ActionButton onClick={handlePause} variant="secondary">
                  Pause
                </ActionButton>
              )}
              {dl.isLocal && busy && (
                <ActionButton onClick={handleCancel} variant="danger">
                  Remove
                </ActionButton>
              )}
              {dl.isLocal && dl.status === "paused" && (
                <ActionButton onClick={handleResume} variant="primary">
                  Resume
                </ActionButton>
              )}
              {dl.isLocal && (dl.status === "complete" || dl.status === "error") && (
                <ActionButton onClick={handleReset} variant="danger">
                  Discard
                </ActionButton>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function WorkerBadge({ ready }: { ready: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors
      ${
        ready
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-600"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${ready ? "bg-emerald-500" : "bg-zinc-400"}`} />
      Web Worker {ready ? "ready" : "loading…"}
    </span>
  );
}

function Metric({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div>
      {label && <span className="text-zinc-400">{label}: </span>}
      <span className="text-zinc-700 dark:text-zinc-300 font-mono">{children}</span>
    </div>
  );
}

function StatusBadge({ status, stalled }: { status: DownloadStatus; stalled?: boolean }) {
  // When observing a remote tab whose heartbeat went silent, the underlying
  // dl.status is still whatever the last snapshot said but no bytes are
  // flowing. Surface that as a distinct "Stalled" badge.
  if (stalled) {
    return (
      <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300">
        Stalled
      </span>
    );
  }
  const map: Record<DownloadStatus, { label: string; cls: string }> = {
    idle: { label: "Idle", cls: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" },
    downloading: { label: "Downloading", cls: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" },
    paused: { label: "Paused", cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300" },
    complete: { label: "Complete", cls: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" },
    error: { label: "Error", cls: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
  };
  const { label, cls } = map[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
  );
}

function ActionButton({
  onClick,
  variant,
  children,
}: {
  onClick: () => void;
  variant: "primary" | "secondary" | "danger";
  children: ReactNode;
}) {
  const cls = {
    primary: "bg-green-600 text-white hover:bg-green-700",
    secondary:
      "border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800",
    danger: "bg-red-600 text-white hover:bg-red-700",
  }[variant];
  return (
    <button onClick={onClick} className={`rounded-lg w-20 px-3 py-1.5 text-xs font-medium transition-colors ${cls}`}>
      {children}
    </button>
  );
}
