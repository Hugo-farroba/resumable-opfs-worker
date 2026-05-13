import { describe, it, expect } from "vitest";
import {
  sha256Id,
  deriveFileName,
  deriveFileNameFromUrl,
  parseByteRange,
  parseTotalBytes,
  serverSupportsRanges,
} from "./id.js";

describe("sha256Id", () => {
  it("produces 16 hex chars", async () => {
    const id = await sha256Id("https://example.com/foo.zip");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for the same URL", async () => {
    const a = await sha256Id("https://example.com/foo.zip");
    const b = await sha256Id("https://example.com/foo.zip");
    expect(a).toBe(b);
  });

  it("differs for similar URLs (no folding collisions)", async () => {
    const a = await sha256Id("https://example.com/foo.zip");
    const b = await sha256Id("https://example.com/foo.zi");
    expect(a).not.toBe(b);
  });
});

describe("deriveFileNameFromUrl", () => {
  it("uses the last path segment", () => {
    expect(deriveFileNameFromUrl("https://example.com/a/b/file.zip")).toBe("file.zip");
  });
  it('falls back to "download"', () => {
    expect(deriveFileNameFromUrl("https://example.com/")).toBe("download");
    expect(deriveFileNameFromUrl("not a url")).toBe("download");
  });
  it("decodes percent-encoded names", () => {
    expect(deriveFileNameFromUrl("https://x.com/My%20File.zip")).toBe("My File.zip");
  });
});

describe("deriveFileName", () => {
  it("prefers Content-Disposition filename over URL", () => {
    const r = new Response(null, {
      headers: { "content-disposition": 'attachment; filename="real.zip"' },
    });
    expect(deriveFileName(r, "https://x.com/derived.bin")).toBe("real.zip");
  });
  it("falls back to URL when header missing", () => {
    const r = new Response(null);
    expect(deriveFileName(r, "https://x.com/from-url.bin")).toBe("from-url.bin");
  });
  it("falls back to URL on malformed header", () => {
    const r = new Response(null, { headers: { "content-disposition": "garbage; not parsable" } });
    expect(deriveFileName(r, "https://x.com/url-name.bin")).toBe("url-name.bin");
  });
});

describe("parseTotalBytes", () => {
  function res(headers: Record<string, string>): Response {
    return new Response(null, { headers });
  }
  it("parses 206 content-range", () => {
    expect(parseTotalBytes(res({ "content-range": "bytes 100-199/500" }), 100)).toBe(500);
  });
  it("falls back to content-length + rangeStart", () => {
    expect(parseTotalBytes(res({ "content-length": "400" }), 100)).toBe(500);
  });
  it("returns null when neither header is present", () => {
    expect(parseTotalBytes(res({}), 0)).toBeNull();
  });
});

describe("parseByteRange", () => {
  it("parses a valid byte content-range", () => {
    const response = new Response(null, { headers: { "content-range": "bytes 100-199/500" } });
    expect(parseByteRange(response)).toEqual({ start: 100, end: 199, size: 500 });
  });

  it("returns null when the range header is missing or malformed", () => {
    expect(parseByteRange(new Response(null))).toBeNull();
    expect(parseByteRange(new Response(null, { headers: { "content-range": "wat" } }))).toBeNull();
  });
});

describe("serverSupportsRanges", () => {
  it("true on 206", () => {
    expect(serverSupportsRanges(new Response(null, { status: 206 }))).toBe(true);
  });
  it("true on Accept-Ranges: bytes", () => {
    expect(
      serverSupportsRanges(new Response(null, { headers: { "accept-ranges": "bytes" } })),
    ).toBe(true);
  });
  it("false on Accept-Ranges: none", () => {
    expect(serverSupportsRanges(new Response(null, { headers: { "accept-ranges": "none" } }))).toBe(
      false,
    );
  });
});
