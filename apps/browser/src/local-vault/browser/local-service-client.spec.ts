/**
 * Runs with the `fetch`, `Request` and `Response` of Node, which jsdom does not have.
 * @jest-environment node
 */
import { mock } from "jest-mock-extended";
import { BehaviorSubject, of } from "rxjs";

import { decodeJwtTokenToJson } from "@bitwarden/auth/common";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { TokenService } from "@bitwarden/common/auth/abstractions/token.service";
import { DeviceRequest } from "@bitwarden/common/auth/models/request/identity-token/device.request";
import { PasswordTokenRequest } from "@bitwarden/common/auth/models/request/identity-token/password-token.request";
import { TokenTwoFactorRequest } from "@bitwarden/common/auth/models/request/identity-token/token-two-factor.request";
import { PasswordHintRequest } from "@bitwarden/common/auth/models/request/password-hint.request";
import { RegisterFinishRequest } from "@bitwarden/common/auth/models/request/registration/register-finish.request";
import { IdentityTokenResponse } from "@bitwarden/common/auth/models/response/identity-token.response";
import { PasswordPreloginApiService } from "@bitwarden/common/auth/password-prelogin/password-prelogin-api.service";
import { PasswordPreloginRequest } from "@bitwarden/common/auth/password-prelogin/password-prelogin.request";
import { ClientType, DeviceType } from "@bitwarden/common/enums";
import {
  MasterKeyWrappedUserKey,
  MasterPasswordAuthenticationHash,
  MasterPasswordSalt,
  MasterPasswordUnlockData,
} from "@bitwarden/common/key-management/master-password/types/master-password.types";
import { VaultTimeoutSettingsService } from "@bitwarden/common/key-management/vault-timeout";
import { ImportCiphersRequest } from "@bitwarden/common/models/request/import-ciphers.request";
import { KeysRequest } from "@bitwarden/common/models/request/keys.request";
import { KvpRequest } from "@bitwarden/common/models/request/kvp.request";
import { ErrorResponse } from "@bitwarden/common/models/response/error.response";
import { AppIdService } from "@bitwarden/common/platform/abstractions/app-id.service";
import { ConfigService } from "@bitwarden/common/platform/abstractions/config/config.service";
import { EnvironmentService } from "@bitwarden/common/platform/abstractions/environment.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { FileUploadType } from "@bitwarden/common/platform/enums";
import { ConfigApiService } from "@bitwarden/common/platform/services/config/config-api.service";
import { SelfHostedEnvironment } from "@bitwarden/common/platform/services/default-environment.service";
import { FileUploadService } from "@bitwarden/common/platform/services/file-upload/file-upload.service";
import { ApiService } from "@bitwarden/common/services/api.service";
import { UserId } from "@bitwarden/common/types/guid";
import { InternalFolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherData } from "@bitwarden/common/vault/models/data/cipher.data";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { Folder } from "@bitwarden/common/vault/models/domain/folder";
import { AttachmentRequest } from "@bitwarden/common/vault/models/request/attachment.request";
import { CipherBulkDeleteRequest } from "@bitwarden/common/vault/models/request/cipher-bulk-delete.request";
import { CipherBulkRestoreRequest } from "@bitwarden/common/vault/models/request/cipher-bulk-restore.request";
import { CipherCreateRequest } from "@bitwarden/common/vault/models/request/cipher-create.request";
import { CipherPartialRequest } from "@bitwarden/common/vault/models/request/cipher-partial.request";
import { CipherRequest } from "@bitwarden/common/vault/models/request/cipher.request";
import { FolderWithOptionalIdRequest } from "@bitwarden/common/vault/models/request/folder-with-optional-id.request";
import { CipherResponse } from "@bitwarden/common/vault/models/response/cipher.response";
import { FolderApiService } from "@bitwarden/common/vault/services/folder/folder-api.service";
import { ImportApiService } from "@bitwarden/importer-core";
// The requests of the app are built with these, as the app builds them.
// eslint-disable-next-line no-restricted-imports
import { EncArrayBuffer, EncString, PBKDF2KdfConfig } from "@bitwarden/legacy-crypto";

import { InMemoryLocalVaultFileSystem } from "../server/in-memory-local-vault-file-system";
import { LocalServer } from "../server/local-server";
import { LocalVaultIoError } from "../server/local-vault-file-system";

import { installLocalFetch } from "./local-fetch";
import { LOCAL_VAULT_URLS } from "./local-vault-environment";

const EMAIL = "user@example.com";
const PASSWORD_HASH = "cGFzc3dvcmQtaGFzaA==";
const ENCRYPTED =
  "2.aXZpdml2aXZpdml2aXZpdg==|ZGF0YQ==|bWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWE=";
const USER_KEY = ENCRYPTED as unknown as MasterKeyWrappedUserKey;

/**
 * The API services of the app, talking to the local server through `fetch` the way they do in
 * the extension. What the app sends and what it makes of the answers is not written out here, so
 * this fails when an update changes either in a way that the local server does not follow.
 */
describe("the API services of the app on a local vault", () => {
  const nativeFetch = globalThis.fetch;
  const environment = new SelfHostedEnvironment({ ...LOCAL_VAULT_URLS });
  const activeAccount$ = new BehaviorSubject<Account | null>(null);
  let fileSystem: InMemoryLocalVaultFileSystem;
  let accessToken: string | null;
  let apiService: ApiService;
  let logoutCallback: jest.Mock;

  const tokenService = mock<TokenService>();
  const platformUtilsService = mock<PlatformUtilsService>();
  const environmentService = mock<EnvironmentService>();
  const appIdService = mock<AppIdService>();
  const accountService = mock<AccountService>();
  const vaultTimeoutSettingsService = mock<VaultTimeoutSettingsService>();

  beforeEach(() => {
    fileSystem = new InMemoryLocalVaultFileSystem();
    const server = new LocalServer(fileSystem);
    globalThis.fetch = nativeFetch;
    installLocalFetch((request) => server.handle(request));

    accessToken = null;
    activeAccount$.next(null);
    tokenService.getAccessToken.mockImplementation(async () => accessToken as string);
    tokenService.tokenNeedsRefresh.mockResolvedValue(false);
    platformUtilsService.getDevice.mockReturnValue(DeviceType.FirefoxExtension);
    platformUtilsService.getDeviceString.mockReturnValue("firefox");
    platformUtilsService.getClientType.mockReturnValue(ClientType.Browser);
    platformUtilsService.getApplicationVersionNumber.mockResolvedValue("2026.10.0");
    platformUtilsService.isDev.mockReturnValue(false);
    environmentService.environment$ = of(environment);
    environmentService.getEnvironment$.mockReturnValue(of(environment));
    appIdService.getAppId.mockResolvedValue("app-id");
    accountService.activeAccount$ = activeAccount$;
    logoutCallback = jest.fn();

    apiService = new ApiService(
      tokenService,
      platformUtilsService,
      environmentService,
      appIdService,
      jest.fn(),
      mock<LogService>(),
      logoutCallback,
      vaultTimeoutSettingsService,
      accountService,
      { createRequest: (url, request) => new Request(url, request) },
    );
  });

  afterAll(() => {
    globalThis.fetch = nativeFetch;
  });

  async function register(): Promise<void> {
    const kdf = new PBKDF2KdfConfig(600_000);
    const salt = EMAIL as MasterPasswordSalt;
    const verificationToken: string = await apiService.send(
      "POST",
      "/accounts/register/send-verification-email",
      { email: EMAIL, name: "User", receiveMarketingEmails: false },
      false,
      true,
      environment.getIdentityUrl(),
    );
    await apiService.send(
      "POST",
      "/accounts/register/finish",
      new RegisterFinishRequest(
        EMAIL,
        "hint",
        new KeysRequest(btoa("publicKey"), ENCRYPTED),
        {
          salt,
          kdf,
          masterPasswordAuthenticationHash: PASSWORD_HASH as MasterPasswordAuthenticationHash,
        },
        new MasterPasswordUnlockData(salt, kdf, USER_KEY),
        verificationToken,
      ),
      false,
      true,
      environment.getIdentityUrl(),
    );
  }

  async function logIn(): Promise<IdentityTokenResponse> {
    const response = await apiService.postIdentityToken(
      new PasswordTokenRequest(
        EMAIL,
        PASSWORD_HASH,
        new TokenTwoFactorRequest(),
        new DeviceRequest("app-id", platformUtilsService),
      ),
    );
    if (!(response instanceof IdentityTokenResponse)) {
      throw new Error("Not logged in");
    }
    accessToken = response.accessToken;
    const id: UserId = decodeJwtTokenToJson(response.accessToken).sub;
    activeAccount$.next({ id, email: EMAIL } as Account);
    return response;
  }

  function cipher(response?: CipherResponse): Cipher {
    return new Cipher(
      new CipherData(
        response ??
          new CipherResponse({
            type: CipherType.Login,
            name: ENCRYPTED,
            favorite: false,
            reprompt: 0,
            login: { username: ENCRYPTED, password: ENCRYPTED, uris: [{ uri: ENCRYPTED }] },
          }),
      ),
    );
  }

  function vaultFile(): any {
    const userId: string = decodeJwtTokenToJson(accessToken!).sub;
    return JSON.parse(new TextDecoder().decode(fileSystem.files.get(`${userId}/vault.json`)));
  }

  it("leaves requests for other hosts alone", async () => {
    const other = jest.fn().mockResolvedValue(new Response("other"));
    globalThis.fetch = other;
    installLocalFetch(async () => ({
      code: 200,
      contentType: "application/json",
      body: '"local"',
      bytes: null,
    }));

    expect(await (await fetch("https://example.com/api/sync")).text()).toBe("other");
    expect(await (await fetch(new URL("https://vault.local.invalid/api/sync"))).json()).toBe(
      "local",
    );
    expect(await (await fetch(new Request("https://vault.local.invalid/x"))).json()).toBe("local");
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("answers with the address of the request, which the Bitwarden SDK asks a response for", async () => {
    const response = await fetch("https://vault.local.invalid/api/config?x=1");

    expect(response.url).toBe("https://vault.local.invalid/api/config?x=1");
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it("registers, finds the KDF and logs in", async () => {
    await register();

    const prelogin = await new PasswordPreloginApiService(
      apiService,
      environmentService,
    ).getPreloginData(new PasswordPreloginRequest(EMAIL));
    expect(prelogin.kdfSettings.toKdfConfig()).toEqual(new PBKDF2KdfConfig(600_000));
    expect(prelogin.salt).toBe(EMAIL);

    const login = await logIn();
    expect(login.kdfConfig).toEqual(new PBKDF2KdfConfig(600_000));
    expect(login.key?.encryptedString).toBe(ENCRYPTED);
    expect(login.privateKey).toBe(ENCRYPTED);
    expect(login.refreshToken).toMatch(/^local-refresh\./);
    expect(login.userDecryptionOptions?.hasMasterPassword).toBe(true);
    expect(login.userDecryptionOptions?.masterPasswordUnlock?.toMasterPasswordUnlockData()).toEqual(
      new MasterPasswordUnlockData(
        EMAIL as MasterPasswordSalt,
        new PBKDF2KdfConfig(600_000),
        USER_KEY,
      ),
    );
  });

  it("reports a wrong master password the way the identity server does", async () => {
    await register();

    const login = apiService.postIdentityToken(
      new PasswordTokenRequest(EMAIL, "d3Jvbmc=", new TokenTwoFactorRequest()),
    );

    await expect(login).rejects.toMatchObject({
      statusCode: 400,
      message: "Username or password is incorrect. Try again.",
    });
  });

  it("shows the password hint as the message of an error", async () => {
    await register();

    const hint = apiService.postPasswordHint(new PasswordHintRequest(EMAIL));

    await expect(hint).rejects.toBeInstanceOf(ErrorResponse);
    await expect(hint).rejects.toMatchObject({ message: "Your master password hint: hint" });
  });

  it("syncs the vault of the account", async () => {
    await register();
    await logIn();

    const revisionDate = await apiService.getAccountRevisionDate();
    const sync = await apiService.getSync();

    expect(typeof revisionDate).toBe("number");
    expect(sync.profile).toMatchObject({
      email: EMAIL,
      name: "User",
      emailVerified: true,
      premiumPersonally: true,
      premiumFromOrganization: false,
      usesKeyConnector: false,
      organizations: [],
    });
    expect(sync.profile?.key?.encryptedString).toBe(ENCRYPTED);
    expect(sync.profile?.accountKeys?.publicKeyEncryptionKeyPair?.publicKey).toEqual(
      new TextEncoder().encode("publicKey"),
    );
    expect(sync.userDecryption?.masterPasswordUnlock?.salt).toBe(EMAIL);
    expect(sync.folders).toEqual([]);
    expect(sync.ciphers).toEqual([]);
    expect(sync.sends).toEqual([]);
    expect(sync.policies).toEqual([]);
    expect(await apiService.getAccountRevisionDate()).toBeLessThanOrEqual(revisionDate);
  });

  it("does not report any feature flags", async () => {
    const config = await new ConfigApiService(apiService).get(null);

    expect(config.featureStates).toEqual({});
    expect(config.version).toBeTruthy();
  });

  it("saves, changes and deletes items", async () => {
    await register();
    await logIn();
    const userId = activeAccount$.value!.id;

    const created = await apiService.postCipherCreate(
      new CipherCreateRequest({ cipher: cipher(), encryptedFor: userId }),
    );
    expect(created.id).toBeTruthy();
    expect(created.name).toBe(ENCRYPTED);
    expect(created.login.username).toBe(ENCRYPTED);
    expect(created.login.uris[0].uri).toBe(ENCRYPTED);
    expect(created.edit).toBe(true);
    expect(created.viewPassword).toBe(true);
    expect(created.permissions).toMatchObject({ delete: true, restore: true });
    expect(new Date(created.revisionDate).getTime()).not.toBeNaN();

    // The app sends the revision date that it knows the item by, which has to be accepted.
    const edited = cipher(created);
    edited.favorite = true;
    const updated = await apiService.putCipher(
      created.id,
      new CipherRequest({ cipher: edited, encryptedFor: userId }),
    );
    expect(updated.id).toBe(created.id);
    expect(updated.favorite).toBe(true);
    expect(updated.creationDate).toBe(created.creationDate);

    const outdated = apiService.putCipher(
      created.id,
      new CipherRequest({
        cipher: Object.assign(cipher(updated), { revisionDate: new Date(0) }),
        encryptedFor: userId,
      }),
    );
    await expect(outdated).rejects.toMatchObject({ statusCode: 400 });

    const partial = cipher(updated);
    partial.favorite = false;
    expect(
      (await apiService.putPartialCipher(created.id, new CipherPartialRequest(partial))).favorite,
    ).toBe(false);

    await apiService.putDeleteCipher(created.id);
    expect(vaultFile().sync.ciphers[0].deletedDate).toBeTruthy();
    expect((await apiService.putRestoreCipher(created.id)).deletedDate).toBeNull();

    await apiService.putDeleteManyCiphers(new CipherBulkDeleteRequest([created.id]));
    const restored = await apiService.putRestoreManyCiphers(
      new CipherBulkRestoreRequest([created.id]),
    );
    expect(restored.data.map((c) => c.id)).toEqual([created.id]);

    const sync = await apiService.getSync();
    expect(sync.ciphers.map((c) => c.id)).toEqual([created.id]);
    expect((await apiService.getCipher(created.id)).id).toBe(created.id);

    await apiService.deleteManyCiphers(new CipherBulkDeleteRequest([created.id]));
    expect((await apiService.getSync()).ciphers).toEqual([]);
    expect(logoutCallback).not.toHaveBeenCalled();
  });

  it("saves, renames and deletes folders", async () => {
    await register();
    await logIn();
    const userId = activeAccount$.value!.id;
    const folderApiService = new FolderApiService(mock<InternalFolderService>(), apiService);
    const folder = new Folder();
    folder.name = new EncString(ENCRYPTED);

    const saved = await folderApiService.save(folder, userId);
    expect(saved.id).toBeTruthy();
    expect(saved.name).toBe(ENCRYPTED);

    const renamed = await folderApiService.save(new Folder(saved), userId);
    expect(renamed.id).toBe(saved.id);
    expect((await folderApiService.get(saved.id)).id).toBe(saved.id);
    expect((await apiService.getSync()).folders.map((f) => f.id)).toEqual([saved.id]);

    await folderApiService.delete(saved.id, userId);
    expect((await apiService.getSync()).folders).toEqual([]);
  });

  it("uploads, downloads and deletes an attachment", async () => {
    await register();
    await logIn();
    const userId = activeAccount$.value!.id;
    const created = await apiService.postCipherCreate(
      new CipherCreateRequest({ cipher: cipher(), encryptedFor: userId }),
    );
    // An encrypted file: its type, IV and MAC, and then the data.
    const content = new Uint8Array(1 + 16 + 32 + 64).map((_, index) => index);
    content[0] = 2;
    const request = new AttachmentRequest();
    request.fileName = ENCRYPTED;
    request.key = ENCRYPTED;
    request.fileSize = content.length;
    request.adminRequest = false;

    const upload = await apiService.postCipherAttachment(created.id, request);
    expect(upload.fileUploadType).toBe(FileUploadType.Azure);
    expect(upload.cipherResponse.attachments.map((a) => a.id)).toEqual([upload.attachmentId]);

    const rollback = jest.fn();
    await new FileUploadService(mock<LogService>(), apiService, mock<ConfigService>()).upload(
      upload,
      new EncString(ENCRYPTED),
      new EncArrayBuffer(content),
      {
        postDirect: jest.fn().mockRejectedValue(new Error("Not a direct upload")),
        renewFileUploadUrl: jest.fn().mockRejectedValue(new Error("Not renewed")),
        rollback,
      },
    );
    expect(rollback).not.toHaveBeenCalled();

    const attachment = await apiService.getAttachmentData(created.id, upload.attachmentId);
    expect(attachment.fileName).toBe(ENCRYPTED);
    expect(attachment.size).toBe(String(content.length));
    // The way the app downloads it: with `fetch` itself, and without a token.
    const download = await fetch(new Request(attachment.url, { cache: "no-store" }));
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(content);

    const deleted = await apiService.deleteCipherAttachment(created.id, upload.attachmentId);
    expect(deleted.cipher.id).toBe(created.id);
    expect(deleted.cipher.attachments ?? []).toEqual([]);
    expect((await fetch(new Request(attachment.url))).status).toBe(404);
  });

  it("refuses an attachment that is uploaded in blocks, and stores nothing of it", async () => {
    await register();
    await logIn();
    const userId = activeAccount$.value!.id;
    const created = await apiService.postCipherCreate(
      new CipherCreateRequest({ cipher: cipher(), encryptedFor: userId }),
    );
    const request = new AttachmentRequest();
    request.fileName = ENCRYPTED;
    request.key = ENCRYPTED;
    request.fileSize = 1;
    request.adminRequest = false;
    const upload = await apiService.postCipherAttachment(created.id, request);
    const put = (query: string) =>
      fetch(new Request(`${upload.url}?${query}`, { method: "PUT", body: "content" }));

    // What the app sends for a file of more than 256 MB: a block, and then the list of blocks.
    expect((await put("comp=block&blockid=MA%3D%3D")).status).toBe(400);
    expect((await put("comp=blocklist")).status).toBe(400);
    expect((await fetch(new Request(upload.url))).status).toBe(404);
  });

  it("imports items with their folders", async () => {
    await register();
    await logIn();
    const userId = activeAccount$.value!.id;
    const folder = new Folder();
    folder.name = new EncString(ENCRYPTED);
    const request = new ImportCiphersRequest();
    request.ciphers = [
      new CipherRequest({ cipher: cipher(), encryptedFor: userId }),
      new CipherRequest({ cipher: cipher(), encryptedFor: userId }),
    ];
    request.folders = [new FolderWithOptionalIdRequest(folder)];
    request.folderRelationships = [new KvpRequest(1, 0)];

    await new ImportApiService(apiService).postImportCiphers(request);

    const sync = await apiService.getSync();
    expect(sync.folders).toHaveLength(1);
    expect(sync.ciphers.map((c) => c.folderId ?? null)).toEqual([null, sync.folders[0].id]);
  });

  it("refuses what needs a server with a message, and without logging the account out", async () => {
    await register();
    await logIn();

    const sends = apiService.send("GET", "/sends", null, true, true);

    await expect(sends).rejects.toBeInstanceOf(ErrorResponse);
    await expect(sends).rejects.toMatchObject({
      statusCode: 400,
      message: "This feature needs a Bitwarden server and is not available with a local vault.",
    });
    expect(logoutCallback).not.toHaveBeenCalled();
  });

  it("fails like a request that does not reach its server when the vault folder is gone", async () => {
    await register();
    await logIn();
    jest.spyOn(fileSystem, "read").mockRejectedValue(new LocalVaultIoError("gone"));

    await expect(apiService.getSync()).rejects.toBeInstanceOf(TypeError);
    expect(logoutCallback).not.toHaveBeenCalled();
  });
});
