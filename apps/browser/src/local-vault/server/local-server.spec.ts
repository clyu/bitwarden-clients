/**
 * @jest-environment node
 */
import { localVaultHost } from "../../../local-vault-rs/pkg";
import { LOCAL_VAULT_HOST } from "../browser/local-vault-environment";

import { InMemoryLocalVaultFileSystem } from "./in-memory-local-vault-file-system";
import { LocalRequest } from "./local-request";
import { LocalServer, LocalServerLogLevel } from "./local-server";
import { LocalVaultIoError } from "./local-vault-file-system";
import { localVaultRequest } from "./local-vault-request";

const SOME_ID = "00000000-0000-4000-8000-000000000000";

/**
 * What the extension adds to the local vault, which is tested in `local-vault-rs` itself, and
 * with the app in `local-service-client.spec.ts`.
 */
describe("the local server of the extension", () => {
  let logged: [LocalServerLogLevel, string][];

  beforeEach(() => {
    logged = [];
  });

  function server(fileSystem = new InMemoryLocalVaultFileSystem()): LocalServer {
    return new LocalServer(
      fileSystem,
      () => new Date(),
      (level, message) => logged.push([level, message]),
    );
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
    const fileSystem = new InMemoryLocalVaultFileSystem();
    const content = new Uint8Array([1, 2, 3]);
    const url = `https://${LOCAL_VAULT_HOST}/attachments/user/cipher/attachment`;
    await fileSystem.write(["user", "attachments", "cipher", "attachment"], content);

    const response = await server(fileSystem).handle(localVaultRequest("GET", url));

    expect(response.code).toBe(200);
    expect(response.contentType).toBe("application/octet-stream");
    expect(response.bytes).toEqual(content);
  });

  it("answers what the local vault cannot take with an error, and logs only its kind", async () => {
    const response = await server().handle({ url: "https://vault.local.invalid/" } as LocalRequest);

    expect(response.code).toBe(500);
    expect(JSON.parse(response.body!).object).toBe("error");
    expect(logged).toEqual([["error", "Local server error: Error"]]);
  });
});
