import { createActor, createMachine } from "xstate";
import type { WorkerState } from "./types.js";

type LifecycleEvent =
  | { type: "START" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "CANCEL" }
  | { type: "RESET" };

const downloadLifecycleMachine = createMachine({
  types: {} as {
    events: LifecycleEvent;
  },
  initial: "idle",
  states: {
    idle: {
      on: { START: "downloading", CANCEL: "cancelled" },
    },
    downloading: {
      on: { PAUSE: "paused", CANCEL: "cancelled", RESET: "idle" },
    },
    paused: {
      on: { RESUME: "downloading", CANCEL: "cancelled", RESET: "idle" },
    },
    cancelled: {
      on: { RESET: "idle", START: "downloading" },
    },
  },
});

export type DownloadLifecycleActor = ReturnType<typeof createDownloadLifecycleActor>;

export function createDownloadLifecycleActor() {
  return createActor(downloadLifecycleMachine).start();
}

export function lifecycleState(actor: DownloadLifecycleActor): WorkerState {
  return actor.getSnapshot().value as WorkerState;
}
