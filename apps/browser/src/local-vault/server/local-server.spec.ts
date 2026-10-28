/**
 * @jest-environment node
 */
import { DeviceType } from "@bitwarden/common/enums";

import { localVaultHost } from "../../../local-vault-rs/pkg";
import { LOCAL_VAULT_HOST } from "../browser/local-vault-environment";

import { InMemoryLocalVaultFileSystem } from "./in-memory-local-vault-file-system";
import { LocalRequest, LocalResponse } from "./local-request";
import { LocalServer, LocalServerLogLevel } from "./local-server";
import { LocalVaultIoError } from "./local-vault-file-system";
import { localVaultRequest } from "./local-vault-request";

const SOME_ID = "00000000-0000-4000-8000-000000000000";

const PASSWORD_HASH = "aGFzaA==";

/**
 * What the local vault takes to register an account, with stand-ins for its keys.
 */
const REGISTRATION = {
  email: "user@example.com",
  userAsymmetricKeys: { publicKey: "publicKey", encryptedPrivateKey: "2.privateKey" },
  masterPasswordAuthentication: { masterPasswordAuthenticationHash: PASSWORD_HASH },
  masterPasswordUnlock: {
    salt: "user@example.com",
    kdf: { kdfType: 0, iterations: 600000 },
    masterKeyWrappedUserKey: "2.userKey",
  },
};

/**
 * What the extension adds to the local vault, which is tested in `local-vault-rs` itself, and
 * with the app in `local-service-client.spec.ts`.
 */
describe("the local server of the extension", () => {
  let logged: [LocalServerLogLevel, string][];

  beforeEach(() => {
    logged = [];
  });

  function server(
    fileSystem = new InMemoryLocalVaultFileSystem(),
    deviceId: string | (() => Promise<string>) = "device",
  ): LocalServer {
    return new LocalServer(
      fileSystem,
      deviceId,
      { name: "chrome", type: DeviceType.ChromeExtension },
      () => new Date(),
      (level, message) => logged.push([level, message]),
    );
  }

  function prelogin(local: LocalServer): Promise<LocalResponse> {
    return local.handle(
      localVaultRequest("POST", "identity/accounts/prelogin", {
        json: { email: "user@example.com" },
      }),
    );
  }

  /**
   * Registers an account, logs in to it, and returns its access token.
   */
  async function logIn(local: LocalServer): Promise<string> {
    await local.handle(
      localVaultRequest("POST", "identity/accounts/register/finish", { json: REGISTRATION }),
    );
    const login = await local.handle(
      localVaultRequest("POST", "identity/connect/token", {
        form: {
          grant_type: "password",
          username: "user@example.com",
          password: PASSWORD_HASH,
          client_id: "browser",
        },
      }),
    );
    return JSON.parse(login.body!).access_token;
  }

  it("has the host of the local vault", () => {
    expect(LOCAL_VAULT_HOST).toBe(localVaultHost());
  });

  it("fails with what the vault folder failed with when it cannot be reached", async () => {
    const fileSystem = new InMemoryLocalVaultFileSystem();
    jest.spyOn(fileSystem, "list").mockRejectedValue(new LocalVaultIoError("gone"));

    const prelogin = server(fileSystem).handle(
      localVaultRequest("POST", "identity/accounts/prelogin", {
        json: { email: "user@example.com" },
      }),
    );

    await expect(prelogin).rejects.toBeInstanceOf(LocalVaultIoError);
    await expect(prelogin).rejects.toThrow("gone");
  });

  it("logs a request that it refuses as a warning, without what it was about", async () => {
    const response = await server().handle(localVaultRequest("GET", `api/sends/${SOME_ID}`));

    expect(response.code).toBe(400);
    expect(logged).toEqual([["warning", "Local server refused: GET sends/*"]]);
  });

  it("stores and reads the content of an attachment through the local vault", async () => {
    const local = server();
    const content = new Uint8Array([1, 2, 3]);
    // The local vault only hands out the content of an attachment that an item of the vault has.
    const token = await logIn(local);
    const cipher = await local.handle(
      localVaultRequest("POST", "api/ciphers", { token, json: { type: 1 } }),
    );
    const cipherId: string = JSON.parse(cipher.body!).id;
    const upload = await local.handle(
      localVaultRequest("POST", `api/ciphers/${cipherId}/attachment/v2`, { token, json: {} }),
    );
    const url: string = JSON.parse(upload.body!).url;

    const stored = await local.handle(localVaultRequest("PUT", url, { bytes: content }));
    const response = await local.handle(localVaultRequest("GET", url));

    expect(stored.code).toBe(201);
    expect(response.code).toBe(200);
    expect(response.contentType).toBe("application/octet-stream");
    expect(response.bytes).toEqual(content);
  });

  it("reads the ID of the installation again for the requests that waited for it", async () => {
    const deviceId = jest.fn(async (): Promise<string> => "device");
    // As the background starts, the storage of the extension cannot be read yet.
    deviceId.mockRejectedValueOnce(new Error("storage"));
    const local = server(new InMemoryLocalVaultFileSystem(), deviceId);

    const responses = await Promise.all([prelogin(local), prelogin(local)]);

    expect(responses.map((response) => response.code)).toEqual([200, 200]);
    // Once as the background started, and once more for both requests.
    expect(deviceId).toHaveBeenCalledTimes(2);
    expect(logged).toContainEqual(["error", "The local vault cannot be loaded: Error: storage"]);
  });

  it("keeps reading the ID of the installation for each request until it can", async () => {
    const deviceId = jest.fn(async (): Promise<string> => "device");
    // Neither as the background starts, nor once more for the first request.
    deviceId
      .mockRejectedValueOnce(new Error("storage"))
      .mockRejectedValueOnce(new Error("storage"));
    const local = server(new InMemoryLocalVaultFileSystem(), deviceId);

    await expect(prelogin(local)).rejects.toBeInstanceOf(LocalVaultIoError);
    expect((await prelogin(local)).code).toBe(200);
    expect(deviceId).toHaveBeenCalledTimes(3);
  });

  it("answers what the local vault cannot take with an error, and logs only its kind", async () => {
    const response = await server().handle({ url: "https://vault.local.invalid/" } as LocalRequest);

    expect(response.code).toBe(500);
    expect(JSON.parse(response.body!).object).toBe("error");
    expect(logged).toEqual([["error", "Local server error: Error"]]);
  });
});
