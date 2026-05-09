import { BROADCAST_CHANNEL_NAME } from "./constants.js";
import type { Logger } from "./logger.js";
import type { BroadcastEnvelope, BroadcastMessage } from "./types.js";
import { parseBroadcastEnvelope } from "./wire.js";

// Typed BroadcastChannel adapter. Any participant (a Worker or a tab UI) uses
// this to post and listen to cross-tab state events tagged with `_wid`.
//
// Control-plane RPC (start/pause/resume/cancel/listPending) does NOT go
// through here - that's Comlink point-to-point between a tab UI and its
// own dedicated Worker. Broadcasts carry observation data only:
// progress, status, complete, error, warning, heartbeat, pending-downloads,
// state-snapshot, request-state, goodbye.

export class BroadcastBus {
  private readonly channel: BroadcastChannel;
  private listeners: Array<(env: BroadcastEnvelope) => void> = [];

  constructor(
    public readonly workerId: string,
    private readonly logger: Logger,
    channel?: BroadcastChannel,
  ) {
    this.channel = channel ?? new BroadcastChannel(BROADCAST_CHANNEL_NAME);
    this.channel.onmessage = (e) => {
      const env = parseBroadcastEnvelope(e.data, this.logger);
      if (!env) return;
      for (const listener of this.listeners) listener(env);
    };
  }

  emit(msg: BroadcastMessage): void {
    this.channel.postMessage({ ...msg, _wid: this.workerId });
  }

  onMessage(listener: (env: BroadcastEnvelope) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  close(): void {
    this.channel.close();
    this.listeners = [];
  }
}
