// Single source of truth for tunables shared across the Worker, the Service
// Worker, and the UI. Anywhere a magic number relates to download lifecycle
// timing, it lives here.

// On a hard kill at most ~FLUSH_BYTES of in-flight data is lost. Per-chunk
// flushing was tried first but cost ~10x throughput on large files.
export const FLUSH_BYTES = 4 * 1024 * 1024;
export const FLUSH_INTERVAL_MS = 250;

export const PROGRESS_INTERVAL_MS = 100;

export const HEARTBEAT_INTERVAL_MS = 5_000;
// Observers flip to "Stalled" + Take over when a heartbeat hasn't arrived in
// this window. Must comfortably exceed HEARTBEAT_INTERVAL_MS so a single
// missed beat doesn't false-positive.
export const STALE_AFTER_MS = 12_000;

// Speed indicator rolling window.
export const SPEED_WINDOW_MS = 1_000;

// Service Worker request timeouts.
export const ABORT_DELIVERY_TIMEOUT_MS = 2_000;
// Wait for an active SW controller after registration before falling back to
// the registration's `active` worker.
export const SW_CONTROLLER_WAIT_MS = 5_000;

// Wire transport names.
export const BROADCAST_CHANNEL_NAME = "resumable-downloads";
export const SYNTHETIC_DOWNLOAD_PREFIX = "/_dl/";

// OPFS file extensions.
export const PART_EXT = ".part";
export const META_EXT = ".meta.json";
