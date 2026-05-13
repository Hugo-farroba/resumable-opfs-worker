import { assign, createActor, createMachine } from "xstate";
import type {
  DownloadMeta,
  ProgressPayload,
  StateSnapshot,
  StatusValue,
  WarningCode,
} from "../workers/lib/types";

export type DownloadStatus = "idle" | "downloading" | "paused" | "complete" | "error";

export interface DownloadViewState {
  status: DownloadStatus;
  downloaded: number;
  total: number | null;
  percentage: number | null;
  error: string | null;
  warning: string | null;
  fileName: string | null;
  chunks: number;
  elapsedMs: number;
  isLocal: boolean;
}

export interface RemoteViewState {
  url: string | null;
  lastBeatAt: number;
}

export interface DownloadUiContext {
  download: DownloadViewState;
  remote: RemoteViewState;
}

export type DownloadUiEvent =
  | { type: "LOCAL_START" }
  | { type: "LOCAL_PAUSE" }
  | { type: "LOCAL_RESUME" }
  | { type: "LOCAL_RESET" }
  | { type: "PROGRESS"; payload: ProgressPayload; isLocal: boolean; at: number }
  | { type: "STATUS"; status: StatusValue; isLocal: boolean }
  | { type: "COMPLETE"; fileName: string; elapsed: number; isLocal: boolean }
  | { type: "ERROR"; message: string; isLocal: boolean }
  | { type: "WARNING"; code: WarningCode; message: string; isLocal: boolean }
  | { type: "HEARTBEAT"; url: string; isLocal: boolean; at: number }
  | { type: "GOODBYE"; url: string | null; isLocal: boolean }
  | { type: "STATE_SNAPSHOT"; state: StateSnapshot; isLocal: boolean; at: number }
  | { type: "TAKEOVER_RESET" };

export const INITIAL_DOWNLOAD_VIEW: DownloadViewState = {
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

const INITIAL_REMOTE_VIEW: RemoteViewState = { url: null, lastBeatAt: 0 };

function shouldIgnoreRemote(context: DownloadUiContext, isLocal: boolean): boolean {
  return !isLocal && context.download.isLocal;
}

export const downloadUiMachine = createMachine({
  types: {} as {
    context: DownloadUiContext;
    events: DownloadUiEvent;
  },
  context: {
    download: INITIAL_DOWNLOAD_VIEW,
    remote: INITIAL_REMOTE_VIEW,
  },
  on: {
    LOCAL_START: {
      actions: assign({
        download: () => ({ ...INITIAL_DOWNLOAD_VIEW, status: "downloading", isLocal: true }),
        remote: () => INITIAL_REMOTE_VIEW,
      }),
    },
    LOCAL_PAUSE: {
      actions: assign({
        download: ({ context }) => ({ ...context.download, status: "paused" }),
      }),
    },
    LOCAL_RESUME: {
      actions: assign({
        download: ({ context }) => ({ ...context.download, status: "downloading" }),
      }),
    },
    LOCAL_RESET: {
      actions: assign({
        download: () => INITIAL_DOWNLOAD_VIEW,
        remote: () => INITIAL_REMOTE_VIEW,
      }),
    },
    TAKEOVER_RESET: {
      actions: assign({
        remote: () => INITIAL_REMOTE_VIEW,
      }),
    },
    PROGRESS: {
      actions: assign({
        download: ({ context, event }) => {
          if (shouldIgnoreRemote(context, event.isLocal)) return context.download;
          return {
            ...context.download,
            isLocal: event.isLocal,
            status: "downloading",
            error: null,
            warning: null,
            downloaded: event.payload.downloaded,
            total: event.payload.total,
            percentage: event.payload.percentage,
            chunks: event.payload.chunks,
            elapsedMs: event.payload.elapsed,
          };
        },
        remote: ({ context, event }) =>
          event.isLocal ? context.remote : { ...context.remote, lastBeatAt: event.at },
      }),
    },
    STATUS: {
      actions: assign({
        download: ({ context, event }) => {
          if (shouldIgnoreRemote(context, event.isLocal)) return context.download;
          if (event.status === "idle" && !event.isLocal) return INITIAL_DOWNLOAD_VIEW;
          const clearError = event.status === "downloading" || event.status === "paused";
          return {
            ...context.download,
            isLocal: event.isLocal,
            status: event.status,
            error: clearError ? null : context.download.error,
            warning: clearError ? null : context.download.warning,
          };
        },
      }),
    },
    COMPLETE: {
      actions: assign({
        download: ({ context, event }) => {
          if (shouldIgnoreRemote(context, event.isLocal)) return context.download;
          return {
            ...context.download,
            isLocal: event.isLocal,
            status: "complete",
            error: null,
            warning: null,
            fileName: event.fileName,
            elapsedMs: event.elapsed,
          };
        },
      }),
    },
    ERROR: {
      actions: assign({
        download: ({ context, event }) => {
          if (shouldIgnoreRemote(context, event.isLocal)) return context.download;
          return {
            ...context.download,
            isLocal: event.isLocal,
            status: "error",
            error: event.message,
          };
        },
      }),
    },
    WARNING: {
      actions: assign({
        download: ({ context, event }) => {
          if (shouldIgnoreRemote(context, event.isLocal)) return context.download;
          return { ...context.download, isLocal: event.isLocal, warning: event.message };
        },
      }),
    },
    HEARTBEAT: {
      actions: assign({
        remote: ({ context, event }) =>
          event.isLocal ? context.remote : { url: event.url, lastBeatAt: event.at },
      }),
    },
    GOODBYE: {
      actions: assign({
        remote: ({ context, event }) =>
          event.isLocal
            ? context.remote
            : {
                url: event.url ?? context.remote.url,
                lastBeatAt: 1,
              },
      }),
    },
    STATE_SNAPSHOT: {
      actions: assign({
        remote: ({ context, event }) =>
          event.isLocal ? context.remote : { url: event.state.url, lastBeatAt: event.at },
        download: ({ context, event }) => {
          if (context.download.isLocal) return context.download;
          const s = event.state;
          return {
            ...context.download,
            isLocal: false,
            status: s.status,
            error: null,
            warning: null,
            downloaded: s.downloaded,
            total: s.total,
            percentage: s.percentage,
            fileName: s.fileName,
            chunks: s.chunks,
            elapsedMs: s.elapsed,
          };
        },
      }),
    },
  },
});

export interface PendingDownloadsEvent {
  type: "PENDING_DOWNLOADS";
  downloads: DownloadMeta[];
}

export function createDownloadUiActor() {
  return createActor(downloadUiMachine).start();
}
