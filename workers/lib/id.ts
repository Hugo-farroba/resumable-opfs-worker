import { parse as parseContentRange } from "content-range";
import contentDisposition from "content-disposition";

// Deterministic 16-char hex ID derived from the URL via SHA-256.
// 16 hex chars = 64 bits; collision probability for any reasonable
// download set is negligible.

const ID_BYTES = 8; // 8 bytes = 16 hex chars

export async function sha256Id(url: string): Promise<string> {
  const buf = new TextEncoder().encode(url);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest, 0, ID_BYTES);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function deriveFileNameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? safeDecode(last) : "download";
  } catch {
    return "download";
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Prefer the server's Content-Disposition `filename*=UTF-8''...` over the URL's
// last segment - the server often knows better (e.g. signed S3 URLs).
export function deriveFileName(response: Response, url: string): string {
  const header = response.headers.get("content-disposition");
  if (header) {
    try {
      const parsed = contentDisposition.parse(header);
      const fromHeader = parsed.parameters?.filename;
      if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;
    } catch {
      /* fall through to URL */
    }
  }
  return deriveFileNameFromUrl(url);
}

function asFinite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

// total = content-range "/<total>" if 206, else content-length + rangeStart for 200.
// For 200 responses sent in reply to a Range request we only call this with
// rangeStart=0 (see Downloader fallback), so the +rangeStart is correct.
export function parseTotalBytes(response: Response, rangeStart: number): number | null {
  const range = response.headers.get("content-range");
  if (range) {
    try {
      const parsed = parseContentRange(range);
      // content-range lib returns { unit, range, size } where size is the total or "*".
      if (parsed && typeof parsed.size === "number") return asFinite(parsed.size);
    } catch {
      /* malformed - fall through */
    }
  }
  const length = response.headers.get("content-length");
  if (length) {
    const n = parseInt(length, 10);
    return asFinite(n + rangeStart);
  }
  return null;
}

export interface ParsedByteRange {
  start: number;
  end: number;
  size: number | null;
}

export function parseByteRange(response: Response): ParsedByteRange | null {
  const range = response.headers.get("content-range");
  if (!range) return null;
  try {
    const parsed = parseContentRange(range);
    if (!parsed || parsed.unit !== "bytes") return null;
    if (!Number.isFinite(parsed.start) || !Number.isFinite(parsed.end)) return null;
    return {
      start: parsed?.start ?? 0,
      end: parsed?.end ?? 0,
      size: typeof parsed.size === "number" && Number.isFinite(parsed.size) ? parsed.size : null,
    };
  } catch {
    return null;
  }
}

// Returns true when the server's response indicates Range support.
// Used to decide whether a future resume will work.
export function serverSupportsRanges(response: Response): boolean {
  if (response.status === 206) return true;
  const ar = response.headers.get("accept-ranges");
  return ar !== null && ar.toLowerCase() !== "none";
}

// Validators for If-Range. Strong ETag preferred; fall back to Last-Modified.
export interface ResourceValidator {
  etag: string | null;
  lastModified: string | null;
}

export function readValidator(response: Response): ResourceValidator {
  return {
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

export function pickIfRangeValidator(meta: {
  etag?: string | null;
  lastModified?: string | null;
}): string | null {
  // Per RFC 7233 §3.2 If-Range carries ONE validator. Prefer ETag.
  if (meta.etag) return meta.etag;
  if (meta.lastModified) return meta.lastModified;
  return null;
}
