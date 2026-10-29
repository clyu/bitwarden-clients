/**
 * Runs with the `fetch`, `Request` and `Response` of Node, which jsdom does not have.
 * @jest-environment node
 */
import { pbkdf2Sync } from "node:crypto";

// The rotation of the user key is made by a page of the local vault, which is run here with what
// it injects, as in the popup.
// eslint-disable-next-line no-restricted-imports
import { Injector, runInInjectionContext } from "@angular/core";
import { mock } from "jest-mock-extended";
import { defer, firstValueFrom, map, of } from "rxjs";

import { DefaultChangePasswordService } from "@bitwarden/angular/auth/password-management/change-password/default-change-password.service";
import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { PolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { MasterPasswordApiService } from "@bitwarden/common/auth/abstractions/master-password-api.service.abstraction";
import { IdentityTokenResponse } from "@bitwarden/common/auth/models/response/identity-token.response";
import { OrganizationInviteService } from "@bitwarden/common/auth/organization-invite";
import { PasswordPreloginResponse } from "@bitwarden/common/auth/password-prelogin/password-prelogin.response";
import { DeviceType } from "@bitwarden/common/enums";
import { MasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/abstractions/master-password-unlock.service";
import { InternalMasterPasswordServiceAbstraction } from "@bitwarden/common/key-management/master-password/abstractions/master-password.service.abstraction";
import { DefaultMasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/services/default-master-password-unlock.service";
import { MasterPasswordService } from "@bitwarden/common/key-management/master-password/services/master-password.service";
import { MasterPasswordSalt } from "@bitwarden/common/key-management/master-password/types/master-password.types";
import { JsWasmStateBridge } from "@bitwarden/common/key-management/state-bridge";
import {
  ACCOUNT_CRYPTOGRAPHIC_STATE,
  USER_KEY,
} from "@bitwarden/common/key-management/state-definitions";
import { ErrorResponse } from "@bitwarden/common/models/response/error.response";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { SdkLoadService } from "@bitwarden/common/platform/abstractions/sdk/sdk-load.service";
import { asUuid, SdkService } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { compareValues } from "@bitwarden/common/platform/misc/compare-values";
import { Rc } from "@bitwarden/common/platform/misc/reference-counting/rc";
import { SyncService } from "@bitwarden/common/platform/sync";
import { SyncResponse } from "@bitwarden/common/platform/sync/sync.response";
import { FakeStateProvider, mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { UserKey } from "@bitwarden/common/types/key";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { FolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { CipherType } from "@bitwarden/common/vault/enums";
import { CipherData } from "@bitwarden/common/vault/models/data/cipher.data";
import { FolderData } from "@bitwarden/common/vault/models/data/folder.data";
import { Cipher } from "@bitwarden/common/vault/models/domain/cipher";
import { Folder } from "@bitwarden/common/vault/models/domain/folder";
import { CipherRequest } from "@bitwarden/common/vault/models/request/cipher.request";
import { FolderRequest } from "@bitwarden/common/vault/models/request/folder.request";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FolderView } from "@bitwarden/common/vault/models/view/folder.view";
import { CipherService as DefaultCipherService } from "@bitwarden/common/vault/services/cipher.service";
import { DefaultCipherEncryptionService } from "@bitwarden/common/vault/services/default-cipher-encryption.service";
import { FolderService as DefaultFolderService } from "@bitwarden/common/vault/services/folder/folder.service";
import { DefaultKdfConfigService, KeyService } from "@bitwarden/key-management";
// The services of the app derive the master key, and rotate the user key, with these, as they do
// in the app.
// eslint-disable-next-line no-restricted-imports
import {
  CryptoFunctionService,
  DefaultKeyGenerationService,
  EncryptService,
  EncryptServiceImplementation,
  fromSdkKdfConfig,
  KdfConfig,
} from "@bitwarden/legacy-crypto";
// eslint-disable-next-line no-restricted-imports
import { NodeCryptoFunctionService } from "@bitwarden/legacy-crypto/node";
import {
  EncString,
  Kdf,
  ManagedSettingsClient,
  MasterPasswordAuthenticationData,
  MasterPasswordUnlockData,
  PasswordManagerClient,
  PureCrypto,
  WrappedAccountCryptographicState,
} from "@bitwarden/sdk-internal";

// An account that the SDK can unlock, with its keys: the one that upstream tests the SDK with.
// eslint-disable-next-line no-restricted-imports
import { accountEncryptedV1 } from "../../../../../libs/importer/src/importers/spec-data/bitwarden-json/account-encrypted-v1.json";
// eslint-disable-next-line no-restricted-imports
import {
  isRefusedForAChangedVault,
  LocalVaultUserKeyRotationService,
} from "../popup/local-vault-user-key-rotation.service";
import { InMemoryLocalVaultFileSystem } from "../server/in-memory-local-vault-file-system";
import { LocalResponse } from "../server/local-request";
import { LocalServer } from "../server/local-server";
import { localVaultRequest, LocalVaultRequestOptions } from "../server/local-vault-request";

import { base64Decode, utf8Decode, utf8Encode } from "./encoding";
import { installLocalFetch } from "./local-fetch";
import { LOCAL_VAULT_URLS } from "./local-vault-environment";

const V1: any = accountEncryptedV1.account;
const USER_ID: UserId = V1.userId;
const EMAIL: string = V1.email;
// The master password of the account, from which PBKDF2-SHA256 derives the master key that its
// user key is encrypted with.
const MASTER_PASSWORD: string = V1.method.masterPasswordUnlock.password;
const PBKDF2: Kdf = V1.kdfParams;
const NEW_MASTER_PASSWORD = "the master password after the change";
// Argon2id with the least work that the encryption key settings of the extension and of the app
// take, which keeps the tests fast.
const ARGON2ID: Kdf = { argon2id: { iterations: 2, memory: 16, parallelism: 1 } };

/** An item of the account in a folder, with an attachment, which a rotation encrypts again. */
interface TestItem {
  name: string;
  username: string;
  folderName: string;
  attachmentName: string;
  attachmentContent: Uint8Array;
}

/** An item with a key of its own, as the SDK makes one. */
const ITEM: TestItem = {
  name: "an item",
  username: "the username",
  folderName: "a folder",
  attachmentName: "an attachment.txt",
  attachmentContent: new Uint8Array([1, 2, 3, 250]),
};

/** An item from before items had keys of their own, which the user key itself encrypts. */
const ITEM_WITHOUT_KEY: TestItem = {
  name: "an older item",
  username: "an older username",
  folderName: "an older folder",
  attachmentName: "an older attachment.txt",
  attachmentContent: new Uint8Array([4, 5, 6]),
};

// What an SDK that makes no requests is given for the access token of the account.
const NO_ACCESS_TOKEN = { get_access_token: async (): Promise<string | undefined> => undefined };

const SDK_SETTINGS = {
  apiUrl: `${LOCAL_VAULT_URLS.base}/api`,
  identityUrl: `${LOCAL_VAULT_URLS.base}/identity`,
  userAgent: "local-vault",
};

/**
 * Has the services of the app take the SDK to be loaded, as the extension has them once it loaded
 * it, which Jest did already.
 */
class LoadedSdkService extends SdkLoadService {
  protected override load(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A device that shares the vault folder: its copy of the folder, and the local server of its
 * client on that copy, which writes to the directory of the device in it.
 */
interface Device {
  id: string;
  fileSystem: InMemoryLocalVaultFileSystem;
  server: LocalServer;
  /** What the local server logged: what it has no route for, and what went wrong in it. */
  logged: string[];
}

function newDevice(id: string): Device {
  const fileSystem = new InMemoryLocalVaultFileSystem();
  const logged: string[] = [];
  const server = new LocalServer(
    fileSystem,
    id,
    { name: "chrome", type: DeviceType.ChromeExtension },
    () => new Date(),
    (_, message) => logged.push(message),
  );
  return { id, fileSystem, server, logged };
}

/**
 * Brings what one device wrote to the copy of the vault folder of another, as a tool that syncs
 * the folder does. The directory of the other device is left as it is, as only it writes there.
 */
function syncFolder(from: Device, to: Device): void {
  for (const [path, content] of from.fileSystem.files) {
    const [, directory, deviceId] = path.split("/");
    if (directory !== "devices" || deviceId !== to.id) {
      to.fileSystem.files.set(path, content.slice());
    }
  }
}

function request(
  device: Device,
  method: string,
  path: string,
  options: LocalVaultRequestOptions = {},
): Promise<LocalResponse> {
  return device.server.handle(localVaultRequest(method, path, options));
}

function bodyOf(response: LocalResponse): any {
  return JSON.parse(response.body!);
}

/**
 * The hash that a server knows a master password by, as the SDK derives it (`hash_password` with
 * `HashPurpose::ServerAuthorization`): of the master key that the settings derive from the master
 * password and the salt, with one round of PBKDF2-SHA256 that the master password is the salt of.
 */
function serverPasswordHash(salt: string, password: string, kdf: Kdf): string {
  const masterKey = PureCrypto.derive_kdf_material(
    utf8Encode(password),
    utf8Encode(salt.trim().toLowerCase()),
    kdf,
  );
  return pbkdf2Sync(masterKey, utf8Encode(password), 1, 32, "sha256").toString("base64");
}

/**
 * Registers the account on the device, with its master password and PBKDF2-SHA256, under the ID
 * that the SDK encrypts for: the local server gives a new account an ID of its own.
 */
async function register(device: Device): Promise<void> {
  const unlock = V1.method.masterPasswordUnlock.master_password_unlock;
  const registered = await request(device, "POST", "accounts/register/finish", {
    json: {
      email: EMAIL,
      userAsymmetricKeys: {
        publicKey: publicKeyOfAccount(),
        encryptedPrivateKey: V1.accountCryptographicState.V1.private_key,
      },
      masterPasswordAuthentication: {
        masterPasswordAuthenticationHash: serverPasswordHash(unlock.salt, MASTER_PASSWORD, PBKDF2),
      },
      masterPasswordUnlock: {
        salt: unlock.salt,
        kdf: toKdfJson(PBKDF2),
        masterKeyWrappedUserKey: unlock.masterKeyWrappedUserKey,
      },
    },
  });
  expect(registered.code).toBe(200);

  const [registeredId] = await device.fileSystem.list([]);
  for (const [path, content] of [...device.fileSystem.files]) {
    device.fileSystem.files.delete(path);
    device.fileSystem.files.set(USER_ID + path.substring(registeredId.length), content);
  }
  const vaultFile = `${USER_ID}/devices/${device.id}/vault.json`;
  const vault = JSON.parse(utf8Decode(device.fileSystem.files.get(vaultFile)!));
  vault.sync.profile.id = USER_ID;
  device.fileSystem.files.set(vaultFile, utf8Encode(JSON.stringify(vault)));
}

/**
 * The public key of the account: that of its private key, which the user key that the master
 * password unlocks decrypts. The local vault refuses a rotation of the user key that would change
 * it.
 */
function publicKeyOfAccount(): string {
  const unlock = V1.method.masterPasswordUnlock.master_password_unlock;
  const userKey = PureCrypto.decrypt_user_key_with_master_password(
    unlock.masterKeyWrappedUserKey,
    MASTER_PASSWORD,
    unlock.salt,
    PBKDF2,
  );
  const privateKey = PureCrypto.unwrap_decapsulation_key(
    V1.accountCryptographicState.V1.private_key,
    userKey,
  );
  return Buffer.from(PureCrypto.rsa_extract_public_key(privateKey)).toString("base64");
}

/** The private key of the account, as the file of the device has it: encrypted with the user key. */
function wrappedPrivateKeyIn(device: Device): string {
  const file = device.fileSystem.files.get(`${USER_ID}/devices/${device.id}/vault.json`)!;
  return JSON.parse(utf8Decode(file)).sync.profile.privateKey;
}

/** `KdfJson` of the Android app: the settings in its requests, and in the vault. */
interface KdfJson {
  kdfType: number;
  iterations: number;
  memory: number | null;
  parallelism: number | null;
}

/** `MasterPasswordUnlockDataJson` of the Android app. */
interface MasterPasswordUnlockJson {
  salt: string;
  kdf: KdfJson;
  masterKeyWrappedUserKey: string;
}

/** `KdfJson.toKdf` of the Android app. */
function toKdf(kdf: KdfJson): Kdf {
  return kdf.kdfType === 1
    ? {
        argon2id: {
          iterations: kdf.iterations,
          memory: kdf.memory!,
          parallelism: kdf.parallelism!,
        },
      }
    : { pBKDF2: { iterations: kdf.iterations } };
}

/** `Kdf.toKdfRequestModel` of the Android app. */
function toKdfJson(kdf: Kdf): KdfJson {
  return "argon2id" in kdf
    ? {
        kdfType: 1,
        iterations: kdf.argon2id.iterations,
        memory: kdf.argon2id.memory,
        parallelism: kdf.argon2id.parallelism,
      }
    : { kdfType: 0, iterations: kdf.pBKDF2.iterations, memory: null, parallelism: null };
}

/**
 * Reads how the account is unlocked, as the Android app reads it from a login or a sync: the user
 * key is `masterKeyEncryptedUserKey` there.
 */
function toMasterPasswordUnlockJson(unlock: any): MasterPasswordUnlockJson {
  return {
    salt: unlock.salt,
    kdf: {
      kdfType: unlock.kdf.kdfType,
      iterations: unlock.kdf.iterations,
      memory: unlock.kdf.memory ?? null,
      parallelism: unlock.kdf.parallelism ?? null,
    },
    masterKeyWrappedUserKey: unlock.masterKeyWrappedUserKey ?? unlock.masterKeyEncryptedUserKey,
  };
}

/** `MasterPasswordAuthenticationDataJson` of the Android app, from what the SDK made. */
function toAuthenticationDataJson(data: MasterPasswordAuthenticationData) {
  return {
    Kdf: toKdfJson(data.kdf),
    MasterPasswordAuthenticationHash: data.masterPasswordAuthenticationHash,
    Salt: data.salt,
  };
}

/** `MasterPasswordUnlockDataJson` of the Android app, from what the SDK made. */
function toUnlockDataJson(
  data: MasterPasswordUnlockData,
): MasterPasswordUnlockJson & { containedKeyId: string | null } {
  return {
    salt: data.salt,
    kdf: toKdfJson(data.kdf),
    masterKeyWrappedUserKey: data.masterKeyWrappedUserKey,
    containedKeyId: data.containedKeyId ?? null,
  };
}

/** A client on which the account is logged in. */
interface Client {
  /** The user key of the account, from the SDK of the vault that is unlocked. */
  userKey(): Promise<string>;
  /** Locks the vault, and returns `true` if the master password unlocks it again. */
  lockAndUnlock(password: string): Promise<boolean>;
}

/**
 * The Android app, as far as it logs in, syncs and changes the KDF settings and the master
 * password: with the calls of the app to its SDK, and its requests in the form in which the app
 * sends them. The SDK of the extension stands in for that of the app, which is the same Rust code
 * built for Android, and whose requests never reach the local vault.
 */
class AndroidApp implements Client {
  /** The SDK, once the vault is unlocked. */
  private sdk: PasswordManagerClient | null = null;
  /** The security stamp of the profile, which the first sync after the login sets. */
  private stamp: string | null = null;
  private loggedIn = true;

  private constructor(
    readonly device: Device,
    private readonly token: string,
    private readonly accountCryptographicState: WrappedAccountCryptographicState,
    /** How the profile of the account says that it is unlocked (`masterPasswordUnlock`). */
    private masterPasswordUnlock: MasterPasswordUnlockJson,
  ) {}

  /**
   * Logs in with the master password (`AuthRepositoryImpl.login`), unlocks the vault with it, and
   * syncs, as the app does. Returns `null` if the master password does not log in or unlock.
   */
  static async logIn(device: Device, password: string): Promise<AndroidApp | null> {
    const prelogin = bodyOf(
      await request(device, "POST", "accounts/prelogin", { json: { email: EMAIL } }),
    );
    const kdf = toKdf({
      kdfType: prelogin.kdf,
      iterations: prelogin.kdfIterations,
      memory: prelogin.kdfMemory,
      parallelism: prelogin.kdfParallelism,
    });
    const login = await request(device, "POST", "connect/token", {
      form: {
        scope: "api offline_access",
        client_id: "mobile",
        username: EMAIL,
        password: serverPasswordHash(EMAIL, password, kdf),
        deviceIdentifier: device.id,
        deviceName: "android",
        deviceType: "0",
        grant_type: "password",
        deeplinkScheme: "bitwarden",
      },
    });
    if (login.code !== 200) {
      return null;
    }
    const body = bodyOf(login);
    const app = new AndroidApp(
      device,
      body.access_token,
      { V1: { private_key: body.PrivateKey } },
      toMasterPasswordUnlockJson(body.UserDecryptionOptions.masterPasswordUnlock),
    );
    if (!(await app.unlock(password))) {
      return null;
    }
    await app.sync();
    return app;
  }

  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  /** The settings that the profile has for the account. */
  get kdf(): Kdf {
    return toKdf(this.masterPasswordUnlock.kdf);
  }

  /**
   * The settings that the SDK derives a master key with: those that it was unlocked with, which
   * `make_update_kdf` derives the hash of the master password from before a change with, whatever
   * it is given.
   */
  async sdkKdf(): Promise<Kdf> {
    const update = await this.sdk!.crypto().make_update_kdf(NEW_MASTER_PASSWORD, ARGON2ID);
    return update.oldMasterPasswordAuthenticationData.kdf;
  }

  async userKey(): Promise<string> {
    return await this.sdk!.crypto().get_user_encryption_key();
  }

  async lockAndUnlock(password: string): Promise<boolean> {
    this.sdk?.free();
    this.sdk = null;
    return await this.unlock(password);
  }

  /**
   * Syncs (`VaultSyncManagerImpl`): the account is logged out if its security stamp changed, and
   * the profile takes how the account is unlocked (`toUpdatedUserStateJson`). The SDK keeps the
   * settings that the vault was unlocked with.
   */
  async sync(): Promise<void> {
    const response = await request(this.device, "GET", "sync", { token: this.token });
    // The token from before a rotation of the user key is refused, and so is the refresh token
    // that the app then asks for another one with, which logs the account out (`AuthTokenManager`).
    if (response.code === 401) {
      this.logOut();
      return;
    }
    const sync = bodyOf(response);
    if (this.stamp != null && sync.profile.securityStamp !== this.stamp) {
      this.logOut();
      return;
    }
    this.stamp = sync.profile.securityStamp;
    this.masterPasswordUnlock = toMasterPasswordUnlockJson(
      sync.userDecryption.masterPasswordUnlock,
    );
  }

  /**
   * Changes the KDF settings (`KdfSettingsManagerImpl.changeKdf`), and returns the status of the
   * answer of the local vault.
   */
  async changeKdf(password: string, kdf: Kdf): Promise<number> {
    const unlock = this.masterPasswordUnlock;
    const masterPasswordHash = serverPasswordHash(unlock.salt, password, toKdf(unlock.kdf));
    const update = await this.sdk!.crypto().make_update_kdf(password, kdf);
    const authentication = update.masterPasswordAuthenticationData;
    const response = await request(this.device, "POST", "accounts/kdf", {
      token: this.token,
      json: {
        authenticationData: toAuthenticationDataJson(authentication),
        key: update.masterPasswordUnlockData.masterKeyWrappedUserKey,
        masterPasswordHash,
        newMasterPasswordHash: authentication.masterPasswordAuthenticationHash,
        unlockData: toUnlockDataJson(update.masterPasswordUnlockData),
      },
    });
    if (response.code === 200) {
      // What the profile takes of the new settings (`updateKdf`, `updateMasterPasswordUnlock`).
      this.masterPasswordUnlock = toUnlockDataJson(update.masterPasswordUnlockData);
    }
    return response.code;
  }

  /**
   * Changes the master password (`MasterPasswordManagerImpl.changeMasterPassword`): the current
   * one is proven, and the new master key derived, with the settings of the profile. Returns the
   * status of the answer of the local vault.
   */
  async changeMasterPassword(password: string, newPassword: string): Promise<number> {
    const unlock = this.masterPasswordUnlock;
    const kdf = toKdf(unlock.kdf);
    const update = await this.sdk!.crypto().make_update_kdf(newPassword, kdf);
    return await this.sendNewMasterPassword({
      masterPasswordHash: serverPasswordHash(unlock.salt, password, kdf),
      masterPasswordHint: null,
      authenticationData: toAuthenticationDataJson(update.masterPasswordAuthenticationData),
      unlockData: toUnlockDataJson(update.masterPasswordUnlockData),
    });
  }

  /**
   * Changes the master password the way that the password reset of upstream does it
   * (`AuthRepositoryImpl.resetPassword`): the current one is proven with the settings of the
   * profile, which the request says that the new master key is derived with as well, but the SDK
   * derives it with its own (`make_update_password`). Returns the status of the answer of the
   * local vault.
   */
  async resetPassword(password: string, newPassword: string): Promise<number> {
    const unlock = this.masterPasswordUnlock;
    const update = await this.makeUpdatePassword(newPassword);
    return await this.sendNewMasterPassword({
      masterPasswordHash: serverPasswordHash(unlock.salt, password, toKdf(unlock.kdf)),
      masterPasswordHint: null,
      authenticationData: {
        Kdf: unlock.kdf,
        MasterPasswordAuthenticationHash: update.passwordHash,
        Salt: unlock.salt,
      },
      unlockData: {
        salt: unlock.salt,
        kdf: unlock.kdf,
        masterKeyWrappedUserKey: update.newKey,
        containedKeyId: null,
      },
    });
  }

  /**
   * What `make_update_password` of the SDK of the app gives, which the SDK of the extension does
   * not have: the hash of the new master password, and the user key encrypted with its master
   * key, which both derive from the email and the settings of the SDK (`MasterKey::derive`).
   */
  private async makeUpdatePassword(
    newPassword: string,
  ): Promise<{ passwordHash: string; newKey: string }> {
    const kdf = await this.sdkKdf();
    const userKey = base64Decode(await this.userKey())!;
    return {
      passwordHash: serverPasswordHash(EMAIL, newPassword, kdf),
      newKey: PureCrypto.encrypt_user_key_with_master_password(userKey, newPassword, EMAIL, kdf),
    };
  }

  /**
   * Sends a new master password (`POST accounts/password`), and logs the account out once the
   * local vault took it, as the app does.
   */
  private async sendNewMasterPassword(body: unknown): Promise<number> {
    const response = await request(this.device, "POST", "accounts/password", {
      token: this.token,
      json: body,
    });
    if (response.code === 200) {
      this.logOut();
    }
    return response.code;
  }

  /**
   * Unlocks the vault with the master password
   * (`VaultRepositoryImpl.unlockVaultWithMasterPassword`): the SDK is initialized with the settings
   * and the unlock data of the profile, and keeps the settings until the vault is locked.
   */
  private async unlock(password: string): Promise<boolean> {
    const unlock = this.masterPasswordUnlock;
    const kdf = toKdf(unlock.kdf);
    const sdk = new PasswordManagerClient(
      NO_ACCESS_TOKEN,
      SDK_SETTINGS,
      new ManagedSettingsClient(),
    );
    try {
      await sdk.crypto().initialize_user_crypto({
        userId: asUuid(USER_ID),
        email: EMAIL,
        kdfParams: kdf,
        accountCryptographicState: this.accountCryptographicState,
        method: {
          masterPasswordUnlock: {
            password,
            master_password_unlock: {
              salt: unlock.salt,
              kdf,
              masterKeyWrappedUserKey: unlock.masterKeyWrappedUserKey as EncString,
            },
          },
        },
      });
    } catch {
      sdk.free();
      return false;
    }
    this.sdk = sdk;
    return true;
  }

  private logOut(): void {
    this.sdk?.free();
    this.sdk = null;
    this.loggedIn = false;
  }
}

/**
 * The browser extension, as far as it logs in, syncs and changes the KDF settings and the master
 * password: with its own services, on state that they share with the SDK as in the extension
 * (`JsWasmStateBridge`), and with an SDK that is created again whenever the settings in that
 * state change, as `DefaultSdkService` creates it.
 */
class Extension implements Client {
  /** The SDK, once the vault is unlocked. */
  private sdk: PasswordManagerClient | null = null;
  /** The settings that the SDK was created with. */
  private sdkKdfConfig: KdfConfig | null = null;
  private stamp: string | null = null;
  private loggedIn = true;
  private readonly masterPasswordUnlockService: DefaultMasterPasswordUnlockService;
  private readonly changePasswordService: DefaultChangePasswordService;
  private readonly userKeyRotationService: LocalVaultUserKeyRotationService;
  private readonly encryptService: EncryptService;
  private readonly cipherEncryptionService: DefaultCipherEncryptionService;
  /** The items and the folders of the last sync, which the state of the extension has. */
  private ciphers: Cipher[] = [];
  private folders: Folder[] = [];
  /** What happens between the sync of a rotation and its request, if anything. */
  private beforeRotationIsSent: (() => Promise<unknown>) | null = null;

  private constructor(
    readonly device: Device,
    private readonly token: string,
    private readonly stateProvider: FakeStateProvider,
    private readonly kdfConfigService: DefaultKdfConfigService,
    private readonly masterPasswordService: MasterPasswordService,
  ) {
    this.masterPasswordUnlockService = new DefaultMasterPasswordUnlockService(
      masterPasswordService,
      mock<LogService>(),
    );
    const keyService = mock<KeyService>();
    keyService.userKey$.mockImplementation((userId) =>
      stateProvider.getUserState$(USER_KEY, userId),
    );
    // What `MasterPasswordApiService.postPassword` does through `ApiService`, as
    // `local-service-client` runs it against the local server: it sends the request in JSON with
    // the token of the account, and fails with the error of the answer if it is refused.
    const masterPasswordApiService = mock<MasterPasswordApiService>();
    masterPasswordApiService.postPassword.mockImplementation(async (passwordRequest) => {
      const response = await request(device, "POST", "accounts/password", {
        token,
        json: passwordRequest,
      });
      if (response.code !== 200) {
        throw new ErrorResponse(bodyOf(response), response.code);
      }
    });
    // The extension has a subclass of it (`ExtensionChangePasswordService`), which changes the
    // master password as it does.
    this.changePasswordService = new DefaultChangePasswordService(
      keyService,
      masterPasswordApiService,
      masterPasswordService,
      this.masterPasswordUnlockService,
      mock<PolicyService>(),
      mock<OrganizationInviteService>(),
    );
    // What the rotation of the user key needs besides: the private key in the state, the sync of
    // the page, what `ApiService.send` does, and the items and folders in the state, which the
    // services of upstream encrypt again with the new key.
    keyService.userEncryptedPrivateKey$.mockImplementation((userId) =>
      stateProvider
        .getUserState$(ACCOUNT_CRYPTOGRAPHIC_STATE, userId)
        .pipe(map((state) => (state != null && "V1" in state ? state.V1.private_key : null))),
    );
    const syncService = mock<SyncService>();
    syncService.fullSync.mockImplementation(async () => {
      await this.sync();
      return true;
    });
    const apiService = mock<ApiService>();
    apiService.send.mockImplementation(async (method, path, body) => {
      await this.beforeRotationIsSent?.();
      const response = await request(device, method, path.substring(1), { token, json: body });
      if (response.code !== 200) {
        throw new ErrorResponse(bodyOf(response), response.code);
      }
    });
    const cryptoFunctionService = new NodeCryptoFunctionService();
    this.encryptService = new EncryptServiceImplementation(
      cryptoFunctionService,
      mock<LogService>(),
      false,
    );
    // The SDK of the vault that is unlocked, as `DefaultSdkService` hands it out.
    const sdkService = mock<SdkService>();
    sdkService.userClient$.mockImplementation(() => of(new Rc(this.sdk!)));
    this.cipherEncryptionService = new DefaultCipherEncryptionService(
      sdkService,
      mock<LogService>(),
    );
    // `getRotatedData` of the services of upstream, which encrypts with the SDK, on what they
    // take from the state: the items that the SDK decrypts, and the folders that the user key
    // decrypts. What they send is thus what the extension sends to the local vault.
    const cipherService = mock<CipherService>();
    cipherService.failedToDecryptCiphers$.mockImplementation(() =>
      defer(async () => (await this.decryptCiphers())[1]),
    );
    cipherService.getRotatedData.mockImplementation((originalUserKey, newUserKey, userId) =>
      DefaultCipherService.prototype.getRotatedData.call(
        {
          cipherViews$: () => defer(async () => (await this.decryptCiphers())[0]),
          failedToDecryptCiphers$: cipherService.failedToDecryptCiphers$,
          cipherEncryptionService: this.cipherEncryptionService,
        } as unknown as DefaultCipherService,
        originalUserKey,
        newUserKey,
        userId,
      ),
    );
    const folderService = mock<FolderService>();
    folderService.getRotatedData.mockImplementation((originalUserKey, newUserKey, userId) =>
      DefaultFolderService.prototype.getRotatedData.call(
        {
          folderViews$: () => defer(() => this.decryptFolders()),
          encrypt: DefaultFolderService.prototype.encrypt,
          encryptService: this.encryptService,
        } as unknown as DefaultFolderService,
        originalUserKey,
        newUserKey,
        userId,
      ),
    );
    const injector = Injector.create({
      providers: [
        { provide: ApiService, useValue: apiService },
        { provide: CipherService, useValue: cipherService },
        { provide: CryptoFunctionService, useValue: cryptoFunctionService },
        { provide: EncryptService, useValue: this.encryptService },
        { provide: FolderService, useValue: folderService },
        { provide: KeyService, useValue: keyService },
        { provide: InternalMasterPasswordServiceAbstraction, useValue: masterPasswordService },
        { provide: MasterPasswordUnlockService, useValue: this.masterPasswordUnlockService },
        { provide: SyncService, useValue: syncService },
      ],
    });
    this.userKeyRotationService = runInInjectionContext(
      injector,
      () => new LocalVaultUserKeyRotationService(),
    );
  }

  /**
   * Logs in with the master password (`PasswordLoginStrategy`), which leaves the settings and the
   * unlock data of the account in the state of the extension, unlocks the vault with it, and
   * syncs. Returns `null` if the master password does not log in or unlock.
   */
  static async logIn(device: Device, password: string): Promise<Extension | null> {
    const accountService = mockAccountServiceWith(USER_ID, { email: EMAIL });
    const stateProvider = new FakeStateProvider(accountService);
    const cryptoFunctionService = new NodeCryptoFunctionService();
    const kdfConfigService = new DefaultKdfConfigService(stateProvider);
    const masterPasswordService = new MasterPasswordService(
      stateProvider,
      new DefaultKeyGenerationService(cryptoFunctionService),
      cryptoFunctionService,
      accountService,
    );

    const prelogin = new PasswordPreloginResponse(
      bodyOf(
        await request(device, "POST", "accounts/prelogin/password", { json: { email: EMAIL } }),
      ),
    );
    const authentication = await masterPasswordService.makeMasterPasswordAuthenticationData(
      password,
      prelogin.kdfSettings.toKdfConfig(),
      prelogin.salt as MasterPasswordSalt,
    );
    const login = await request(device, "POST", "connect/token", {
      form: {
        grant_type: "password",
        username: EMAIL,
        password: authentication.masterPasswordAuthenticationHash,
        scope: "api offline_access",
        client_id: "browser",
        deviceType: "3",
        deviceIdentifier: device.id,
        deviceName: "firefox",
      },
    });
    if (login.code !== 200) {
      return null;
    }
    const response = new IdentityTokenResponse(bodyOf(login));
    await kdfConfigService.setKdfConfig(USER_ID, response.kdfConfig);
    await masterPasswordService.setMasterPasswordUnlockData(
      response.userDecryptionOptions!.masterPasswordUnlock!.toMasterPasswordUnlockData(),
      USER_ID,
    );
    await stateProvider.setUserState(
      ACCOUNT_CRYPTOGRAPHIC_STATE,
      response.accountKeysResponseModel!.toWrappedAccountCryptographicState(),
      USER_ID,
    );

    const extension = new Extension(
      device,
      response.accessToken,
      stateProvider,
      kdfConfigService,
      masterPasswordService,
    );
    if (!(await extension.unlock(password))) {
      return null;
    }
    await extension.sync();
    return extension;
  }

  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  /** The settings that the state of the extension has for the account. */
  async kdf(): Promise<Kdf> {
    return (await this.kdfConfigService.getKdfConfig(USER_ID)).toSdkConfig();
  }

  async userKey(): Promise<string> {
    return await this.sdk!.crypto().get_user_encryption_key();
  }

  async lockAndUnlock(password: string): Promise<boolean> {
    this.sdk?.free();
    this.sdk = null;
    await this.stateProvider.setUserState(USER_KEY, null, USER_ID);
    return await this.unlock(password);
  }

  /**
   * Syncs (`DefaultSyncService.fullSync`): the SDK takes the keys and the unlock data of the
   * account into the state of the extension first (`runCryptoSyncHandler`), and the account is
   * then logged out if its security stamp changed.
   */
  async sync(): Promise<void> {
    const response = await request(this.device, "GET", "sync", { token: this.token });
    const sync = new SyncResponse(bodyOf(response));
    await this.sdk!.crypto_sync_handler().on_sync({
      userDecryption: sync.userDecryption?.toSdk(),
      accountCryptographicState: sync.profile!.accountKeys?.toWrappedAccountCryptographicState(),
    });
    if (this.stamp != null && sync.profile!.securityStamp !== this.stamp) {
      this.logOut();
      return;
    }
    this.stamp = sync.profile!.securityStamp;
    this.ciphers = sync.ciphers.map((cipher) => new Cipher(new CipherData(cipher)));
    this.folders = sync.folders.map((folder) => new Folder(new FolderData(folder)));
    await this.createSdkIfSettingsChanged();
  }

  /** Adds a folder, as `FolderApiService.save` does, and returns its ID. */
  async addFolder(name: string): Promise<string> {
    const folder = new Folder();
    folder.name = await this.encryptService.encryptString(name, await this.stateUserKey());
    const response = await request(this.device, "POST", "folders", {
      token: this.token,
      json: new FolderRequest(folder),
    });
    return bodyOf(response).id;
  }

  /**
   * Adds the item in a folder of its own, with its attachment. `withItemKey`: as the extension adds
   * it, with a key of its own that the SDK makes (`CipherService.createWithServer`), or else as a
   * client added it before items had keys, encrypted with the user key itself. The key of the
   * item, or else the user key, encrypts the name of the attachment and its key, which encrypts
   * its content (`CipherService.saveAttachmentRawWithServer`). Syncs then, so that the state has
   * them.
   */
  async addItem(item: TestItem, withItemKey: boolean): Promise<void> {
    const folderId = await this.addFolder(item.folderName);
    const userKey = base64Decode(await this.userKey())!;
    const saved = bodyOf(
      await request(this.device, "POST", "ciphers", {
        token: this.token,
        json: withItemKey
          ? await this.encryptedWithItemKey(item, folderId)
          : {
              type: CipherType.Login,
              name: PureCrypto.symmetric_encrypt_string(item.name, userKey),
              folderId,
              login: { username: PureCrypto.symmetric_encrypt_string(item.username, userKey) },
              encryptedFor: USER_ID,
            },
      }),
    );
    expect(saved.key != null).toBe(withItemKey);

    const itemKey = withItemKey ? PureCrypto.unwrap_symmetric_key(saved.key, userKey) : userKey;
    // A key of the kind of the user key, as that of an attachment is.
    const attachmentKey = PureCrypto.make_user_key_aes256_cbc_hmac();
    const content = PureCrypto.symmetric_encrypt_filedata(item.attachmentContent, attachmentKey);
    const upload = bodyOf(
      await request(this.device, "POST", `ciphers/${saved.id}/attachment/v2`, {
        token: this.token,
        json: {
          fileName: PureCrypto.symmetric_encrypt_string(item.attachmentName, itemKey),
          key: PureCrypto.wrap_symmetric_key(attachmentKey, itemKey),
          fileSize: content.length,
        },
      }),
    );
    const uploaded = await fetch(
      new Request(upload.url, { method: "PUT", body: content as BodyInit }),
    );
    expect(uploaded.status).toBe(201);
    await this.sync();
  }

  /** The item in the folder, as the SDK of the extension encrypts it for the local vault. */
  private async encryptedWithItemKey(item: TestItem, folderId: string): Promise<CipherRequest> {
    const view = new CipherView();
    view.type = CipherType.Login;
    view.name = item.name;
    view.folderId = folderId;
    view.login.username = item.username;
    return new CipherRequest((await this.cipherEncryptionService.encrypt(view, USER_ID))!);
  }

  /**
   * The items and folders of the last sync, as the extension decrypts them, and the items that it
   * cannot decrypt.
   */
  async decryptedVault(): Promise<{
    items: CipherView[];
    undecryptable: CipherView[];
    folders: FolderView[];
  }> {
    const [items, undecryptable] = await this.decryptCiphers();
    return { items, undecryptable, folders: await this.decryptFolders() };
  }

  /** The content of the attachment of the item, downloaded and decrypted by the SDK. */
  async attachmentContent(item: CipherView): Promise<Uint8Array> {
    const [attachment] = item.attachments;
    const path = `ciphers/${item.id}/attachment/${attachment.id}`;
    const download = bodyOf(await request(this.device, "GET", path, { token: this.token }));
    const encrypted = new Uint8Array(await (await fetch(new Request(download.url))).arrayBuffer());
    const cipher = this.ciphers.find((cipher) => cipher.id === item.id)!;
    return this.sdk!.vault()
      .attachments()
      .decrypt_buffer(cipher.toSdkCipher(), attachment.toSdkAttachmentView(), encrypted);
  }

  /** The items of the last sync that the SDK decrypts, and those that it cannot decrypt. */
  private decryptCiphers(): Promise<[CipherView[], CipherView[]]> {
    return this.cipherEncryptionService.decryptManyLegacy(this.ciphers, USER_ID);
  }

  /** The folders of the last sync, decrypted with the user key, as `FolderService` does. */
  private async decryptFolders(): Promise<FolderView[]> {
    const userKey = await this.stateUserKey();
    return await Promise.all(
      this.folders.map((folder) => folder.decryptWithKey(userKey, this.encryptService)),
    );
  }

  /** The user key in the state of the extension, once the vault is unlocked. */
  private async stateUserKey(): Promise<UserKey> {
    return (await firstValueFrom(this.stateProvider.getUserState$(USER_KEY, USER_ID)))!;
  }

  /**
   * Changes the KDF settings, as `LocalVaultKdfConfirmationComponent` does once the master
   * password is confirmed. Throws what the SDK throws if the local vault refuses the change.
   */
  async changeKdf(password: string, kdf: Kdf): Promise<void> {
    const kdfConfig = fromSdkKdfConfig(kdf);
    kdfConfig.validateKdfConfigForSetting();
    if (!(await this.masterPasswordUnlockService.proofOfDecryption(password, USER_ID))) {
      throw new Error("Invalid master password");
    }
    await this.sdk!.user_crypto_management().change_kdf(password, kdfConfig.toSdkConfig());
    await this.createSdkIfSettingsChanged();
  }

  /**
   * Changes the master password, as `LocalVaultChangePasswordComponent` does with the form of
   * upstream (`InputPasswordComponent`), which gives `ChangePasswordService` the settings and the
   * salt in the state of the extension, and logs the account out once the local vault took it.
   * Throws what the change throws, such as the `ErrorResponse` of a refusal.
   */
  async changeMasterPassword(password: string, newPassword: string): Promise<void> {
    await this.changePasswordService.changePassword(
      {
        currentPassword: password,
        newPassword,
        newPasswordHint: "",
        kdfConfig: await this.kdfConfigService.getKdfConfig(USER_ID),
        salt: await firstValueFrom(this.masterPasswordService.saltForUser$(USER_ID)),
      },
      USER_ID,
    );
    this.logOut();
  }

  /**
   * Rotates the user key along with the master password, as `LocalVaultChangePasswordComponent`
   * does once the form says so, and logs the account out once the local vault took it. Throws
   * what the rotation throws, such as the `ErrorResponse` of a refusal. `inTheMeantime` happens
   * after the page synced and encrypted everything again, before it sends the rotation.
   */
  async rotateUserKey(
    password: string,
    newPassword: string,
    inTheMeantime?: () => Promise<unknown>,
  ): Promise<void> {
    this.beforeRotationIsSent = inTheMeantime ?? null;
    try {
      await this.userKeyRotationService.rotateUserKey(
        {
          currentPassword: password,
          newPassword,
          newPasswordHint: "",
          kdfConfig: await this.kdfConfigService.getKdfConfig(USER_ID),
          salt: await firstValueFrom(this.masterPasswordService.saltForUser$(USER_ID)),
          rotateUserKey: true,
        },
        USER_ID,
      );
    } finally {
      this.beforeRotationIsSent = null;
    }
    this.logOut();
  }

  /**
   * Unlocks the vault with the master password, as the lock screen does: the user key that the
   * unlock data in the state gives, which the SDK is created with.
   */
  private async unlock(password: string): Promise<boolean> {
    try {
      const userKey = await this.masterPasswordUnlockService.unlockWithMasterPassword(
        password,
        USER_ID,
      );
      await this.stateProvider.setUserState(USER_KEY, userKey, USER_ID);
    } catch {
      return false;
    }
    await this.createSdk();
    return true;
  }

  /**
   * Creates the SDK of the vault that is unlocked, as `DefaultSdkService` does: on the state of
   * the extension, from which it takes the user key, with the settings in that state.
   */
  private async createSdk(): Promise<void> {
    this.sdk?.free();
    const kdfConfig = await this.kdfConfigService.getKdfConfig(USER_ID);
    const accountCryptographicState = await firstValueFrom(
      this.stateProvider.getUserState$(ACCOUNT_CRYPTOGRAPHIC_STATE, USER_ID),
    );
    const sdk = new PasswordManagerClient(
      { get_access_token: async () => this.token },
      SDK_SETTINGS,
      new ManagedSettingsClient(),
    );
    sdk.km_state_bridge().register_bridge_impl(new JsWasmStateBridge(this.stateProvider, USER_ID));
    await sdk.crypto().initialize_user_crypto({
      userId: asUuid(USER_ID),
      email: EMAIL,
      method: { clientManagedState: {} },
      kdfParams: kdfConfig.toSdkConfig(),
      accountCryptographicState: accountCryptographicState!,
    });
    this.sdk = sdk;
    this.sdkKdfConfig = kdfConfig;
  }

  /** Creates the SDK again if the settings in the state changed, as `DefaultSdkService` does. */
  private async createSdkIfSettingsChanged(): Promise<void> {
    const kdfConfig = await this.kdfConfigService.getKdfConfig(USER_ID);
    if (!compareValues<KdfConfig | null>(kdfConfig, this.sdkKdfConfig)) {
      await this.createSdk();
    }
  }

  private logOut(): void {
    this.sdk?.free();
    this.sdk = null;
    this.loggedIn = false;
  }
}

/**
 * Changing the KDF settings and then the master password, without locking the vault in between,
 * on devices that share the vault folder: the extension and the Android app on two devices, or one
 * of them on its own. Once the settings changed, on that device or on another one whose change
 * came with a sync, the SDK of the Android app still derives a master key with the settings that
 * the vault was unlocked with, until the vault is locked. A new master password whose master key
 * the SDK derives with those settings leaves the user key encrypted with a master key that the
 * settings of the account do not derive: no device can log in to the account or unlock it again,
 * and the local vault cannot tell, as it never has a master key. The password reset of upstream
 * does that (`AuthRepositoryImpl.resetPassword`), which is why the Android app does not use it.
 *
 * The SDK and the local vault are those of the extension, and the extension changes the settings
 * and the master password with its own services. The Android app here is what it asks of its SDK
 * and sends to the local vault, which its own tests check that it does
 * (`KdfSettingsManagerTest`, `MasterPasswordManagerTest`).
 */
describe("a master password that is changed after the KDF settings, without locking in between,", () => {
  const nativeFetch = globalThis.fetch;
  /** The user key of the account, which every unlock has to give, before the changes and after. */
  let userKey: string;
  let devices: Device[];
  let initSdk: jest.SpyInstance;

  beforeAll(async () => {
    // The one thing of the SDK that is not as in the extension: it is not initialized to log to
    // the console (`init_sdk`), which would fill the output of the tests with what it does, and
    // with an error for every master password that it does not take. The setup of Jest loaded the
    // SDK for the services of the extension already, so it is replaced where they call it.
    initSdk = jest
      .spyOn(jest.requireActual("@bitwarden/sdk-internal"), "init_sdk")
      .mockImplementation(() => {});
    await new LoadedSdkService().loadAndInit();
    const sdk = new PasswordManagerClient(
      NO_ACCESS_TOKEN,
      SDK_SETTINGS,
      new ManagedSettingsClient(),
    );
    await sdk.crypto().initialize_user_crypto(V1);
    userKey = await sdk.crypto().get_user_encryption_key();
    sdk.free();
  }, 60_000);

  afterAll(() => {
    initSdk.mockRestore();
  });

  beforeEach(() => {
    devices = [];
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
    for (const device of devices) {
      expect(device.logged).toEqual([]);
    }
  });

  function device(id: string): Device {
    const created = newDevice(id);
    devices.push(created);
    return created;
  }

  /**
   * The device of the browser, whose SDK reaches the local server of the device through `fetch`,
   * as in the extension. The SDK of the Android app reaches no local server.
   */
  function createBrowserDevice(): Device {
    const created = device("browser");
    installLocalFetch((localRequest) => created.server.handle(localRequest));
    return created;
  }

  /** The account, registered in the browser, and logged in to there and on the phone. */
  async function browserAndPhone(): Promise<{
    browserDevice: Device;
    phoneDevice: Device;
    browser: Extension;
    phone: AndroidApp;
  }> {
    const browserDevice = createBrowserDevice();
    const phoneDevice = device("phone");
    await register(browserDevice);
    syncFolder(browserDevice, phoneDevice);
    const browser = (await Extension.logIn(browserDevice, MASTER_PASSWORD))!;
    const phone = (await AndroidApp.logIn(phoneDevice, MASTER_PASSWORD))!;
    expect(browser).not.toBeNull();
    expect(phone).not.toBeNull();
    return { browserDevice, phoneDevice, browser, phone };
  }

  /**
   * Checks that the new master password logs in and unlocks the vault after a lock, to the user
   * key of the account, and that the one from before does neither.
   */
  async function expectOnlyNewMasterPassword(
    logIn: (password: string) => Promise<Client | null>,
  ): Promise<void> {
    expect(await logIn(MASTER_PASSWORD)).toBeNull();
    const client = await logIn(NEW_MASTER_PASSWORD);
    expect(client).not.toBeNull();
    expect(await client!.userKey()).toBe(userKey);
    expect(await client!.lockAndUnlock(MASTER_PASSWORD)).toBe(false);
    expect(await client!.lockAndUnlock(NEW_MASTER_PASSWORD)).toBe(true);
    expect(await client!.userKey()).toBe(userKey);
  }

  /** Checks that neither master password logs in anymore: the account is lost. */
  async function expectNoMasterPassword(
    logIn: (password: string) => Promise<Client | null>,
  ): Promise<void> {
    expect(await logIn(MASTER_PASSWORD)).toBeNull();
    expect(await logIn(NEW_MASTER_PASSWORD)).toBeNull();
  }

  it("on the phone, after the browser changed them, unlocks the account on both devices", async () => {
    const { browserDevice, phoneDevice, browser, phone } = await browserAndPhone();

    await browser.changeKdf(MASTER_PASSWORD, ARGON2ID);
    syncFolder(browserDevice, phoneDevice);
    // The screen of the master password syncs first, which brings the settings to the profile,
    // but not to the SDK.
    await phone.sync();
    expect(phone.kdf).toEqual(ARGON2ID);
    expect(await phone.sdkKdf()).toEqual(PBKDF2);
    expect(await phone.changeMasterPassword(MASTER_PASSWORD, NEW_MASTER_PASSWORD)).toBe(200);

    // The phone is logged out, and logged in to with the new master password only.
    expect(phone.isLoggedIn).toBe(false);
    await expectOnlyNewMasterPassword((password) => AndroidApp.logIn(phoneDevice, password));

    // The browser is logged out at its first sync after the change came to it, and logged in to
    // with the new master password only.
    await browser.sync();
    expect(browser.isLoggedIn).toBe(true);
    syncFolder(phoneDevice, browserDevice);
    await browser.sync();
    expect(browser.isLoggedIn).toBe(false);
    await expectOnlyNewMasterPassword((password) => Extension.logIn(browserDevice, password));
  }, 60_000);

  it("on the phone, which was told to try again as the settings came after its screen synced, unlocks the account", async () => {
    const { browserDevice, phoneDevice, browser, phone } = await browserAndPhone();

    await phone.sync();
    await browser.changeKdf(MASTER_PASSWORD, ARGON2ID);
    syncFolder(browserDevice, phoneDevice);

    // The local vault knows the master password by the hash of the new settings, and changes
    // nothing. The screen syncs, and the next attempt is made with the new settings.
    expect(await phone.changeMasterPassword(MASTER_PASSWORD, NEW_MASTER_PASSWORD)).toBe(400);
    expect(phone.isLoggedIn).toBe(true);
    await phone.sync();
    expect(await phone.changeMasterPassword(MASTER_PASSWORD, NEW_MASTER_PASSWORD)).toBe(200);

    await expectOnlyNewMasterPassword((password) => AndroidApp.logIn(phoneDevice, password));
    syncFolder(phoneDevice, browserDevice);
    await browser.sync();
    expect(browser.isLoggedIn).toBe(false);
    await expectOnlyNewMasterPassword((password) => Extension.logIn(browserDevice, password));
  }, 60_000);

  it.each([
    ["after its screen synced", true],
    ["without that sync", false],
  ])(
    "on the phone that changed them, unlocks the account, %s",
    async (_, syncs) => {
      const phoneDevice = device("phone");
      await register(phoneDevice);
      const phone = (await AndroidApp.logIn(phoneDevice, MASTER_PASSWORD))!;

      expect(await phone.changeKdf(MASTER_PASSWORD, ARGON2ID)).toBe(200);
      if (syncs) {
        await phone.sync();
      }
      expect(phone.kdf).toEqual(ARGON2ID);
      expect(await phone.sdkKdf()).toEqual(PBKDF2);
      expect(await phone.changeMasterPassword(MASTER_PASSWORD, NEW_MASTER_PASSWORD)).toBe(200);

      expect(phone.isLoggedIn).toBe(false);
      await expectOnlyNewMasterPassword((password) => AndroidApp.logIn(phoneDevice, password));
    },
    60_000,
  );

  it("in the browser, after the phone changed them, unlocks the account on both devices", async () => {
    const { browserDevice, phoneDevice, browser, phone } = await browserAndPhone();

    expect(await phone.changeKdf(MASTER_PASSWORD, ARGON2ID)).toBe(200);
    syncFolder(phoneDevice, browserDevice);
    // The page of the master password syncs first.
    await browser.sync();
    expect(await browser.kdf()).toEqual(ARGON2ID);
    await browser.changeMasterPassword(MASTER_PASSWORD, NEW_MASTER_PASSWORD);

    expect(browser.isLoggedIn).toBe(false);
    await expectOnlyNewMasterPassword((password) => Extension.logIn(browserDevice, password));
    syncFolder(browserDevice, phoneDevice);
    await phone.sync();
    expect(phone.isLoggedIn).toBe(false);
    await expectOnlyNewMasterPassword((password) => AndroidApp.logIn(phoneDevice, password));
  }, 60_000);

  it("in the browser that changed them, unlocks the account", async () => {
    const browserDevice = createBrowserDevice();
    await register(browserDevice);
    const browser = (await Extension.logIn(browserDevice, MASTER_PASSWORD))!;

    await browser.changeKdf(MASTER_PASSWORD, ARGON2ID);
    // The page of the master password syncs first.
    await browser.sync();
    await browser.changeMasterPassword(MASTER_PASSWORD, NEW_MASTER_PASSWORD);

    expect(browser.isLoggedIn).toBe(false);
    await expectOnlyNewMasterPassword((password) => Extension.logIn(browserDevice, password));
  }, 60_000);

  it("with a rotation of the user key in the browser, unlocks the account to the new key on both devices", async () => {
    const { browserDevice, phoneDevice, browser, phone } = await browserAndPhone();

    await browser.rotateUserKey(MASTER_PASSWORD, NEW_MASTER_PASSWORD);

    expect(browser.isLoggedIn).toBe(false);
    expect(await Extension.logIn(browserDevice, MASTER_PASSWORD)).toBeNull();
    const rotated = (await Extension.logIn(browserDevice, NEW_MASTER_PASSWORD))!;
    expect(rotated).not.toBeNull();
    const newUserKey = await rotated.userKey();
    expect(newUserKey).not.toBe(userKey);
    // The private key of the account, encrypted with the new key. The SDK unlocks a vault whose
    // private key it cannot decrypt all the same.
    const privateKey = PureCrypto.unwrap_decapsulation_key(
      wrappedPrivateKeyIn(browserDevice),
      base64Decode(newUserKey)!,
    );
    const publicKey = Buffer.from(PureCrypto.rsa_extract_public_key(privateKey));
    expect(publicKey.toString("base64")).toBe(publicKeyOfAccount());
    expect(await rotated.lockAndUnlock(NEW_MASTER_PASSWORD)).toBe(true);
    expect(await rotated.userKey()).toBe(newUserKey);

    // The phone, which has the user key before, is logged out once the rotation came to it, and
    // logged in to with the new master password only, to the new key.
    await phone.sync();
    expect(phone.isLoggedIn).toBe(true);
    syncFolder(browserDevice, phoneDevice);
    await phone.sync();
    expect(phone.isLoggedIn).toBe(false);
    expect(await AndroidApp.logIn(phoneDevice, MASTER_PASSWORD)).toBeNull();
    const phoneAfter = (await AndroidApp.logIn(phoneDevice, NEW_MASTER_PASSWORD))!;
    expect(phoneAfter).not.toBeNull();
    expect(await phoneAfter.userKey()).toBe(newUserKey);
    expect(await phoneAfter.lockAndUnlock(NEW_MASTER_PASSWORD)).toBe(true);
  }, 60_000);

  it("with a rotation of the user key in the browser, decrypts every item, folder and attachment with the new key", async () => {
    const browserDevice = createBrowserDevice();
    await register(browserDevice);
    const browser = (await Extension.logIn(browserDevice, MASTER_PASSWORD))!;
    await browser.addItem(ITEM, true);
    await browser.addItem(ITEM_WITHOUT_KEY, false);
    const before = await browser.decryptedVault();
    expect(before.undecryptable).toEqual([]);
    expect(before.items).toHaveLength(2);

    await browser.rotateUserKey(MASTER_PASSWORD, NEW_MASTER_PASSWORD);

    // The extension that is logged in again has the new key only, which decrypts everything that
    // the services of upstream encrypted again, and the local vault took: the key of an item, or
    // else the item itself and the key of its attachment.
    const rotated = (await Extension.logIn(browserDevice, NEW_MASTER_PASSWORD))!;
    expect(await rotated.userKey()).not.toBe(userKey);
    const after = await rotated.decryptedVault();
    expect(after.undecryptable).toEqual([]);
    expect(after.items).toHaveLength(2);
    for (const expected of [ITEM, ITEM_WITHOUT_KEY]) {
      const item = after.items.find((item) => item.name === expected.name)!;
      const itemBefore = before.items.find((item) => item.name === expected.name)!;
      expect(item.id).toBe(itemBefore.id);
      expect(item.folderId).toBe(itemBefore.folderId);
      expect(after.folders.find((folder) => folder.id === item.folderId)?.name).toBe(
        expected.folderName,
      );
      expect(item.login.username).toBe(expected.username);
      expect(item.attachments.map((attachment) => attachment.fileName)).toEqual([
        expected.attachmentName,
      ]);
      expect([...(await rotated.attachmentContent(item))]).toEqual([...expected.attachmentContent]);
    }
  }, 60_000);

  it("with a rotation of the user key in the browser that the vault changed under, is refused until it is tried again after a sync", async () => {
    const browserDevice = createBrowserDevice();
    await register(browserDevice);
    const browser = (await Extension.logIn(browserDevice, MASTER_PASSWORD))!;

    // A folder comes in after the page synced, as from another device, which the rotation that it
    // sends does not have.
    const refused = await browser
      .rotateUserKey(MASTER_PASSWORD, NEW_MASTER_PASSWORD, () =>
        browser.addFolder("a folder from another device"),
      )
      .catch((error: unknown) => error);

    // The page syncs, and asks to try again.
    expect(isRefusedForAChangedVault(refused)).toBe(true);
    expect(browser.isLoggedIn).toBe(true);
    expect(await Extension.logIn(browserDevice, NEW_MASTER_PASSWORD)).toBeNull();
    await browser.sync();
    await browser.rotateUserKey(MASTER_PASSWORD, NEW_MASTER_PASSWORD);
    const rotated = (await Extension.logIn(browserDevice, NEW_MASTER_PASSWORD))!;
    const after = await rotated.decryptedVault();
    expect(after.folders.map((folder) => folder.name)).toEqual(["a folder from another device"]);
  }, 60_000);

  // What the Android app avoids. These fail once its SDK derives the master key of a new master
  // password with the settings of the account, rather than with those that the vault was unlocked
  // with: the app could then use the password reset of upstream again.

  it("with the password reset of upstream on the phone, after the browser changed them, unlocks the account nowhere", async () => {
    const { browserDevice, phoneDevice, browser, phone } = await browserAndPhone();

    await browser.changeKdf(MASTER_PASSWORD, ARGON2ID);
    syncFolder(browserDevice, phoneDevice);
    await phone.sync();
    // The local vault takes it, as the request says that it has the settings of the account.
    expect(await phone.resetPassword(MASTER_PASSWORD, NEW_MASTER_PASSWORD)).toBe(200);

    await expectNoMasterPassword((password) => AndroidApp.logIn(phoneDevice, password));
    syncFolder(phoneDevice, browserDevice);
    await browser.sync();
    expect(browser.isLoggedIn).toBe(false);
    await expectNoMasterPassword((password) => Extension.logIn(browserDevice, password));
  }, 60_000);

  it("with the password reset of upstream on the phone that changed them, unlocks the account nowhere", async () => {
    const phoneDevice = device("phone");
    await register(phoneDevice);
    const phone = (await AndroidApp.logIn(phoneDevice, MASTER_PASSWORD))!;

    expect(await phone.changeKdf(MASTER_PASSWORD, ARGON2ID)).toBe(200);
    await phone.sync();
    expect(await phone.resetPassword(MASTER_PASSWORD, NEW_MASTER_PASSWORD)).toBe(200);

    await expectNoMasterPassword((password) => AndroidApp.logIn(phoneDevice, password));
  }, 60_000);
});
