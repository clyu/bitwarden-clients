import { LocalVaultFileSystem, LocalVaultIoError } from "../server/local-vault-file-system";

import { base64Decode, base64Encode } from "./encoding";

/**
 * How much of a file goes into one message. The browser does not deliver a message from a native
 * application that is larger than 1 MB, and Base64 makes the content a third larger.
 */
const CHUNK_SIZE_BYTES = 512 * 1024;
const TIMEOUT_MILLIS = 30_000;

/**
 * How many times a file is read before giving up on one that changes while it is read.
 */
const READ_ATTEMPTS = 3;

/**
 * The part of a port to a native application that is used here.
 */
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: any) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

type HostResponse = {
  id: number;
  ok: boolean;
  error?: string;
  names?: string[];
  exists?: boolean;
  found?: boolean;
  data?: string;
  size?: number;
  done?: boolean;
  version?: string;
};

type PendingCall = {
  resolve: (response: HostResponse) => void;
  reject: (error: LocalVaultIoError) => void;
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * A {@link LocalVaultFileSystem} on the vault folder of the local vault helper: a native
 * application that the browser starts, which is the only way for an extension to reach a folder
 * of the user. The folder is set where the helper is installed, not here.
 */
export class NativeMessagingLocalVaultFileSystem implements LocalVaultFileSystem {
  private port: NativePort | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(private readonly connect: () => NativePort) {}

  async list(directory: string[]): Promise<string[]> {
    return (await this.call({ op: "list", path: directory })).names ?? [];
  }

  async exists(path: string[]): Promise<boolean> {
    return (await this.call({ op: "exists", path })).exists === true;
  }

  async read(path: string[]): Promise<Uint8Array | null> {
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const content = await this.readUnchanged(path);
      if (content !== undefined) {
        return content;
      }
    }
    throw new LocalVaultIoError("The vault folder is changing while it is read.");
  }

  /**
   * Reads the file at the given path part by part. Returns `null` if there is no such file, and
   * `undefined` if the file was replaced or changed between two of its parts, as a tool that
   * syncs the vault folder does: parts of two files are not the content of either.
   */
  private async readUnchanged(path: string[]): Promise<Uint8Array | null | undefined> {
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let version: string | undefined;
    for (;;) {
      const response = await this.call({ op: "read", path, offset, length: CHUNK_SIZE_BYTES });
      if (offset > 0 && (response.found !== true || response.version !== version)) {
        return undefined;
      }
      if (response.found !== true) {
        return null;
      }
      version = response.version;
      const chunk = base64Decode(response.data ?? "");
      if (chunk == null) {
        throw new LocalVaultIoError("The local vault helper sent content that cannot be read.");
      }
      chunks.push(chunk);
      offset += chunk.length;
      if (response.done === true || chunk.length === 0) {
        break;
      }
    }
    const content = new Uint8Array(offset);
    let position = 0;
    for (const chunk of chunks) {
      content.set(chunk, position);
      position += chunk.length;
    }
    return content;
  }

  async write(path: string[], content: Uint8Array): Promise<void> {
    let offset = 0;
    do {
      const chunk = content.subarray(offset, offset + CHUNK_SIZE_BYTES);
      const last = offset + chunk.length >= content.length;
      await this.call({ op: "write", path, offset, data: base64Encode(chunk), last });
      offset += chunk.length;
    } while (offset < content.length);
  }

  async rename(path: string[], newName: string): Promise<boolean> {
    return (await this.call({ op: "rename", path, newName })).done === true;
  }

  async delete(path: string[]): Promise<boolean> {
    return (await this.call({ op: "delete", path })).done === true;
  }

  private call(message: Record<string, unknown>): Promise<HostResponse> {
    return new Promise<HostResponse>((resolve, reject) => {
      const id = this.nextId++;
      let port: NativePort;
      try {
        port = this.connectedPort();
        port.postMessage({ ...message, id });
      } catch {
        this.disconnect("The local vault helper cannot be started.");
        reject(new LocalVaultIoError("The local vault helper cannot be started."));
        return;
      }
      const timeout = setTimeout(
        () => this.disconnect("The local vault helper does not answer."),
        TIMEOUT_MILLIS,
      );
      this.pending.set(id, { resolve, reject, timeout });
    }).then((response) => {
      if (!response.ok) {
        throw new LocalVaultIoError(response.error ?? "The local vault helper failed.");
      }
      return response;
    });
  }

  private connectedPort(): NativePort {
    if (this.port != null) {
      return this.port;
    }
    const port = this.connect();
    port.onMessage.addListener((response: HostResponse) => {
      const call = this.pending.get(response?.id);
      if (call != null) {
        this.pending.delete(response.id);
        clearTimeout(call.timeout);
        call.resolve(response);
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) {
        this.port = null;
        this.failPending("The local vault helper is not installed or has stopped.");
      }
    });
    this.port = port;
    return port;
  }

  /**
   * Gives up on the helper that is running. The next call starts it again.
   */
  private disconnect(reason: string): void {
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      // It is gone already.
    }
    this.failPending(reason);
  }

  private failPending(reason: string): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    calls.forEach((call) => {
      clearTimeout(call.timeout);
      call.reject(new LocalVaultIoError(reason));
    });
  }
}
