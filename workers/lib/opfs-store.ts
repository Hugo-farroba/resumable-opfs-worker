import { META_EXT, PART_EXT } from "./constants.js";
import type { Logger } from "./logger.js";
import { consoleLogger, tryOr, tryOrAsync } from "./logger.js";
import type { DownloadMeta, Store, SyncHandle } from "./types.js";

// OPFS-backed implementation of Store. The Downloader has no idea OPFS
// exists - it only sees the Store interface. Tests use an in-memory fake.

export class OpfsStore implements Store {
  private root: FileSystemDirectoryHandle | null = null;
  constructor(private readonly logger: Logger = consoleLogger) {}

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    return (this.root ??= await navigator.storage.getDirectory());
  }

  private metaPath(id: string): string {
    return id + META_EXT;
  }

  private partPath(id: string): string {
    return id + PART_EXT;
  }

  async readMeta(id: string): Promise<DownloadMeta | null> {
    const root = await this.getRoot();
    try {
      const fh = await root.getFileHandle(this.metaPath(id));
      return JSON.parse(await (await fh.getFile()).text()) as DownloadMeta;
    } catch (err) {
      if ((err as DOMException)?.name !== "NotFoundError") {
        this.logger.log("debug", "opfs.readMeta.failed", { id }, err);
      }
      return null;
    }
  }

  async writeMeta(meta: DownloadMeta): Promise<void> {
    const root = await this.getRoot();
    const fh = await root.getFileHandle(this.metaPath(meta.id), { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(meta));
    await w.close();
  }

  async remove(id: string): Promise<void> {
    const root = await this.getRoot();
    await this.removePartFile(root, id);
    await tryOrAsync(
      this.logger,
      "opfs.remove.meta.failed",
      () => root.removeEntry(this.metaPath(id)),
      { id },
    );
  }

  // The browser may keep an OPFS .part pinned for a moment after a recent
  // download. removeEntry then throws NoModificationAllowedError. Falls back
  // to truncate(0) so the next openHandle/getSize sees an empty file - this
  // prevents a stale partial from masquerading as a completed download.
  private async removePartFile(root: FileSystemDirectoryHandle, id: string): Promise<void> {
    try {
      await root.removeEntry(this.partPath(id));
      return;
    } catch (err) {
      this.logger.log("warn", "opfs.remove.part.retrying", { id }, err);
    }
    try {
      const fh = await root.getFileHandle(this.partPath(id));
      const ah = await fh.createSyncAccessHandle();
      ah.truncate(0);
      ah.close();
    } catch (err) {
      // File already gone or fundamentally locked - leave it; the truncate
      // path is a best-effort recovery, not a guarantee.
      this.logger.log("warn", "opfs.remove.part.truncate.failed", { id }, err);
      return;
    }
    await tryOrAsync(
      this.logger,
      "opfs.remove.part.retry.failed",
      () => root.removeEntry(this.partPath(id)),
      { id },
    );
  }

  async listAllMetas(): Promise<DownloadMeta[]> {
    const root = await this.getRoot();
    const out: DownloadMeta[] = [];
    for await (const [name, handle] of root.entries()) {
      if (!name.endsWith(META_EXT) || handle.kind !== "file") continue;
      const meta = await tryOrAsync(
        this.logger,
        "opfs.listAllMetas.parse.failed",
        async () => {
          const text = await (await (handle as FileSystemFileHandle).getFile()).text();
          return JSON.parse(text) as DownloadMeta;
        },
        { name },
      );
      if (meta) out.push(meta);
    }
    return out;
  }

  async openHandle(id: string): Promise<SyncHandle> {
    const root = await this.getRoot();
    const fh = await root.getFileHandle(this.partPath(id), { create: true });
    return await fh.createSyncAccessHandle();
  }
}

// Re-export tryOr for callers that hand-roll best-effort blocks alongside an
// OpfsStore. Avoids a separate logger.js import in many files.
export { tryOr };
