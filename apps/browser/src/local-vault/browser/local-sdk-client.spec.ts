/**
 * Runs with the `fetch`, `Request` and `Response` of Node, which jsdom does not have.
 * @jest-environment node
 */
import { mock } from "jest-mock-extended";
import { of } from "rxjs";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { SdkService } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { Rc } from "@bitwarden/common/platform/misc/reference-counting/rc";
import { SyncResponse } from "@bitwarden/common/platform/sync/sync.response";
import { CipherId, UserId } from "@bitwarden/common/types/guid";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherData } from "@bitwarden/common/vault/models/data/cipher.data";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { CipherResponse } from "@bitwarden/common/vault/models/response/cipher.response";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { DefaultCipherSdkService } from "@bitwarden/common/vault/services/cipher-sdk.service";
import {
  Cipher as SdkCipher,
  CreatedAttachment,
  CryptoSyncData,
  EncString,
  InitUserCryptoRequest,
  Kdf,
  ManagedSettingsClient,
  PasswordManagerClient,
  PureCrypto,
  Repository,
  WasmStateBridge,
} from "@bitwarden/sdk-internal";

// Accounts that the SDK can unlock, with their keys: the ones that upstream tests the SDK with.
// eslint-disable-next-line no-restricted-imports
import { accountEncryptedV1 } from "../../../../../libs/importer/src/importers/spec-data/bitwarden-json/account-encrypted-v1.json";
// eslint-disable-next-line no-restricted-imports
import { accountEncryptedV2 } from "../../../../../libs/importer/src/importers/spec-data/bitwarden-json/account-encrypted-v2.json";
import { InMemoryLocalVaultFileSystem } from "../server/in-memory-local-vault-file-system";
import { LocalResponse } from "../server/local-request";
import { LocalServer } from "../server/local-server";
import { localVaultRequest, LocalVaultRequestOptions } from "../server/local-vault-request";

import { utf8Decode, utf8Encode } from "./encoding";
import { installLocalFetch } from "./local-fetch";
import { LOCAL_VAULT_URLS } from "./local-vault-environment";

// The same account twice: with the keys that an account has had so far, which a master password
// unlocks, and with the keys of the encryption that follows them, among them a user key that
// has an ID.
const V1: any = accountEncryptedV1.account;
const V2: any = accountEncryptedV2.account;
const USER_ID: UserId = V1.userId;
const EMAIL: string = V1.email;
const MASTER_PASSWORD: string = V1.method.masterPasswordUnlock.password;

// What the local server knows the master password by, where a test does not need the real one.
const PASSWORD_HASH = "cGFzc3dvcmQtaGFzaA==";

// What only the client may read. None of it can be part of Base64, so finding it in the vault
// folder means that it was stored as it is.
const NAME = "The name of the item";
const NOTES = "What the item is about";
const USERNAME = "the-user-name";
const PASSWORD = "the-secret-password";

// Something that is encrypted, as far as the SDK and the local server look at it.
const ENCRYPTED =
  "2.aXZpdml2aXZpdml2aXZpdg==|ZGF0YQ==|bWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWFjbWE=";

/**
 * Keeps what the SDK stores of the vault, in the place of the state of the app.
 */
class InMemoryRepository<T> implements Repository<T> {
  private readonly values = new Map<string, T>();

  async get(id: string): Promise<T | null> {
    return this.values.get(id) ?? null;
  }

  async list(): Promise<T[]> {
    return [...this.values.values()];
  }

  async set(id: string, value: T): Promise<void> {
    this.values.set(id, value);
  }

  async setBulk(values: [string, T][]): Promise<void> {
    values.forEach(([id, value]) => this.values.set(id, value));
  }

  async remove(id: string): Promise<void> {
    this.values.delete(id);
  }

  async removeBulk(keys: string[]): Promise<void> {
    keys.forEach((key) => this.values.delete(key));
  }

  async removeAll(): Promise<void> {
    this.values.clear();
  }
}

/**
 * A local server with an account in it, and the SDK unlocked for that account.
 */
interface LocalVault {
  fileSystem: InMemoryLocalVaultFileSystem;
  server: LocalServer;
  /** What the local server logged: what it has no route for, and what went wrong in it. */
  logged: string[];
  /** The items that the SDK keeps, which the app has in its state. */
  ciphers: InMemoryRepository<SdkCipher>;
  /** What the SDK has the app keep for it, by the name that the SDK asks for it by. */
  state: Map<string, unknown>;
  /** What the local server knows the master password of the account by. */
  passwordHash: string;
  token: string;
  sdk: PasswordManagerClient;
  cipherSdkService: DefaultCipherSdkService;
  stop: () => void;
}

/**
 * Starts a local server and the SDK for the given account.
 *
 * - `withState`: the SDK is given where the app keeps what the SDK asks it to
 *   (`JsWasmStateBridge`), as the app does. Without it, the SDK has what it is unlocked with.
 * - `withMasterPassword`: the local server knows the account by its real master password, and
 *   not by a hash that stands in for it.
 */
async function start(
  account: any,
  options: { withState?: boolean; withMasterPassword?: boolean } = {},
): Promise<LocalVault> {
  const nativeFetch = globalThis.fetch;
  const fileSystem = new InMemoryLocalVaultFileSystem();
  const logged: string[] = [];
  const server = new LocalServer(
    fileSystem,
    () => new Date(),
    (_, message) => logged.push(message),
  );
  installLocalFetch((request) => server.handle(request));

  let token = "";
  const sdk = new PasswordManagerClient(
    { get_access_token: async () => token },
    {
      apiUrl: `${LOCAL_VAULT_URLS.base}/api`,
      identityUrl: `${LOCAL_VAULT_URLS.base}/identity`,
      userAgent: "local-vault",
    },
    new ManagedSettingsClient(),
  );
  // What the app has the SDK keep in its state (`initializeClientManagedState`).
  const ciphers = new InMemoryRepository<SdkCipher>();
  const repositories = sdk.platform().state();
  repositories.register_client_managed_repositories({
    cipher: ciphers,
    folder: null,
    local_user_data_key_state: new InMemoryRepository(),
    organization: null,
    organization_shared_key: null,
    policy: null,
    send: new InMemoryRepository(),
  });
  const state = new Map<string, unknown>();
  const unlock = account.method.masterPasswordUnlock?.master_password_unlock;
  if (options.withState) {
    // What the app has in its state for an account that is signed in.
    state.set("kdf_config", account.kdfParams);
    if (unlock != null) {
      state.set("masterpassword_unlock_data", unlock);
    }
    sdk.km_state_bridge().register_bridge_impl(stateBridge(state));
  }
  await sdk.crypto().initialize_user_crypto(account as InitUserCryptoRequest);

  let passwordHash = PASSWORD_HASH;
  if (options.withMasterPassword) {
    // The hash that the SDK derives from the master password, with what the account has now.
    const update = await sdk.crypto().make_update_kdf(MASTER_PASSWORD, account.kdfParams);
    passwordHash = update.oldMasterPasswordAuthenticationData.masterPasswordAuthenticationHash;
  }
  token = await registerAndLogIn(server, fileSystem, account, passwordHash);

  const sdkReference = new Rc(sdk);
  const sdkService = mock<SdkService>();
  sdkService.userClient$.mockReturnValue(of(sdkReference));
  return {
    fileSystem,
    server,
    logged,
    ciphers,
    state,
    passwordHash,
    token,
    sdk,
    cipherSdkService: new DefaultCipherSdkService(sdkService, mock<LogService>()),
    stop: () => {
      sdkReference.markForDisposal();
      globalThis.fetch = nativeFetch;
    },
  };
}

/**
 * Keeps what the SDK has the app keep for it, in the place of the state of the app. The SDK
 * asks for each of these things by a name, with `get_`, `set_` or `clear_` before it.
 */
function stateBridge(state: Map<string, unknown>): WasmStateBridge {
  const bridge = new Proxy(
    {},
    {
      get: (_, property) => {
        const [, action, name] = /^(get|set|clear)_(.+)$/.exec(String(property)) ?? [];
        switch (action) {
          case "get":
            return async (): Promise<unknown> => state.get(name) ?? null;
          case "set":
            return async (value: unknown): Promise<void> => {
              state.set(name, value);
            };
          case "clear":
            return async (): Promise<void> => {
              state.delete(name);
            };
          default:
            return undefined;
        }
      },
    },
  );
  return bridge as WasmStateBridge;
}

function request(
  server: LocalServer,
  method: string,
  path: string,
  options: LocalVaultRequestOptions = {},
): Promise<LocalResponse> {
  return server.handle(localVaultRequest(method, path, options));
}

/**
 * Registers the account with the local server, with the keys that the SDK has for it where the
 * local server keeps them, and signs it in.
 */
async function registerAndLogIn(
  server: LocalServer,
  fileSystem: InMemoryLocalVaultFileSystem,
  account: any,
  passwordHash: string,
): Promise<string> {
  const [keys]: any[] = Object.values(account.accountCryptographicState);
  // An account that is not unlocked with a master password here still has one for the server.
  const unlock = account.method.masterPasswordUnlock?.master_password_unlock ?? {
    salt: EMAIL,
    kdf: { pBKDF2: { iterations: 600_000 } },
    masterKeyWrappedUserKey: ENCRYPTED,
  };
  const registered = await request(server, "POST", "accounts/register/finish", {
    json: {
      email: EMAIL,
      userAsymmetricKeys: { publicKey: "publicKey", encryptedPrivateKey: keys.private_key },
      masterPasswordAuthentication: { masterPasswordAuthenticationHash: passwordHash },
      masterPasswordUnlock: {
        salt: unlock.salt,
        kdf: { kdfType: 0, iterations: unlock.kdf.pBKDF2.iterations },
        masterKeyWrappedUserKey: unlock.masterKeyWrappedUserKey,
      },
    },
  });
  expect(registered.code).toBe(200);

  // The local server gives a new account an ID of its own. The SDK encrypts for the account
  // that it knows, so its vault has to be the one of that ID.
  const [registeredId] = await fileSystem.list([]);
  const vault = JSON.parse(utf8Decode(fileSystem.files.get(`${registeredId}/vault.json`)!));
  vault.sync.profile.id = USER_ID;
  await fileSystem.delete([registeredId]);
  await fileSystem.write([USER_ID, "vault.json"], utf8Encode(JSON.stringify(vault)));

  const login = await logIn(server, passwordHash);
  expect(login.code).toBe(200);
  return JSON.parse(login.body!).access_token;
}

function logIn(server: LocalServer, passwordHash: string): Promise<LocalResponse> {
  return request(server, "POST", "connect/token", {
    form: { grant_type: "password", username: EMAIL, password: passwordHash },
  });
}

function vaultFile(vault: LocalVault): string {
  return utf8Decode(vault.fileSystem.files.get(`${USER_ID}/vault.json`)!);
}

/**
 * What the app hands to the SDK of what the local server syncs: how the account is unlocked and
 * the keys of the account (`DefaultSyncService.runCryptoSyncHandler`).
 */
async function syncedCryptoData(vault: LocalVault): Promise<CryptoSyncData> {
  const response = await request(vault.server, "GET", "sync", { token: vault.token });
  const sync = new SyncResponse(JSON.parse(response.body!));
  return {
    userDecryption: sync.userDecryption?.toSdk(),
    accountCryptographicState: sync.profile.accountKeys?.toWrappedAccountCryptographicState(),
  };
}

/**
 * The local server logs what it has no route for, and what goes wrong in it. The SDK must not
 * ask for anything that ends up there.
 */
function expectNothingLogged(vault: LocalVault | undefined): void {
  expect(vault?.logged.splice(0) ?? []).toEqual([]);
}

/**
 * The Bitwarden SDK itself, as it is installed, talking to the local server through `fetch` the
 * way it does in the extension. The SDK makes requests that the code of the extension does not
 * show, puts them together by itself and is strict about what it gets back, so this is what
 * fails when an update of the SDK changes any of that in a way that the local server does not
 * follow.
 *
 * The items and their attachments go through `DefaultCipherSdkService`, which is how the app has
 * the SDK save them. Apart from moving items to a folder, the app only does that with a feature
 * flag, which the local server does not turn on: these tests tell whether it could.
 */
describe("the Bitwarden SDK on a local vault", () => {
  let vault: LocalVault;

  beforeAll(async () => {
    vault = await start(V1);
  }, 60_000);

  afterEach(() => expectNothingLogged(vault));

  afterAll(() => vault?.stop());

  async function save(): Promise<CipherView> {
    const view = new CipherView();
    view.type = CipherType.Login;
    view.name = NAME;
    view.notes = NOTES;
    view.login.username = USERNAME;
    view.login.password = PASSWORD;
    return (await vault.cipherSdkService.createWithServer(view, USER_ID))!;
  }

  function stored(cipherId: string): any {
    const ciphers: any[] = JSON.parse(vaultFile(vault)).sync.ciphers;
    return ciphers.find((cipher) => cipher.id === cipherId);
  }

  it("reaches the local server through fetch", async () => {
    const config = JSON.parse(await vault.sdk.http_get(`${LOCAL_VAULT_URLS.base}/api/config`));

    expect(config.object).toBe("config");
    expect(config.featureStates).toEqual({});
  });

  it("is told how the master key of an account is derived", async () => {
    const prelogin = await vault.sdk.auth().login().get_password_prelogin(EMAIL);

    expect(prelogin).toEqual({ kdf: { pBKDF2: { iterations: 600_000 } }, salt: EMAIL });
  });

  it("saves an item that only the client can read", async () => {
    const created = await save();

    expect(created.id).toBeTruthy();
    expect(created.name).toBe(NAME);
    expect(created.notes).toBe(NOTES);
    expect(created.login.username).toBe(USERNAME);
    expect(created.login.password).toBe(PASSWORD);
    // What is in the vault folder is what the SDK encrypted.
    expect(stored(created.id).name).toMatch(/^2\./);
    for (const secret of [NAME, NOTES, USERNAME, PASSWORD]) {
      expect(vaultFile(vault)).not.toContain(secret);
    }
  });

  it("changes an item that it saved", async () => {
    const created = await save();
    created.name = "Another name for the item";
    created.favorite = true;

    const updated = await vault.cipherSdkService.updateWithServer(created, USER_ID);

    expect(updated!.id).toBe(created.id);
    expect(updated!.name).toBe("Another name for the item");
    expect(updated!.login.password).toBe(PASSWORD);
    expect(stored(created.id).favorite).toBe(true);
    expect(vaultFile(vault)).not.toContain("Another name for the item");
  });

  it("moves items to a folder, which the app has it do without a feature flag", async () => {
    const created = await save();
    const folder = await request(vault.server, "POST", "folders", {
      token: vault.token,
      json: { name: ENCRYPTED },
    });
    const folderId: string = JSON.parse(folder.body!).id;

    await vault.cipherSdkService.moveManyWithServer([created.id], folderId, USER_ID);

    expect(stored(created.id).folderId).toBe(folderId);
  });

  it("trashes, restores and deletes an item", async () => {
    const created = await save();

    await vault.cipherSdkService.softDeleteWithServer(created.id, USER_ID);
    expect(stored(created.id).deletedDate).toBeTruthy();

    await vault.cipherSdkService.restoreWithServer(created.id, USER_ID);
    expect(stored(created.id).deletedDate).toBeNull();

    await vault.cipherSdkService.deleteWithServer(created.id, USER_ID);
    expect(stored(created.id)).toBeUndefined();
  });

  /**
   * Has the SDK add an attachment to an item, which the app does when it has the SDK make the
   * requests for attachments: the SDK asks where the content goes, and the app sends it there.
   */
  function attach(cipher: CipherView, size: number): Promise<CreatedAttachment> {
    return vault.cipherSdkService.createAttachment(
      cipher.id as CipherId,
      {
        key: ENCRYPTED as EncString,
        fileName: ENCRYPTED as EncString,
        fileSize: size,
        lastKnownRevisionDate: cipher.revisionDate.toISOString(),
        asAdmin: false,
      },
      USER_ID,
    );
  }

  it("adds an attachment to an item, finds its content and deletes it", async () => {
    const created = await save();
    const cipherId = created.id as CipherId;
    const content = new Uint8Array([1, 2, 3, 250]);

    const attachment = await attach(created, content.length);
    expect(attachment.fileUploadType).toBe("Azure");
    expect(stored(cipherId).attachments.map((a: any) => a.id)).toEqual([attachment.attachmentId]);
    const upload = new Request(attachment.uploadUrl, { method: "PUT", body: content });
    expect((await fetch(upload)).status).toBe(201);

    const url = await vault.cipherSdkService.getAttachmentDownloadUrl(
      cipherId,
      attachment.attachmentId,
      USER_ID,
    );
    const download = await fetch(new Request(url, { cache: "no-store" }));
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(content);

    await vault.cipherSdkService.deleteAttachmentWithServer(
      cipherId,
      attachment.attachmentId,
      USER_ID,
    );
    expect(stored(cipherId).attachments).toBeNull();
    expect((await fetch(new Request(url))).status).toBe(404);
  });

  it("is told again where the content of an attachment goes", async () => {
    const created = await save();
    const attachment = await attach(created, 4);

    const url = await vault.cipherSdkService.renewAttachmentUploadUrl(
      created.id as CipherId,
      attachment.attachmentId,
      USER_ID,
    );

    // The addresses of a local vault do not expire.
    expect(url).toBe(attachment.uploadUrl);
  });

  it("gives an old attachment a key of its own, all by itself", async () => {
    const created = await save();
    const cipherId = created.id as CipherId;
    const content = new Uint8Array([1, 2, 3, 250]);
    // An attachment from before attachments had keys: its content is encrypted with the user
    // key, and its name with the key of the item, like the rest of the item.
    const userKey = Buffer.from(await vault.sdk.crypto().get_user_encryption_key(), "base64");
    const itemKey = PureCrypto.unwrap_symmetric_key(
      (await vault.ciphers.get(cipherId))!.key!,
      userKey,
    );
    const old = JSON.parse(
      (
        await request(vault.server, "POST", `ciphers/${cipherId}/attachment/v2`, {
          token: vault.token,
          json: {
            fileName: PureCrypto.symmetric_encrypt_string("old.txt", itemKey),
            key: null,
            fileSize: content.length,
          },
        })
      ).body!,
    );
    const encrypted = PureCrypto.symmetric_encrypt_filedata(content, userKey);
    await fetch(new Request(old.url, { method: "PUT", body: encrypted as BodyInit }));
    // The app has the item with the attachment from a sync, and the SDK has it from the app.
    const synced = new Cipher(new CipherData(new CipherResponse(old.cipherResponse)));
    await vault.ciphers.set(cipherId, synced.toSdkCipher());

    // The SDK downloads the content, encrypts it with a new key, uploads it as another
    // attachment and deletes the old one. Every request of that is its own.
    const upgraded = await vault.cipherSdkService.upgradeAttachment(
      cipherId,
      old.attachmentId,
      USER_ID,
    );

    const [attachment] = upgraded!.attachments;
    expect(upgraded!.attachments).toHaveLength(1);
    expect(attachment.id).not.toBe(old.attachmentId);
    expect(attachment.fileName).toBe("old.txt");
    expect(stored(cipherId).attachments).toMatchObject([
      { id: attachment.id, key: expect.stringMatching(/^2\./) },
    ]);
    expect((await fetch(new Request(old.url))).status).toBe(404);
    // What is stored now is the same content, which the new key of the attachment decrypts.
    const url = await vault.cipherSdkService.getAttachmentDownloadUrl(
      cipherId,
      attachment.id,
      USER_ID,
    );
    const download = new Uint8Array(await (await fetch(new Request(url))).arrayBuffer());
    const decrypted = vault.sdk
      .vault()
      .attachments()
      .decrypt_buffer(
        (await vault.ciphers.get(cipherId))!,
        attachment.toSdkAttachmentView(),
        download,
      );
    expect([...decrypted]).toEqual([...content]);
  });
});

/**
 * What the SDK does with the state that the app keeps for it, where the app registers that
 * state with the SDK. Both of these are requests that the app has the SDK make without a
 * feature flag, when it finds that an account needs them.
 */
describe("the Bitwarden SDK with the state of the app, on a local vault", () => {
  const started: LocalVault[] = [];

  async function startWithState(account: any, withMasterPassword = false): Promise<LocalVault> {
    const vault = await start(account, { withState: true, withMasterPassword });
    started.push(vault);
    return vault;
  }

  afterEach(() => {
    for (const vault of started.splice(0)) {
      vault.stop();
      expectNothingLogged(vault);
    }
  });

  it("changes how the master key of an account is derived", async () => {
    const vault = await startWithState(V1, true);
    const before = JSON.parse(vaultFile(vault)).sync.userDecryption.masterPasswordUnlock;
    const kdf: Kdf = { pBKDF2: { iterations: 650_000 } };

    await vault.sdk.user_crypto_management().change_kdf(MASTER_PASSWORD, kdf);

    const sync = JSON.parse(vaultFile(vault)).sync;
    const unlock = sync.userDecryption.masterPasswordUnlock;
    expect(unlock.kdf).toEqual({
      kdfType: 0,
      iterations: 650_000,
      memory: null,
      parallelism: null,
    });
    expect(unlock.salt).toBe(before.salt);
    // The user key is the same, and encrypted again with the master key that is derived now.
    expect(unlock.masterKeyEncryptedUserKey).toMatch(/^2\./);
    expect(unlock.masterKeyEncryptedUserKey).not.toBe(before.masterKeyEncryptedUserKey);
    expect(sync.profile.key).toBe(unlock.masterKeyEncryptedUserKey);
    // The master password is known by another hash than before.
    expect((await logIn(vault.server, vault.passwordHash)).code).toBe(400);
    const prelogin = await vault.sdk.auth().login().get_password_prelogin(EMAIL);
    expect(prelogin).toEqual({ kdf, salt: EMAIL });
  }, 60_000);

  it("takes what the local server syncs for the keys of the account", async () => {
    const vault = await startWithState(V1);

    // The SDK may refuse a sync that does not fit the keys that it has.
    await vault.sdk.crypto_sync_handler().on_sync(await syncedCryptoData(vault));

    expect(vault.state.get("account_cryptographic_state")).toEqual(V1.accountCryptographicState);
    expect(vault.state.get("masterpassword_unlock_data")).toEqual(
      V1.method.masterPasswordUnlock.master_password_unlock,
    );
  }, 60_000);

  it("finds the ID of the user key in a sync, which another client had recorded", async () => {
    const vault = await startWithState(V1);
    // What another client of the account did, of which this one knows nothing yet.
    await vault.sdk.user_crypto_management().user_key_id_backfill();
    vault.state.delete("user_key_id");
    expect(await vault.sdk.user_crypto_management().user_key_id_needs_backfill()).toBe(true);

    await vault.sdk.crypto_sync_handler().on_sync(await syncedCryptoData(vault));

    expect(await vault.sdk.user_crypto_management().user_key_id_needs_backfill()).toBe(false);
  }, 60_000);

  it.each([
    ["the keys that an account has had so far", V1],
    ["the keys of the encryption that follows them", V2],
  ])(
    "has the local server record the ID of the user key, with %s",
    async (_, account) => {
      const vault = await startWithState(account);
      expect(await vault.sdk.user_crypto_management().user_key_id_needs_backfill()).toBe(true);

      await vault.sdk.user_crypto_management().user_key_id_backfill();

      // A client finds the ID where it syncs, and the SDK does not ask again.
      const sync = await request(vault.server, "GET", "sync", { token: vault.token });
      const userKeyId: unknown = JSON.parse(sync.body!).userDecryption.userKeyId;
      expect(typeof userKeyId).toBe("string");
      expect(userKeyId).not.toBe("");
      expect(vault.state.has("user_key_id")).toBe(true);
      expect(await vault.sdk.user_crypto_management().user_key_id_needs_backfill()).toBe(false);
    },
    60_000,
  );

  it.each([
    ["the keys that an account has had so far", V1],
    ["the keys of the encryption that follows them", V2],
  ])(
    "saves items with the key that the local server has the ID of, with %s",
    async (_, account) => {
      const vault = await startWithState(account);
      const view = new CipherView();
      view.type = CipherType.Login;
      view.name = NAME;
      await vault.sdk.user_crypto_management().user_key_id_backfill();

      // The SDK says with every item which key it encrypted it with, which is that key.
      const saved = await vault.cipherSdkService.createWithServer(view, USER_ID);
      expect(saved!.name).toBe(NAME);

      // The vault of an account that has another user key: the same item is not taken there.
      const other = JSON.parse(vaultFile(vault));
      other.sync.userDecryption.userKeyId = "00000000000000000000000000000000";
      await vault.fileSystem.write([USER_ID, "vault.json"], utf8Encode(JSON.stringify(other)));
      await expect(vault.cipherSdkService.createWithServer(view, USER_ID)).rejects.toMatchObject({
        message: expect.stringContaining("not encrypted with the user key of this account"),
      });
      expect(JSON.parse(vaultFile(vault)).sync.ciphers).toHaveLength(1);
    },
    60_000,
  );
});
