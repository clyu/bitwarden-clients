import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";
import { of } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { MasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/abstractions/master-password-unlock.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { SdkService } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { Rc } from "@bitwarden/common/platform/misc/reference-counting/rc";
import { SyncService } from "@bitwarden/common/platform/sync";
import { FakeAccountService, mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { DIALOG_DATA, DialogRef, ToastService } from "@bitwarden/components";
import { KdfConfigService } from "@bitwarden/key-management";
// eslint-disable-next-line no-restricted-imports
import { Argon2KdfConfig, KdfConfig, PBKDF2KdfConfig } from "@bitwarden/legacy-crypto";
import { PasswordManagerClient, UserCryptoManagementClient } from "@bitwarden/sdk-internal";

import { LocalVaultKdfConfirmationComponent } from "./local-vault-kdf-confirmation.component";

const USER_ID = "user-id" as UserId;
const MASTER_PASSWORD = "the-master-password";
/** The settings that the account has when the dialog is opened. */
const ACCOUNT_KDF_CONFIG = new PBKDF2KdfConfig(600_000);
/** How the SDK fails once the local server refused the hash of the master password with a 400. */
const REFUSED = new Error("error in response: status code 400 Bad Request");

/**
 * The dialog that asks for the master password before the settings that the master key is derived
 * with are changed, with the SDK and the services of the app standing in for the real ones.
 */
describe("the confirmation of how the master key is to be derived", () => {
  let accountService: FakeAccountService;
  let masterPasswordUnlockService: MockProxy<MasterPasswordUnlockService>;
  let kdfConfigService: MockProxy<KdfConfigService>;
  let syncService: MockProxy<SyncService>;
  let toastService: MockProxy<ToastService>;
  let dialogRef: MockProxy<DialogRef<boolean>>;
  let userCryptoManagement: MockProxy<UserCryptoManagementClient>;
  // The settings that the dialog is opened with.
  let kdfConfig: KdfConfig;

  beforeEach(() => {
    accountService = mockAccountServiceWith(USER_ID);
    masterPasswordUnlockService = mock<MasterPasswordUnlockService>();
    masterPasswordUnlockService.proofOfDecryption.mockResolvedValue(true);
    kdfConfigService = mock<KdfConfigService>();
    kdfConfigService.getKdfConfig.mockResolvedValue(ACCOUNT_KDF_CONFIG);
    syncService = mock<SyncService>();
    syncService.fullSync.mockResolvedValue(true);
    toastService = mock<ToastService>();
    dialogRef = mock<DialogRef<boolean>>();
    userCryptoManagement = mock<UserCryptoManagementClient>();
    userCryptoManagement.change_kdf.mockResolvedValue();
    const sdk = mock<PasswordManagerClient>();
    sdk.user_crypto_management.mockReturnValue(userCryptoManagement);
    const sdkService = mock<SdkService>();
    sdkService.userClient$.mockReturnValue(of(new Rc(sdk)));

    TestBed.configureTestingModule({
      imports: [LocalVaultKdfConfirmationComponent],
      providers: [
        { provide: AccountService, useValue: accountService },
        { provide: MasterPasswordUnlockService, useValue: masterPasswordUnlockService },
        { provide: KdfConfigService, useValue: kdfConfigService },
        { provide: SyncService, useValue: syncService },
        { provide: SdkService, useValue: sdkService },
        { provide: ToastService, useValue: toastService },
        { provide: I18nService, useValue: mock<I18nService>() },
        { provide: DialogRef, useValue: dialogRef },
        { provide: DIALOG_DATA, useFactory: () => ({ kdfConfig }) },
      ],
    });
  });

  function open(settings: KdfConfig): LocalVaultKdfConfirmationComponent {
    kdfConfig = settings;
    return TestBed.createComponent(LocalVaultKdfConfirmationComponent).componentInstance;
  }

  it("does nothing without the master password", async () => {
    const component = open(new PBKDF2KdfConfig(650_000));

    await component["submit"]();

    expect(masterPasswordUnlockService.proofOfDecryption).not.toHaveBeenCalled();
    expect(userCryptoManagement.change_kdf).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it("says that a mistyped master password is wrong, and does not send it", async () => {
    masterPasswordUnlockService.proofOfDecryption.mockResolvedValue(false);
    const component = open(new PBKDF2KdfConfig(650_000));
    component["form"].controls.masterPassword.setValue(MASTER_PASSWORD);

    await component["submit"]();

    expect(masterPasswordUnlockService.proofOfDecryption).toHaveBeenCalledWith(
      MASTER_PASSWORD,
      USER_ID,
    );
    expect(toastService.showToast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error" }),
    );
    expect(userCryptoManagement.change_kdf).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it("refuses settings outside of what is allowed, before anything is sent", async () => {
    const component = open(new PBKDF2KdfConfig(PBKDF2KdfConfig.ITERATIONS.min - 1));
    component["form"].controls.masterPassword.setValue(MASTER_PASSWORD);

    await expect(component["submit"]()).rejects.toThrow();

    expect(userCryptoManagement.change_kdf).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it.each([
    ["PBKDF2-SHA256", new PBKDF2KdfConfig(650_000)],
    ["Argon2id", new Argon2KdfConfig(3, 64, 4)],
  ])(
    "has the SDK change the settings to %s, and closes without logging out",
    async (_, settings) => {
      const component = open(settings);
      component["form"].controls.masterPassword.setValue(MASTER_PASSWORD);

      await component["submit"]();

      expect(userCryptoManagement.change_kdf).toHaveBeenCalledWith(
        MASTER_PASSWORD,
        settings.toSdkConfig(),
      );
      expect(toastService.showToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "success" }),
      );
      expect(dialogRef.close).toHaveBeenCalledWith(true);
    },
  );

  it("syncs once the local server refused the change, and asks to try again", async () => {
    userCryptoManagement.change_kdf.mockRejectedValue(REFUSED);
    // Another device changed the settings since the page synced, which the sync brings.
    kdfConfigService.getKdfConfig
      .mockResolvedValueOnce(ACCOUNT_KDF_CONFIG)
      .mockResolvedValueOnce(new Argon2KdfConfig(3, 64, 4));
    const component = open(new PBKDF2KdfConfig(650_000));
    component["form"].controls.masterPassword.setValue(MASTER_PASSWORD);

    await component["submit"]();

    expect(syncService.fullSync).toHaveBeenCalledWith(false);
    // Not what the SDK says about it, as the master password is right.
    expect(toastService.showToast).toHaveBeenCalledWith({
      variant: "error",
      message: "Your encryption key settings were changed on another device. Try again.",
    });
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it("says nothing once the sync after a refusal logged the account out", async () => {
    userCryptoManagement.change_kdf.mockRejectedValue(REFUSED);
    // Another device changed the master password, which the sync finds.
    syncService.fullSync.mockImplementation(async () => {
      accountService.activeAccountSubject.next(null);
      return false;
    });
    const component = open(new PBKDF2KdfConfig(650_000));
    component["form"].controls.masterPassword.setValue(MASTER_PASSWORD);

    await component["submit"]();

    expect(toastService.showToast).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });

  it("shows what the SDK says when the settings did not change elsewhere", async () => {
    const failed = new Error("error in IO: the vault folder cannot be reached");
    userCryptoManagement.change_kdf.mockRejectedValue(failed);
    const component = open(new PBKDF2KdfConfig(650_000));
    component["form"].controls.masterPassword.setValue(MASTER_PASSWORD);

    // The form shows the error that the submit rejects with (`bitSubmit`).
    await expect(component["submit"]()).rejects.toBe(failed);

    expect(syncService.fullSync).toHaveBeenCalledWith(false);
    expect(toastService.showToast).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
  });
});
