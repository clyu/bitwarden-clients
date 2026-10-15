import type {
  LocalServer as LocalVaultServer,
  LocalVaultPlatform,
} from "../../../local-vault-rs/pkg";

import { LocalRequest, LocalResponse } from "./local-request";
import { LocalVaultFileSystem, LocalVaultIoError } from "./local-vault-file-system";

/**
 * How bad what the local server logs is: a request that it refuses, or something that went
 * wrong in it.
 */
export type LocalServerLogLevel = Parameters<LocalVaultPlatform["log"]>[0];

/**
 * The name of the errors of the local vault for a vault folder that cannot be reached.
 */
const IO_ERROR_NAME = "LocalVaultIoError";

/**
 * The local vault, in WebAssembly, which `build-local-vault.sh` builds from the submodule
 * `local-vault-rs`. Its loading starts as soon as this is loaded, so that it is there by the
 * first request.
 */
const localVault = import("../../../local-vault-rs/pkg");

/**
 * The local vault, on the vault folder of a {@link LocalServer}.
 */
interface LoadedLocalVault {
  server: LocalVaultServer;
  /**
   * The response for a call of the local vault that fails in a way that it does not answer.
   * It is taken before, as such a call may leave the local vault unusable.
   */
  internalError: LocalResponse;
}

/**
 * Does what the Bitwarden server does for a single user, on top of a local vault: it registers
 * and authenticates accounts, and stores their encrypted items, folders and attachments.
 *
 * The work is done by the local vault in Rust (the submodule `local-vault-rs`), which the other
 * clients that share a vault folder use as well, down to what a request asks for. This only
 * hands it the requests, the vault folder and the clock.
 */
export class LocalServer {
  private readonly localVault: Promise<LoadedLocalVault>;

  constructor(
    fileSystem: LocalVaultFileSystem,
    now: () => Date = () => new Date(),
    private readonly log: (level: LocalServerLogLevel, message: string) => void = () => {},
  ) {
    const platform: LocalVaultPlatform = {
      now: () => now().getTime(),
      randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
      log,
    };
    this.localVault = localVault.then((wasm): LoadedLocalVault => ({
      server: new wasm.LocalServer(fileSystem, platform, "browser"),
      internalError: {
        code: 500,
        contentType: "application/json; charset=utf-8",
        body: wasm.internalErrorJson(),
        bytes: null,
      },
    }));
    // Every request fails with this as well, but without saying why.
    void this.localVault.catch((e: unknown) =>
      log("error", `The local vault cannot be loaded: ${String(e)}`),
    );
  }

  /**
   * Handles the given request. The local vault handles requests one at a time, as each of them
   * reads and then replaces the whole vault, and stores and reads the content of an attachment
   * along with the request that it is sent with.
   *
   * Fails with a {@link LocalVaultIoError} if the vault folder cannot be reached, and with nothing
   * else.
   */
  async handle(request: LocalRequest): Promise<LocalResponse> {
    let loaded: LoadedLocalVault;
    try {
      loaded = await this.localVault;
    } catch {
      throw new LocalVaultIoError("The local vault cannot be loaded.");
    }
    try {
      const response = await loaded.server.handle(request);
      return {
        code: response.code,
        contentType: response.contentType,
        body: response.text,
        bytes: response.bytes,
      };
    } catch (e) {
      if (isIoError(e)) {
        throw new LocalVaultIoError(e.message);
      }
      // Only what kind of error it is: its message could quote the request.
      this.log("error", `Local server error: ${e instanceof Error ? e.name : typeof e}`);
      return { ...loaded.internalError };
    }
  }
}

/**
 * Returns `true` if the local vault failed because the vault folder cannot be reached. Its errors
 * are told by their name: they are not of a class here.
 */
function isIoError(e: unknown): e is Error {
  return typeof e === "object" && e != null && (e as Error).name === IO_ERROR_NAME;
}
