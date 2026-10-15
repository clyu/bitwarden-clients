import { LocalVaultIoError } from "../server/local-vault-file-system";

import { base64Decode, base64Encode } from "./encoding";
import {
  NativeMessagingLocalVaultFileSystem,
  NativePort,
} from "./native-messaging-local-vault-file-system";

const CHUNK_SIZE = 512 * 1024;

/**
 * Answers the way `native-host/local_vault_host.py` does.
 */
class FakeHost implements NativePort {
  readonly files = new Map<string, Uint8Array>();
  readonly messages: any[] = [];
  silent = false;
  failure: string | null = null;
  /** Called after each read with the number of reads so far, before the read is answered. */
  afterRead: (reads: number) => void = () => {};
  private reads = 0;
  private readonly versions = new Map<string, number>();
  private messageListener: (message: any) => void = () => {};
  private disconnectListener: () => void = () => {};

  onMessage = {
    addListener: (listener: (message: any) => void) => (this.messageListener = listener),
  };
  onDisconnect = { addListener: (listener: () => void) => (this.disconnectListener = listener) };
  disconnect = jest.fn();

  postMessage(message: any): void {
    this.messages.push(message);
    if (!this.silent) {
      void Promise.resolve().then(() => this.messageListener(this.answer(message)));
    }
  }

  stop(): void {
    this.disconnectListener();
  }

  /**
   * Puts a file in the place of the one at the given path, as a tool that syncs the vault
   * folder does.
   */
  replace(path: string, content: Uint8Array): void {
    this.files.set(path, content);
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }

  private answer(message: any): any {
    if (this.failure != null) {
      return { id: message.id, ok: false, error: this.failure };
    }
    const key = message.path.join("/");
    const file = this.files.get(key);
    switch (message.op) {
      case "list": {
        const prefix = key === "" ? "" : key + "/";
        const names = [...this.files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.substring(prefix.length).split("/")[0]);
        return { id: message.id, ok: true, names: [...new Set(names)] };
      }
      case "exists":
        return { id: message.id, ok: true, exists: file != null };
      case "read": {
        const part = this.readPart(message, key);
        this.afterRead(++this.reads);
        return { id: message.id, ok: true, ...part };
      }
      case "write": {
        const data = base64Decode(message.data)!;
        const content = new Uint8Array(message.offset + data.length);
        content.set(message.offset === 0 ? [] : file!.subarray(0, message.offset));
        content.set(data, message.offset);
        this.files.set(key, content);
        return { id: message.id, ok: true };
      }
      case "rename":
        if (file == null) {
          return { id: message.id, ok: true, done: false };
        }
        this.files.delete(key);
        this.files.set([...message.path.slice(0, -1), message.newName].join("/"), file);
        return { id: message.id, ok: true, done: true };
      case "delete":
        this.files.delete(key);
        return { id: message.id, ok: true, done: true };
    }
  }

  private readPart(message: any, key: string): any {
    const file = this.files.get(key);
    if (file == null) {
      return { found: false };
    }
    const data = file.subarray(message.offset, message.offset + message.length);
    const done = message.offset + data.length >= file.length;
    const version = String(this.versions.get(key) ?? 0);
    return { found: true, data: base64Encode(data), done, version };
  }
}

describe("NativeMessagingLocalVaultFileSystem", () => {
  let host: FakeHost;
  let connect: jest.Mock;
  let fileSystem: NativeMessagingLocalVaultFileSystem;

  beforeEach(() => {
    host = new FakeHost();
    connect = jest.fn(() => host);
    fileSystem = new NativeMessagingLocalVaultFileSystem(connect);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not start the helper before it is needed, and starts it once", async () => {
    expect(connect).not.toHaveBeenCalled();

    await fileSystem.exists(["account"]);
    await fileSystem.list([]);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("writes, reads, lists, renames and deletes files", async () => {
    const content = new Uint8Array([0, 1, 2, 255]);

    await fileSystem.write(["account", "vault.json.tmp"], content);
    expect(await fileSystem.exists(["account", "vault.json.tmp"])).toBe(true);
    expect(await fileSystem.read(["account", "vault.json.tmp"])).toEqual(content);
    expect(await fileSystem.read(["account", "missing"])).toBeNull();
    expect(await fileSystem.list(["account"])).toEqual(["vault.json.tmp"]);

    expect(await fileSystem.rename(["account", "vault.json.tmp"], "vault.json")).toBe(true);
    expect(await fileSystem.rename(["account", "vault.json.tmp"], "vault.json")).toBe(false);
    expect(await fileSystem.read(["account", "vault.json"])).toEqual(content);

    expect(await fileSystem.delete(["account", "vault.json"])).toBe(true);
    expect(await fileSystem.exists(["account", "vault.json"])).toBe(false);
    expect(await fileSystem.list([])).toEqual([]);
  });

  it("writes an empty file", async () => {
    await fileSystem.write(["account", "empty"], new Uint8Array());

    expect(host.messages).toEqual([
      { id: 1, op: "write", path: ["account", "empty"], offset: 0, data: "", last: true },
    ]);
    expect(await fileSystem.read(["account", "empty"])).toEqual(new Uint8Array());
  });

  it("moves a file in parts that the browser delivers", async () => {
    const content = new Uint8Array(CHUNK_SIZE * 2 + 1000).map((_, index) => index % 251);

    await fileSystem.write(["account", "attachment"], content);

    const writes = host.messages.filter((message) => message.op === "write");
    expect(writes.map((message) => [message.offset, message.last])).toEqual([
      [0, false],
      [CHUNK_SIZE, false],
      [CHUNK_SIZE * 2, true],
    ]);
    // Base64 of a part, with the rest of the message, stays well below 1 MB.
    writes.forEach((message) => expect(JSON.stringify(message).length).toBeLessThan(750_000));

    expect(await fileSystem.read(["account", "attachment"])).toEqual(content);
    const reads = host.messages.filter((message) => message.op === "read");
    expect(reads.map((message) => [message.offset, message.length])).toEqual([
      [0, CHUNK_SIZE],
      [CHUNK_SIZE, CHUNK_SIZE],
      [CHUNK_SIZE * 2, CHUNK_SIZE],
    ]);
  });

  describe("a file that changes while its parts are read", () => {
    const path = ["account", "vault.json"];
    const key = "account/vault.json";
    const content = new Uint8Array(CHUNK_SIZE + 10).fill(1);

    beforeEach(() => {
      host.replace(key, content);
    });

    it("is read again when it was replaced", async () => {
      const replacement = new Uint8Array(CHUNK_SIZE + 20).fill(2);
      host.afterRead = (reads) => {
        if (reads === 1) {
          host.replace(key, replacement);
        }
      };

      expect(await fileSystem.read(path)).toEqual(replacement);
      // The second part came from the other file, so both parts were read again.
      const offsets = host.messages.map((message) => message.offset);
      expect(offsets).toEqual([0, CHUNK_SIZE, 0, CHUNK_SIZE]);
    });

    it("is read again when it was gone for a moment", async () => {
      // A file that is not there after its first part was read is not one that does not exist.
      host.afterRead = (reads) => {
        if (reads === 1) {
          host.files.delete(key);
        } else if (reads === 2) {
          host.replace(key, content);
        }
      };

      expect(await fileSystem.read(path)).toEqual(content);
    });

    it("fails when it keeps changing", async () => {
      host.afterRead = () => host.replace(key, content);

      await expect(fileSystem.read(path)).rejects.toThrow(LocalVaultIoError);
      expect(host.messages).toHaveLength(6);
    });
  });

  it("fails when the helper reports an error", async () => {
    host.failure = "PermissionError";

    await expect(fileSystem.read(["account", "vault.json"])).rejects.toThrow(LocalVaultIoError);
    await expect(fileSystem.write(["account", "vault.json"], new Uint8Array(1))).rejects.toThrow(
      "PermissionError",
    );
  });

  it("fails when the helper cannot be started, and tries again the next time", async () => {
    connect.mockImplementationOnce(() => {
      throw new Error("No such native application");
    });

    await expect(fileSystem.list([])).rejects.toThrow(LocalVaultIoError);

    expect(await fileSystem.list([])).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("fails what is waiting when the helper stops, and starts it again the next time", async () => {
    host.silent = true;
    const first = fileSystem.exists(["account"]);
    const second = fileSystem.list([]);

    host.stop();

    await expect(first).rejects.toThrow(LocalVaultIoError);
    await expect(second).rejects.toThrow(LocalVaultIoError);
    host = new FakeHost();
    expect(await fileSystem.exists(["account"])).toBe(false);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("gives up on a helper that does not answer", async () => {
    jest.useFakeTimers();
    host.silent = true;
    const stuck = host;
    const call = fileSystem.exists(["account"]);
    const failed = expect(call).rejects.toThrow("does not answer");

    await jest.advanceTimersByTimeAsync(30_000);

    await failed;
    expect(stuck.disconnect).toHaveBeenCalled();
    host = new FakeHost();
    expect(await fileSystem.exists(["account"])).toBe(false);
  });
});
