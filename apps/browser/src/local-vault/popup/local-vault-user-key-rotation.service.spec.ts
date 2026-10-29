import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { of } from "rxjs";

import { InvalidCurrentPasswordError } from "@bitwarden/angular/auth/password-management/change-password";
import { PasswordInputResult } from "@bitwarden/auth/angular";
import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { MasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/abstractions/master-password-unlock.service";
import { InternalMasterPasswordServiceAbstraction } from "@bitwarden/common/key-management/master-password/abstractions/master-password.service.abstraction";
import {
  MasterPasswordAuthenticationData,
  MasterPasswordSalt,
  MasterPasswordUnlockData,
} from "@bitwarden/common/key-management/master-password/types/master-password.types";
import { SyncService } from "@bitwarden/common/platform/sync";
import { UserId } from "@bitwarden/common/types/guid";
import { UserKey } from "@bitwarden/common/types/key";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { FolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { CipherWithIdRequest } from "@bitwarden/common/vault/models/request/cipher-with-id.request";
import { FolderWithIdRequest } from "@bitwarden/common/vault/models/request/folder-with-id.request";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { KeyService } from "@bitwarden/key-management";
// The services of the app rotate the key with these.
// eslint-disable-next-line no-restricted-imports
import {
  Argon2KdfConfig,
  CryptoFunctionService,
  EncryptedString,
  EncryptionType,
  EncryptService,
  EncString,
  KdfConfig,
  PBKDF2KdfConfig,
  SymmetricCryptoKey,
} from "@bitwarden/legacy-crypto";
import { PureCrypto } from "@bitwarden/sdk-internal";

import {
  LocalVaultUserKeyRotationService,
  UndecryptableItemsError,
} from "./local-vault-user-key-rotation.service";

const USER_ID = "user-id" as UserId;
const SALT = "user@example.com" as MasterPasswordSalt;
const PRIVATE_KEY = new Uint8Array([1, 2, 3]);
const WRAPPED_PRIVATE_KEY = "2.aXY=|ZGF0YQ==|bWFj" as EncryptedString;
/** The private key encrypted with the new user key. */
const REWRAPPED_PRIVATE_KEY = "2.bmV3|cHJpdmF0ZQ==|bWFj";

/** What the form of upstream gives once the user chose to rotate the encryption key as well. */
function rotationInput(kdfConfig: KdfConfig = new PBKDF2KdfConfig(600_000)): PasswordInputResult {
  return {
    currentPassword: "the-current-master-password",
    newPassword: "the-new-master-password",
    newPasswordHint: "the hint",
    kdfConfig,
    salt: SALT,
    rotateUserKey: true,
  };
}

/**
 * Rotating the user key of an account of encryption version 1, as the web vault does, with the
 * services of the app standing in for the real ones.
 */
describe("the rotation of the user key", () => {
  let apiService: MockProxy<ApiService>;
  let cipherService: MockProxy<CipherService>;
  let folderService: MockProxy<FolderService>;
  let encryptService: MockProxy<EncryptService>;
  let keyService: MockProxy<KeyService>;
  let masterPasswordService: MockProxy<InternalMasterPasswordServiceAbstraction>;
  let masterPasswordUnlockService: MockProxy<MasterPasswordUnlockService>;
  let syncService: MockProxy<SyncService>;
  let service: LocalVaultUserKeyRotationService;
  const userKey = new SymmetricCryptoKey(new Uint8Array(64).fill(1)) as UserKey;
  // What the services of upstream encrypted again with the new key.
  const ciphers = [{ id: "cipher" } as CipherWithIdRequest];
  const folders = [{ id: "folder" } as FolderWithIdRequest];

  beforeEach(() => {
    jest
      .spyOn(PureCrypto, "make_user_key_aes256_cbc_hmac")
      .mockReturnValue(new Uint8Array(64).fill(2));
    apiService = mock<ApiService>();
    cipherService = mock<CipherService>();
    cipherService.failedToDecryptCiphers$.mockReturnValue(of([]));
    cipherService.getRotatedData.mockResolvedValue(ciphers);
    folderService = mock<FolderService>();
    folderService.getRotatedData.mockResolvedValue(folders);
    const cryptoFunctionService = mock<CryptoFunctionService>();
    cryptoFunctionService.rsaExtractPublicKey.mockResolvedValue(new Uint8Array([4, 5, 6]));
    encryptService = mock<EncryptService>();
    encryptService.unwrapDecapsulationKey.mockResolvedValue(PRIVATE_KEY);
    encryptService.wrapDecapsulationKey.mockResolvedValue(new EncString(REWRAPPED_PRIVATE_KEY));
    keyService = mock<KeyService>();
    keyService.userKey$.mockReturnValue(of(userKey));
    keyService.userEncryptedPrivateKey$.mockReturnValue(of(WRAPPED_PRIVATE_KEY));
    masterPasswordService = mock<InternalMasterPasswordServiceAbstraction>();
    masterPasswordService.makeMasterPasswordAuthenticationData.mockImplementation(
      async (password) =>
        ({
          masterPasswordAuthenticationHash: `hash of ${password}`,
        }) as MasterPasswordAuthenticationData,
    );
    masterPasswordService.makeMasterPasswordUnlockData.mockResolvedValue({
      masterKeyWrappedUserKey: "2.newUserKey",
    } as MasterPasswordUnlockData);
    masterPasswordUnlockService = mock<MasterPasswordUnlockService>();
    masterPasswordUnlockService.proofOfDecryption.mockResolvedValue(true);
    syncService = mock<SyncService>();
    syncService.fullSync.mockResolvedValue(true);

    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: apiService },
        { provide: CipherService, useValue: cipherService },
        { provide: CryptoFunctionService, useValue: cryptoFunctionService },
        { provide: EncryptService, useValue: encryptService },
        { provide: FolderService, useValue: folderService },
        { provide: KeyService, useValue: keyService },
        { provide: InternalMasterPasswordServiceAbstraction, useValue: masterPasswordService },
        { provide: MasterPasswordUnlockService, useValue: masterPasswordUnlockService },
        { provide: SyncService, useValue: syncService },
      ],
    });
    service = TestBed.inject(LocalVaultUserKeyRotationService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sends the new key with the new master password, and what the key encrypts", async () => {
    await service.rotateUserKey(rotationInput(), USER_ID);

    // As the web vault does, so that the rotation has every item and folder of the vault.
    expect(syncService.fullSync).toHaveBeenCalledWith(true);
    expect(syncService.fullSync.mock.invocationCallOrder[0]).toBeLessThan(
      cipherService.getRotatedData.mock.invocationCallOrder[0],
    );
    const newUserKey = cipherService.getRotatedData.mock.calls[0][1];
    expect(newUserKey.toEncoded()).toEqual(new Uint8Array(64).fill(2));
    expect(cipherService.getRotatedData).toHaveBeenCalledWith(userKey, newUserKey, USER_ID);
    expect(folderService.getRotatedData).toHaveBeenCalledWith(userKey, newUserKey, USER_ID);
    expect(encryptService.unwrapDecapsulationKey).toHaveBeenCalledWith(
      new EncString(WRAPPED_PRIVATE_KEY),
      userKey,
    );
    expect(encryptService.wrapDecapsulationKey).toHaveBeenCalledWith(PRIVATE_KEY, newUserKey);
    expect(masterPasswordService.makeMasterPasswordUnlockData).toHaveBeenCalledWith(
      "the-new-master-password",
      new PBKDF2KdfConfig(600_000),
      SALT,
      newUserKey,
    );
    expect(apiService.send).toHaveBeenCalledWith(
      "POST",
      "/accounts/key-management/rotate-user-account-keys",
      {
        oldMasterKeyAuthenticationHash: "hash of the-current-master-password",
        accountUnlockData: {
          masterPasswordUnlockData: {
            kdfType: 0,
            kdfIterations: 600_000,
            kdfMemory: undefined,
            kdfParallelism: undefined,
            email: SALT,
            masterKeyAuthenticationHash: "hash of the-new-master-password",
            masterKeyEncryptedUserKey: "2.newUserKey",
            masterPasswordHint: "the hint",
          },
          emergencyAccessUnlockData: [],
          organizationAccountRecoveryUnlockData: [],
          passkeyUnlockData: [],
          deviceKeyUnlockData: [],
        },
        accountKeys: {
          userKeyEncryptedAccountPrivateKey: REWRAPPED_PRIVATE_KEY,
          accountPublicKey: "BAUG",
          publicKeyEncryptionKeyPair: {
            wrappedPrivateKey: REWRAPPED_PRIVATE_KEY,
            publicKey: "BAUG",
          },
        },
        accountData: { ciphers, folders, sends: [] },
      },
      USER_ID,
      false,
    );
  });

  it("sends how an Argon2id master key is derived", async () => {
    await service.rotateUserKey(rotationInput(new Argon2KdfConfig(3, 64, 4)), USER_ID);

    const rotation = apiService.send.mock.calls[0][2];
    expect(rotation.accountUnlockData.masterPasswordUnlockData).toMatchObject({
      kdfType: 1,
      kdfIterations: 3,
      kdfMemory: 64,
      kdfParallelism: 4,
    });
  });

  it("rotates nothing with a mistyped master password", async () => {
    masterPasswordUnlockService.proofOfDecryption.mockResolvedValue(false);

    await expect(service.rotateUserKey(rotationInput(), USER_ID)).rejects.toThrow(
      InvalidCurrentPasswordError,
    );

    expect(cipherService.getRotatedData).not.toHaveBeenCalled();
    expect(apiService.send).not.toHaveBeenCalled();
  });

  it("rotates nothing while an item cannot be decrypted", async () => {
    cipherService.failedToDecryptCiphers$.mockReturnValue(of([mock<CipherView>()]));

    await expect(service.rotateUserKey(rotationInput(), USER_ID)).rejects.toThrow(
      UndecryptableItemsError,
    );

    expect(cipherService.getRotatedData).not.toHaveBeenCalled();
    expect(apiService.send).not.toHaveBeenCalled();
  });

  it("rotates nothing for a user key of encryption version 2", async () => {
    // Not a mock, which `of` would take for a scheduler, as it has a function `schedule`.
    const coseKey = { inner: () => ({ type: EncryptionType.CoseEncrypt0 }) } as unknown as UserKey;
    keyService.userKey$.mockReturnValue(of(coseKey));

    await expect(service.rotateUserKey(rotationInput(), USER_ID)).rejects.toThrow(
      "Only a user key of encryption version 1 is rotated in a local vault.",
    );

    expect(apiService.send).not.toHaveBeenCalled();
  });
});
