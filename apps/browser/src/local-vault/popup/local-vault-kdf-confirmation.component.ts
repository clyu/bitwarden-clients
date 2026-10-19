import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { MasterPasswordUnlockService } from "@bitwarden/common/key-management/master-password/abstractions/master-password-unlock.service";
import { withPasswordManagerSdk } from "@bitwarden/common/key-management/utils";
import { SdkService } from "@bitwarden/common/platform/abstractions/sdk/sdk.service";
import { compareValues } from "@bitwarden/common/platform/misc/compare-values";
import { SyncService } from "@bitwarden/common/platform/sync";
import { UserId } from "@bitwarden/common/types/guid";
import {
  AsyncActionsModule,
  AutofocusDirective,
  ButtonModule,
  DIALOG_DATA,
  DialogModule,
  DialogRef,
  DialogService,
  FormFieldModule,
  IconButtonModule,
  ToastService,
} from "@bitwarden/components";
import { KdfConfigService } from "@bitwarden/key-management";
// eslint-disable-next-line no-restricted-imports
import { KdfConfig } from "@bitwarden/legacy-crypto";

/**
 * What the dialog is opened with: the settings that the master key is to be derived with.
 */
export interface LocalVaultKdfConfirmationParams {
  kdfConfig: KdfConfig;
}

/**
 * Asks for the master password, and has the Bitwarden SDK change how the master key is derived
 * with it: the SDK encrypts the user key again with the master key that the new settings derive,
 * sends it to the local server (`POST accounts/kdf`), and has the app keep the new settings. It
 * closes with `true` once the settings are changed, and stays open to try again if another device
 * changed them in the meantime.
 *
 * It is the dialog of the web vault that does the same (`ChangeKdfConfirmationComponent`), which
 * the extension does not have.
 */
@Component({
  selector: "local-vault-kdf-confirmation",
  templateUrl: "local-vault-kdf-confirmation.component.html",
  imports: [
    AsyncActionsModule,
    AutofocusDirective,
    ButtonModule,
    DialogModule,
    FormFieldModule,
    IconButtonModule,
    ReactiveFormsModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalVaultKdfConfirmationComponent {
  private readonly dialogRef = inject(DialogRef<boolean>);
  private readonly accountService = inject(AccountService);
  private readonly masterPasswordUnlockService = inject(MasterPasswordUnlockService);
  private readonly sdkService = inject(SdkService);
  private readonly kdfConfigService = inject(KdfConfigService);
  private readonly syncService = inject(SyncService);
  private readonly toastService = inject(ToastService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly kdfConfig = inject<LocalVaultKdfConfirmationParams>(DIALOG_DATA).kdfConfig;

  protected readonly form = this.formBuilder.nonNullable.group({
    masterPassword: ["", [Validators.required]],
  });

  static open(dialogService: DialogService, data: LocalVaultKdfConfirmationParams) {
    return dialogService.open<boolean, LocalVaultKdfConfirmationParams>(
      LocalVaultKdfConfirmationComponent,
      { data },
    );
  }

  protected readonly submit = async () => {
    if (this.form.invalid) {
      return;
    }
    // The local server takes any settings, and a master key that cannot be derived with them
    // would leave the account impossible to unlock.
    this.kdfConfig.validateKdfConfigForSetting();

    const masterPassword = this.form.controls.masterPassword.value;
    const userId = await firstValueFrom(getUserId(this.accountService.activeAccount$));
    // A master password that is mistyped is told as such here, and not sent to the local server.
    if (!(await this.masterPasswordUnlockService.proofOfDecryption(masterPassword, userId))) {
      this.toastService.showToast({ variant: "error", message: "Invalid master password" });
      return;
    }

    const accountKdfConfig = await this.kdfConfigService.getKdfConfig(userId);
    try {
      await withPasswordManagerSdk(userId, this.sdkService, (sdk) =>
        sdk.user_crypto_management().change_kdf(masterPassword, this.kdfConfig.toSdkConfig()),
      );
    } catch (error) {
      if (await this.syncAfterRefusal(userId, accountKdfConfig)) {
        return;
      }
      throw error;
    }
    this.toastService.showToast({ variant: "success", message: "Encryption key settings saved" });
    await this.dialogRef.close(true);
  };

  /**
   * Syncs once the change failed, and returns `true` if that was because another device changed
   * the settings, or the master password, since the page synced. The master password was right,
   * as it was checked here before, but the SDK proved it to the local server with the settings
   * that the app had, which the local server refuses once it knows the master password by the
   * hash of other settings. Upstream would show what the SDK says about it: that the request
   * failed with a 400, and the answer of the local server, "Invalid master password."
   *
   * The SDK does not tell such a refusal apart from other failures of its request, so the sync
   * tells: it brings the settings of the other device, which the next attempt is made with, and
   * logs the account out if the master password changed, which leaves nothing to try again here.
   */
  private async syncAfterRefusal(userId: UserId, accountKdfConfig: KdfConfig): Promise<boolean> {
    await this.syncService.fullSync(false);
    const activeAccount = await firstValueFrom(this.accountService.activeAccount$);
    if (activeAccount?.id !== userId) {
      return true;
    }
    const syncedKdfConfig = await this.kdfConfigService.getKdfConfig(userId);
    if (compareValues(syncedKdfConfig, accountKdfConfig)) {
      return false;
    }
    this.toastService.showToast({
      variant: "error",
      message: "Your encryption key settings were changed on another device. Try again.",
    });
    return true;
  }
}
