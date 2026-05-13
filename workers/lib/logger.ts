// Structured logging seam. Every error path in the Downloader, OpfsStore, Bus,
// and SW funnels through Logger so the host app can plug in Sentry, Datadog,
// console-only, or a no-op without touching the worker code.
//
// Stable `event` strings are the bucketing keys: keep them constant when
// changing surrounding behaviour so historical metrics stay comparable.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export interface Logger {
  log(level: LogLevel, event: string, ctx?: LogContext, err?: unknown): void;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause !== undefined ? serializeError(err.cause) : undefined,
    };
  }
  return { name: "NonError", message: String(err) };
}

export const consoleLogger: Logger = {
  log(level, event, ctx, err) {
    const payload: Record<string, unknown> = { event, ...(ctx ?? {}) };
    if (err !== undefined) payload.error = serializeError(err);
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
  },
};

export const noopLogger: Logger = {
  log() {
    /* swallow */
  },
};

// Run a synchronous side-effect that may throw, log on failure, return result
// or undefined. Used to replace `try { x() } catch { /* */ }` blocks where the
// caller really does want best-effort.
export function tryOr<T>(
  logger: Logger,
  event: string,
  fn: () => T,
  ctx?: LogContext,
): T | undefined {
  try {
    return fn();
  } catch (err) {
    logger.log("warn", event, ctx, err);
    return undefined;
  }
}

export async function tryOrAsync<T>(
  logger: Logger,
  event: string,
  fn: () => Promise<T>,
  ctx?: LogContext,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    logger.log("warn", event, ctx, err);
    return undefined;
  }
}
