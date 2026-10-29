import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

import { InvalidCurrentPasswordError } from "@bitwarden/angular/auth/password-management/change-password/change-password.service.abstraction";
import { PasswordInputResult } from "@bitwarden/auth/angular";
import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { assertNonNullish, assertTruthy } from "@bitwarden/common/auth/utils";
import { MasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/abstractions/master-password-unlock.service";
import { InternalMasterPasswordServiceAbstraction } from "@bitwarden/common/key-management/master-password/abstractions/master-password.service.abstraction";
import { firstValueFromOrThrow } from "@bitwarden/common/key-management/utils";
import { ErrorResponse } from "@bitwarden/common/models/response/error.response";
import { Utils } from "@bitwarden/common/platform/misc/utils";
import { SyncService } from "@bitwarden/common/platform/sync";
import { UserId } from "@bitwarden/common/types/guid";
import { UserKey } from "@bitwarden/common/types/key";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { FolderService } from "@bitwarden/common/vault/abstractions/folder/folder.service.abstraction";
import { KeyService } from "@bitwarden/key-management";
// The web vault of upstream rotates a user key of encryption version 1 with these.
// eslint-disable-next-line no-restricted-imports
import {
  Argon2KdfConfig,
  CryptoFunctionService,
  EncryptionType,
  EncryptService,
  EncString,
  KdfType,
  SymmetricCryptoKey,
} from "@bitwarden/legacy-crypto";
import { PureCrypto } from "@bitwarden/sdk-internal";

/** Where the web vault of upstream sends a rotation (`UserKeyRotationApiService`). */
const ROTATE_USER_ACCOUNT_KEYS_PATH = "/accounts/key-management/rotate-user-account-keys";

/** What an account of a local vault has none of, and a rotation then has nothing of. */
const NONE: unknown[] = [];

/**
 * The messages of the local server (`local-vault-rs`) for a rotation that the vault changed
 * under since the page synced, on another device or on this one: the rotation leaves out an item
 * or a folder that was added, or has one that was deleted, or an item changed since, or how the
 * master key is derived changed, with which the current master password has another hash. A sync
 * and another attempt get past each of them. Any other refusal, such as one of the keys of
 * encryption version 2, comes again at every attempt.
 */
export const REFUSALS_OF_A_CHANGED_VAULT: readonly string[] = [
  "Some items or folders were not encrypted with the new key. Sync your vault and try again.",
  "The item you are updating is out of date. Sync your vault and try again.",
  "Invalid master password.",
];

/**
 * Returns `true` if the local server refused a rotation because the vault changed since the page
 * synced (see `REFUSALS_OF_A_CHANGED_VAULT`).
 */
export function isRefusedForAChangedVault(error: unknown): boolean {
  return (
    error instanceof ErrorResponse &&
    error.statusCode === 400 &&
    REFUSALS_OF_A_CHANGED_VAULT.includes(error.message)
  );
}

/** Some items cannot be decrypted, which keeps the user key from being rotated. */
export class UndecryptableItemsError extends Error {
  constructor() {
    super("Some items cannot be decrypted.");
  }
}

/**
 * Rotates the user key of the account along with its master password, which upstream does in the
 * web vault only (`UserKeyRotationService` of `apps/web`), which does not exist here. It does what
 * the web vault does for an account of encryption version 1, while `force-upgrade-v2-encryption`
 * is off, which the local server does not report: it keeps the account at that version, as the
 * Android app and the extensions on other devices are, and the local vault does not take the keys
 * of version 2.
 *
 * A new user key is made, with which the private key of the account is encrypted again, and every
 * item and folder, by the services of upstream (`getRotatedData`). The new key is encrypted with
 * the master key of the new master password, which is derived with the same settings and salt as
 * the current one, as for a change of the master password (`ChangePasswordService`). All of it is
 * sent to the local server at once (`POST accounts/key-management/rotate-user-account-keys`), as
 * the web vault sends it to a Bitwarden server, with no emergency access, organization, passkey,
 * trusted device or Send, as an account of a local vault has none.
 */
@Injectable({ providedIn: "root" })
export class LocalVaultUserKeyRotationService {
  private readonly apiService = inject(ApiService);
  private readonly cipherService = inject(CipherService);
  private readonly cryptoFunctionService = inject(CryptoFunctionService);
  private readonly encryptService = inject(EncryptService);
  private readonly folderService = inject(FolderService);
  private readonly keyService = inject(KeyService);
  private readonly masterPasswordService = inject(InternalMasterPasswordServiceAbstraction);
  private readonly masterPasswordUnlockService = inject(MasterPasswordUnlockService);
  private readonly syncService = inject(SyncService);

  /**
   * Rotates the user key, and changes the master password to the new one of the form along with
   * it. Throws `InvalidCurrentPasswordError` if the current master password of the form is wrong,
   * `UndecryptableItemsError` if an item cannot be decrypted, and the `ErrorResponse` of the local
   * server if it refuses the rotation.
   */
  async rotateUserKey(passwordInputResult: PasswordInputResult, userId: UserId): Promise<void> {
    const context = "Could not rotate the user key.";
    const { currentPassword, newPassword, newPasswordHint, kdfConfig, salt } = passwordInputResult;
    assertTruthy(currentPassword, "currentPassword", context);
    assertTruthy(newPassword, "newPassword", context);
    assertNonNullish(kdfConfig, "kdfConfig", context);
    assertTruthy(salt, "salt", context);
    // An empty hint is one.
    assertNonNullish(newPasswordHint, "newPasswordHint", context);

    if (!(await this.masterPasswordUnlockService.proofOfDecryption(currentPassword, userId))) {
      throw new InvalidCurrentPasswordError();
    }
    // As the web vault does. The local server refuses a rotation without every item and folder
    // of the vault, and with an item that changed since the client received it.
    await this.syncService.fullSync(true);
    // An item that cannot be decrypted cannot be encrypted again, which `getRotatedData` fails
    // for. One that a device that did not have an earlier rotation yet wrote is such an item.
    const undecryptable = await firstValueFrom(this.cipherService.failedToDecryptCiphers$(userId));
    if ((undecryptable?.length ?? 0) > 0) {
      throw new UndecryptableItemsError();
    }

    const userKey = await firstValueFromOrThrow(this.keyService.userKey$(userId), "userKey");
    if (userKey.inner().type !== EncryptionType.AesCbc256_HmacSha256_B64) {
      throw new Error("Only a user key of encryption version 1 is rotated in a local vault.");
    }
    const wrappedPrivateKey = await firstValueFromOrThrow(
      this.keyService.userEncryptedPrivateKey$(userId),
      "userEncryptedPrivateKey",
    );
    const privateKey = await this.encryptService.unwrapDecapsulationKey(
      new EncString(wrappedPrivateKey),
      userKey,
    );
    const newUserKey = new SymmetricCryptoKey(
      PureCrypto.make_user_key_aes256_cbc_hmac(),
    ) as UserKey;
    const newWrappedPrivateKey = (
      await this.encryptService.wrapDecapsulationKey(privateKey, newUserKey)
    ).encryptedString;
    const publicKey = Utils.fromBufferToB64(
      await this.cryptoFunctionService.rsaExtractPublicKey(privateKey),
    );

    const currentAuthentication =
      await this.masterPasswordService.makeMasterPasswordAuthenticationData(
        currentPassword,
        kdfConfig,
        salt,
      );
    const newAuthentication = await this.masterPasswordService.makeMasterPasswordAuthenticationData(
      newPassword,
      kdfConfig,
      salt,
    );
    const newUnlock = await this.masterPasswordService.makeMasterPasswordUnlockData(
      newPassword,
      kdfConfig,
      salt,
      newUserKey,
    );
    const argon2 = kdfConfig.kdfType === KdfType.Argon2id ? (kdfConfig as Argon2KdfConfig) : null;

    // In the form of `RotateUserAccountKeysRequest` of the web vault.
    const rotation = {
      oldMasterKeyAuthenticationHash: currentAuthentication.masterPasswordAuthenticationHash,
      accountUnlockData: {
        masterPasswordUnlockData: {
          kdfType: kdfConfig.kdfType,
          kdfIterations: kdfConfig.iterations,
          kdfMemory: argon2?.memory,
          kdfParallelism: argon2?.parallelism,
          email: salt,
          masterKeyAuthenticationHash: newAuthentication.masterPasswordAuthenticationHash,
          masterKeyEncryptedUserKey: newUnlock.masterKeyWrappedUserKey,
          masterPasswordHint: newPasswordHint,
        },
        emergencyAccessUnlockData: NONE,
        organizationAccountRecoveryUnlockData: NONE,
        passkeyUnlockData: NONE,
        deviceKeyUnlockData: NONE,
      },
      accountKeys: {
        userKeyEncryptedAccountPrivateKey: newWrappedPrivateKey,
        accountPublicKey: publicKey,
        publicKeyEncryptionKeyPair: { wrappedPrivateKey: newWrappedPrivateKey, publicKey },
      },
      accountData: {
        ciphers: await this.cipherService.getRotatedData(userKey, newUserKey, userId),
        folders: await this.folderService.getRotatedData(userKey, newUserKey, userId),
        sends: NONE,
      },
    };
    await this.apiService.send("POST", ROTATE_USER_ACCOUNT_KEYS_PATH, rotation, userId, false);
  }
}
