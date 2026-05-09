// Type declarations for OPFS and SharedWorker APIs not yet in this TypeScript version's dom lib

interface DedicatedWorkerGlobalScope extends WorkerGlobalScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((this: DedicatedWorkerGlobalScope, ev: MessageEvent) => unknown) | null;
}

declare const DedicatedWorkerGlobalScope: {
  prototype: DedicatedWorkerGlobalScope;
  new (): DedicatedWorkerGlobalScope;
};

interface SharedWorkerGlobalScope extends WorkerGlobalScope {
  onconnect: ((this: SharedWorkerGlobalScope, ev: MessageEvent) => unknown) | null;
}

declare const SharedWorkerGlobalScope: {
  prototype: SharedWorkerGlobalScope;
  new (): SharedWorkerGlobalScope;
};

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBuffer | ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  close(): void;
  getSize(): number;
  truncate(newSize: number): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemHandle>;
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;
}
