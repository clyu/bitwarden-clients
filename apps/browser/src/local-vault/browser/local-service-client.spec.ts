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
import { PasswordRequest } from "@bitwarden/common/auth/models/request/password.request";
import { RegisterFinishRequest } from "@bitwarden/common/auth/models/request/registration/register-finish.request";
import { IdentityTokenResponse } from "@bitwarden/common/auth/models/response/identity-token.response";
import { PasswordPreloginApiService } from "@bitwarden/common/auth/password-prelogin/password-prelogin-api.service";
import { PasswordPreloginRequest } from "@bitwarden/common/auth/password-prelogin/password-prelogin.request";
import { MasterPasswordApiService } from "@bitwarden/common/auth/services/master-password/master-password-api.service.implementation";
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
import { localVaultRequest } from "../server/local-vault-request";

import { installLocalFetch } from "./local-fetch";
import { LOCAL_VAULT_URLS } from "./local-vault-environment";

const EMAIL = "user@example.com";
const PASSWORD_HASH = "cGFzc3dvcmQtaGFzaA==";
const DEVICE_ID = "device";
// What the app names the device to a server, below.
const DEVICE = { name: "firefox", type: DeviceType.FirefoxExtension };
const ENCRYPTED =
  "2.aXZpdml2aXZpdml2aXZpdg==|ZGF0YQ==|bWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWE=";
const USER_KEY = ENCRYPTED as unknown as MasterKeyWrappedUserKey;
// The master password after a change, and the user key encrypted with the master key of it.
const NEW_PASSWORD_HASH = "bmV3LXBhc3N3b3JkLWhhc2g=";
const NEW_ENCRYPTED =
  "2.aXZpdml2aXZpdml2aXZpdg==|bmV3LWRhdGE=|bWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWE=";
const NEW_USER_KEY = NEW_ENCRYPTED as unknown as MasterKeyWrappedUserKey;

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
    const server = new LocalServer(fileSystem, DEVICE_ID, DEVICE);
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

  async function logIn(passwordHash = PASSWORD_HASH): Promise<IdentityTokenResponse> {
    const response = await apiService.postIdentityToken(
      new PasswordTokenRequest(
        EMAIL,
        passwordHash,
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

  function cipher(): Cipher {
    return new Cipher(
      new CipherData(
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

  /**
   * Adds an item with the request that the Bitwarden SDK makes for it: the app has the SDK save,
   * change and delete items, which `local-sdk-client.spec.ts` tests.
   */
  async function addItem(): Promise<CipherResponse> {
    const userId = activeAccount$.value!.id;
    const request = new CipherRequest({ cipher: cipher(), encryptedFor: userId });
    return new CipherResponse(await apiService.send("POST", "/ciphers", request, true, true));
  }

  /**
   * Asks where the content of a new attachment of the item goes, with the request that the SDK
   * makes for it. The app then sends the content there itself.
   */
  function addAttachment(itemId: string, size: number): Promise<any> {
    const request = new AttachmentRequest();
    request.fileName = ENCRYPTED;
    request.key = ENCRYPTED;
    request.fileSize = size;
    request.adminRequest = false;
    return apiService.send("POST", `/ciphers/${itemId}/attachment/v2`, request, true, true);
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

  it("changes the master password, which the account logs in with from then on", async () => {
    await register();
    await logIn();
    const stamp = (await apiService.getSync()).profile?.securityStamp;
    const kdf = new PBKDF2KdfConfig(600_000);
    const salt = EMAIL as MasterPasswordSalt;
    const unlockData = new MasterPasswordUnlockData(salt, kdf, NEW_USER_KEY);

    // What the app sends (`DefaultChangePasswordService.changePassword`): the hash of the master
    // password, and what the new one is known by and unlocks the user key with, with its hint.
    await new MasterPasswordApiService(apiService, mock<LogService>()).postPassword(
      new PasswordRequest(
        PASSWORD_HASH as MasterPasswordAuthenticationHash,
        {
          salt,
          kdf,
          masterPasswordAuthenticationHash: NEW_PASSWORD_HASH as MasterPasswordAuthenticationHash,
        },
        unlockData,
        "new hint",
      ),
    );

    await expect(logIn()).rejects.toMatchObject({ statusCode: 400 });
    const login = await logIn(NEW_PASSWORD_HASH);
    expect(login.key?.encryptedString).toBe(NEW_ENCRYPTED);
    expect(login.userDecryptionOptions?.masterPasswordUnlock?.toMasterPasswordUnlockData()).toEqual(
      unlockData,
    );
    // What logs the account out on the other devices, at their next sync.
    expect(stamp).toBeTruthy();
    expect((await apiService.getSync()).profile?.securityStamp).not.toBe(stamp);
    const hint = apiService.postPasswordHint(new PasswordHintRequest(EMAIL));
    await expect(hint).rejects.toMatchObject({ message: "Your master password hint: new hint" });
    expect(logoutCallback).not.toHaveBeenCalled();
  });

  it("does not report any feature flags", async () => {
    const config = await new ConfigApiService(apiService).get(null);

    expect(config.featureStates).toEqual({});
    expect(config.version).toBeTruthy();
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

  it("uploads and downloads an attachment", async () => {
    await register();
    await logIn();
    const created = await addItem();
    // An encrypted file: its type, IV and MAC, and then the data.
    const content = new Uint8Array(1 + 16 + 32 + 64).map((_, index) => index);
    content[0] = 2;

    const upload = await addAttachment(created.id, content.length);
    expect(upload.fileUploadType).toBe(FileUploadType.Azure);
    expect(upload.cipherResponse.attachments.map((a: any) => a.id)).toEqual([upload.attachmentId]);

    // What the app does with where the SDK was told that the content goes
    // (`CipherFileUploadService.uploadPrepared`).
    const rollback = jest.fn();
    await new FileUploadService(mock<LogService>(), apiService).upload(
      { url: upload.url, fileUploadType: FileUploadType.Azure },
      new EncString(ENCRYPTED),
      new EncArrayBuffer(content),
      {
        postDirect: jest.fn().mockRejectedValue(new Error("Not a direct upload")),
        renewFileUploadUrl: jest.fn().mockRejectedValue(new Error("Not renewed")),
        rollback,
      },
    );
    expect(rollback).not.toHaveBeenCalled();

    // What the app asks for to export the attachment (`IndividualVaultExportService`).
    const attachment = await apiService.getAttachmentData(created.id, upload.attachmentId);
    expect(attachment.fileName).toBe(ENCRYPTED);
    expect(attachment.size).toBe(String(content.length));
    // The way the app downloads it: with `fetch` itself, and without a token.
    const download = await fetch(new Request(attachment.url, { cache: "no-store" }));
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(content);
  });

  it("refuses an attachment that is uploaded in blocks, and stores nothing of it", async () => {
    await register();
    await logIn();
    const upload = await addAttachment((await addItem()).id, 1);
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

  it("lists the devices that share the vault folder, and retires one that is gone", async () => {
    await register();
    await logIn();
    // Another installation of the extension added a folder, and is gone for good since.
    const chrome = { name: "chrome", type: DeviceType.ChromeExtension };
    const gone = new LocalServer(fileSystem, "gone-device", chrome);
    const folder = localVaultRequest("POST", "api/folders", {
      token: accessToken,
      json: { name: ENCRYPTED },
    });
    expect((await gone.handle(folder)).code).toBe(200);

    // What the page of the devices asks for (`popup/local-vault-devices-api.ts`).
    const listDevices = () => apiService.send("GET", "/local-vault/devices", null, true, true);
    const retire = (id: string) =>
      apiService.send("POST", `/local-vault/devices/${id}/retire`, null, true, true);
    const devices = await listDevices();
    const retired = await retire("gone-device");

    const listed = devices.data.map((device: any) => [
      device.id,
      device.name,
      device.type,
      device.isCurrentDevice,
      device.retiredDate,
    ]);
    expect(listed).toEqual([
      [DEVICE_ID, "firefox", DeviceType.FirefoxExtension, true, null],
      ["gone-device", "chrome", DeviceType.ChromeExtension, false, null],
    ]);
    expect(retired.id).toBe("gone-device");
    expect(retired.name).toBe("chrome");
    const retiredAt = new Date(retired.retiredDate).getTime();
    expect(new Date(retired.removalDate).getTime() - retiredAt).toBe(90 * 24 * 60 * 60 * 1000);
    expect((await listDevices()).data[1].retiredDate).toBe(retired.retiredDate);
    // This device took over the folder that the other one added.
    expect((await apiService.getSync()).folders).toHaveLength(1);
    await expect(retire(DEVICE_ID)).rejects.toMatchObject({
      statusCode: 400,
      message: "This device cannot be retired.",
    });
  });

  it("fails like a request that does not reach its server when the vault folder is gone", async () => {
    await register();
    await logIn();
    jest.spyOn(fileSystem, "read").mockRejectedValue(new LocalVaultIoError("gone"));

    await expect(apiService.getSync()).rejects.toBeInstanceOf(TypeError);
    expect(logoutCallback).not.toHaveBeenCalled();
  });
});
