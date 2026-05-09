// Runtime validation at message boundaries. Wire messages cross trust
// boundaries (own postMessage from a stale worker version, BroadcastChannel
// posts from a different tab, hostile injection in dev tools), so every
// inbound message gets parsed against a zod schema before reaching the
// Downloader or the UI's reducer.
//
// The schemas are intentionally close to the TypeScript types in `types.ts` -
// keep them in sync. A failed parse is logged and the message is dropped.

import { z } from "zod";
import type { Logger } from "./logger.js";
import type { BroadcastEnvelope, BroadcastMessage, WorkerToUiMessage } from "./types.js";

const downloadMetaSchema = z.object({
  id: z.string(),
  url: z.string(),
  fileName: z.string(),
  downloadedBytes: z.number(),
  totalBytes: z.number().nullable(),
  createdAt: z.number(),
  etag: z.string().nullable().optional(),
  lastModified: z.string().nullable().optional(),
  skipIfRange: z.boolean().optional(),
});

const progressPayloadSchema = z.object({
  downloaded: z.number(),
  total: z.number().nullable(),
  percentage: z.number().nullable(),
  chunks: z.number(),
  elapsed: z.number(),
});

const stateSnapshotSchema = z.object({
  url: z.string(),
  status: z.union([z.literal("downloading"), z.literal("paused")]),
  downloaded: z.number(),
  total: z.number().nullable(),
  percentage: z.number().nullable(),
  fileName: z.string().nullable(),
  chunks: z.number(),
  elapsed: z.number(),
});

const warningCodeSchema = z.union([z.literal("range-unsupported"), z.literal("validator-mismatch")]);

const statusValueSchema = z.union([
  z.literal("idle"),
  z.literal("downloading"),
  z.literal("paused"),
  z.literal("complete"),
]);

export const broadcastMessageSchema: z.ZodType<BroadcastMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress") }).extend(progressPayloadSchema.shape),
  z.object({ type: z.literal("complete"), fileName: z.string(), elapsed: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("warning"), code: warningCodeSchema, message: z.string() }),
  z.object({ type: z.literal("status"), status: statusValueSchema }),
  z.object({ type: z.literal("pending-downloads"), downloads: z.array(downloadMetaSchema) }),
  z.object({ type: z.literal("state-snapshot"), state: stateSnapshotSchema }),
  z.object({ type: z.literal("heartbeat"), url: z.string() }),
  z.object({ type: z.literal("request-state") }),
  z.object({ type: z.literal("goodbye"), url: z.string().nullable() }),
]);

export const broadcastEnvelopeSchema: z.ZodType<BroadcastEnvelope> = broadcastMessageSchema.and(
  z.object({ _wid: z.string() }),
) as unknown as z.ZodType<BroadcastEnvelope>;

export const workerToUiMessageSchema: z.ZodType<WorkerToUiMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping"), workerId: z.string() }),
  z.object({
    type: z.literal("data"),
    id: z.string(),
    fileName: z.string(),
    totalBytes: z.number().nullable(),
  }),
]);

export function parseBroadcastEnvelope(raw: unknown, logger: Logger): BroadcastEnvelope | null {
  const parsed = broadcastEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    logger.log("warn", "wire.broadcast.invalid", { issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

export function parseWorkerToUi(raw: unknown, logger: Logger): WorkerToUiMessage | null {
  const parsed = workerToUiMessageSchema.safeParse(raw);
  if (!parsed.success) {
    logger.log("warn", "wire.workerToUi.invalid", { issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}
