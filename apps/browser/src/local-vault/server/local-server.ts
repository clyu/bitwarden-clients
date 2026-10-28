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
 * What the extension names its device to a Bitwarden server as it logs in (`DeviceRequest`): the
 * browser that it is in, such as `chrome`, and the number of the type of the extension in it
 * (`DeviceType`). The files of the device say them, so that the devices that share the vault
 * folder can be told apart.
 */
export interface LocalServerDevice {
  name: string;
  type: number;
}

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
 * hands it the requests, the vault folder, the clock, the ID of this installation of the
 * extension, which names the directory of the vault folder that it writes its changes to, and
 * what its device is.
 */
export class LocalServer {
  private readonly platform: LocalVaultPlatform;

  /**
   * The local vault, as it is loaded. One that could not be loaded is not kept, so that the next
   * request loads it again.
   */
  private localVault: Promise<LoadedLocalVault> | undefined;

  /**
   * @param deviceId The ID of this installation of the extension, or what reads it. The local
   * vault is loaded once it is read. If that fails, a request that was waiting for it reads it
   * again, as does every request after it until it is read, which is better than writing the
   * changes of the extension under an ID that is not kept.
   * @param device What the extension names its device to a Bitwarden server.
   */
  constructor(
    private readonly fileSystem: LocalVaultFileSystem,
    private readonly deviceId: string | (() => Promise<string>),
    private readonly device: LocalServerDevice,
    now: () => Date = () => new Date(),
    private readonly log: (level: LocalServerLogLevel, message: string) => void = () => {},
  ) {
    this.platform = {
      now: () => now().getTime(),
      randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
      log,
    };
    this.localVault = this.load();
  }

  /**
   * Handles the given request. The local vault handles requests one at a time, as each of them
   * reads the whole vault and then writes what changed in it, and stores and reads the content of
   * an attachment along with the request that it is sent with.
   *
   * Fails with a {@link LocalVaultIoError} if the vault folder cannot be reached, and with nothing
   * else.
   */
  async handle(request: LocalRequest): Promise<LocalResponse> {
    const loaded = await this.loaded();
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

  /**
   * Returns the local vault, which is loaded again if it could not be loaded. A load that was
   * started before this request and fails is tried once more for it, as what failed then, such as
   * the storage of the extension as the background starts, may work by now.
   *
   * Fails with a {@link LocalVaultIoError} if it cannot be loaded for this request either.
   */
  private async loaded(): Promise<LoadedLocalVault> {
    const earlier = this.localVault;
    if (earlier != null) {
      try {
        return await earlier;
      } catch {
        this.forget(earlier);
      }
    }
    this.localVault ??= this.load();
    const loading = this.localVault;
    try {
      return await loading;
    } catch {
      this.forget(loading);
      throw new LocalVaultIoError("The local vault cannot be loaded.");
    }
  }

  /**
   * Forgets a load of the local vault that failed, so that the next request loads it again, but
   * not one that another request already started in its place.
   */
  private forget(failed: Promise<LoadedLocalVault>): void {
    if (this.localVault === failed) {
      this.localVault = undefined;
    }
  }

  /**
   * Loads the local vault on the vault folder, for the ID of this installation.
   */
  private load(): Promise<LoadedLocalVault> {
    const deviceId = typeof this.deviceId === "string" ? this.deviceId : this.deviceId();
    const ready = Promise.all([localVault, deviceId]);
    const loading = ready.then(([wasm, id]): LoadedLocalVault => ({
      server: new wasm.LocalServer(
        this.fileSystem,
        this.platform,
        "browser",
        id,
        this.device.name,
        this.device.type,
      ),
      internalError: {
        code: 500,
        contentType: "application/json; charset=utf-8",
        body: wasm.internalErrorJson(),
        bytes: null,
      },
    }));
    // Every request that waits for it fails with this as well, but without saying why.
    void loading.catch((e: unknown) =>
      this.log("error", `The local vault cannot be loaded: ${String(e)}`),
    );
    return loading;
  }
}

/**
 * Returns `true` if the local vault failed because the vault folder cannot be reached. Its errors
 * are told by their name: they are not of a class here.
 */
function isIoError(e: unknown): e is Error {
  return typeof e === "object" && e != null && (e as Error).name === IO_ERROR_NAME;
}
