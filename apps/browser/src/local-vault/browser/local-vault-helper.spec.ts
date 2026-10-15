/**
 * Runs the helper itself, which takes Node.
 * @jest-environment node
 */
import { spawn } from "child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { checkFileSystem } from "../../../local-vault-rs/pkg";

import {
  NativeMessagingLocalVaultFileSystem,
  NativePort,
} from "./native-messaging-local-vault-file-system";

const HELPER = join(__dirname, "..", "..", "..", "native-host", "local_vault_host.py");

/**
 * A port to the helper, which runs as the browser runs it: a message goes to it, and comes back
 * from it, as JSON after its length in four bytes.
 */
function connect(helper: string): NativePort {
  const helperProcess = spawn("python3", [helper], { stdio: ["pipe", "pipe", "inherit"] });
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  let received = Buffer.alloc(0);
  helperProcess.stdout.on("data", (data: Buffer) => {
    received = Buffer.concat([received, data]);
    while (received.length >= 4 && received.length >= 4 + received.readUInt32LE(0)) {
      const end = 4 + received.readUInt32LE(0);
      const message: unknown = JSON.parse(received.subarray(4, end).toString("utf8"));
      received = received.subarray(end);
      messageListeners.forEach((listener) => listener(message));
    }
  });
  helperProcess.on("exit", () => disconnectListeners.forEach((listener) => listener()));
  return {
    postMessage(message: unknown): void {
      const content = Buffer.from(JSON.stringify(message), "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32LE(content.length, 0);
      helperProcess.stdin.write(Buffer.concat([length, content]));
    },
    disconnect(): void {
      helperProcess.kill();
    },
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
  };
}

/**
 * The helper, with what the extension makes of it, against the rules of the local vault for the
 * file system that a vault folder is reached through. The other clients that share a vault
 * folder are held to the same rules.
 */
describe("the local vault helper", () => {
  let directory: string;
  let port: NativePort | null;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "local-vault-helper-"));
    copyFileSync(HELPER, join(directory, "local_vault_host.py"));
    const config = { vaultFolder: join(directory, "vault") };
    writeFileSync(join(directory, "local_vault_host.json"), JSON.stringify(config));
    port = null;
  });

  afterEach(() => {
    port?.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps every rule that the local vault counts on", async () => {
    const fileSystem = new NativeMessagingLocalVaultFileSystem(() => {
      port = connect(join(directory, "local_vault_host.py"));
      return port;
    });

    expect(await checkFileSystem(fileSystem, ["check"])).toEqual([]);
  });
});
