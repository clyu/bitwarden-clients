import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { firstValueFrom } from "rxjs";

import {
  ChangePasswordService,
  InvalidCurrentPasswordError,
} from "@bitwarden/angular/auth/password-management/change-password";
import {
  InputPasswordComponent,
  InputPasswordFlow,
  PasswordInputResult,
} from "@bitwarden/auth/angular";
import { LogoutService } from "@bitwarden/auth/common";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { ErrorResponse } from "@bitwarden/common/models/response/error.response";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { ValidationService } from "@bitwarden/common/platform/abstractions/validation.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { CalloutModule, ToastService, TypographyModule } from "@bitwarden/components";
import { I18nPipe } from "@bitwarden/ui-common";

import { PopOutComponent } from "../../platform/popup/components/pop-out.component";
import { PopupHeaderComponent } from "../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../platform/popup/layout/popup-page.component";

import { keepAtTop } from "./keep-at-top";
import { provideLocalVaultHintText } from "./local-vault-hint-text";
import {
  isRefusedForAChangedVault,
  LocalVaultUserKeyRotationService,
  UndecryptableItemsError,
} from "./local-vault-user-key-rotation.service";

/**
 * Changes the master password of the account. Upstream has this page in the extension
 * (`ChangePasswordPageComponent`) only behind a feature flag that the local server does not
 * report, and opens the web vault in its place, which does not exist here.
 *
 * It has the form of upstream (`InputPasswordComponent`), and changes the master password the way
 * upstream does (`ChangePasswordService`): the user key is encrypted with the master key of the new
 * master password, which is derived with the same settings, and sent to the local server
 * (`POST accounts/password`), which gives the account a new security stamp. The account is then
 * logged out, as upstream does, to be logged in to with the new master password.
 *
 * The form offers to rotate the user key along with it, as it does in the web vault of upstream,
 * which is what locks out whoever knows the old master password: the user key is replaced, and
 * everything that it encrypts is encrypted again with the new one
 * (`LocalVaultUserKeyRotationService`).
 *
 * What the form says about the master password hint is that of the local vault
 * (`provideLocalVaultHintText`).
 */
@Component({
  selector: "local-vault-change-password",
  templateUrl: "local-vault-change-password.component.html",
  providers: [provideLocalVaultHintText()],
  imports: [
    CalloutModule,
    I18nPipe,
    InputPasswordComponent,
    PopOutComponent,
    PopupHeaderComponent,
    PopupPageComponent,
    TypographyModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalVaultChangePasswordComponent implements OnInit {
  private readonly accountService = inject(AccountService);
  private readonly syncService = inject(SyncService);
  private readonly changePasswordService = inject(ChangePasswordService);
  private readonly userKeyRotationService = inject(LocalVaultUserKeyRotationService);
  private readonly logoutService = inject(LogoutService);
  private readonly router = inject(Router);
  private readonly toastService = inject(ToastService);
  private readonly validationService = inject(ValidationService);
  private readonly i18nService = inject(I18nService);
  private readonly logService = inject(LogService);

  protected readonly inputPasswordFlow =
    InputPasswordFlow.ChangePasswordWithOptionalUserKeyRotation;
  protected readonly loading = signal(true);
  protected readonly submitting = signal(false);
  /** The account whose master password is changed, once it has synced. */
  protected readonly account = signal<Account | null>(null);

  constructor() {
    keepAtTop();
  }

  async ngOnInit() {
    const account = await firstValueFrom(this.accountService.activeAccount$);
    // Another device that shares the vault folder may have changed the master password, which
    // logs this one out at a sync, or how the master key is derived, which this one takes at a
    // sync. The current master password is proven to the local server with the settings that the
    // app has, and the new master key is derived with them, so with the ones from before, the
    // change would be refused. A sync that fails leaves the settings that the app has.
    await this.syncService.fullSync(false);
    this.account.set(account);
    this.loading.set(false);
  }

  protected async changePassword(passwordInputResult: PasswordInputResult) {
    const account = this.account();
    if (account == null) {
      return;
    }
    this.submitting.set(true);
    const rotatesUserKey = passwordInputResult.rotateUserKey === true;
    try {
      if (rotatesUserKey) {
        await this.userKeyRotationService.rotateUserKey(passwordInputResult, account.id);
      } else {
        await this.changePasswordService.changePassword(passwordInputResult, account.id);
      }
      this.toastService.showToast({
        variant: "success",
        message: rotatesUserKey
          ? "Your master password was changed and your encryption key rotated."
          : this.i18nService.t("masterPasswordChanged"),
      });
      // As upstream. The new security stamp would log the account out at its next sync anyway,
      // as it does on the other devices.
      await this.logoutService.logout(account.id, "passwordChanged");
      if (this.changePasswordService.shouldNavigateToRoot()) {
        // The next account that is logged in, or the login page.
        await this.router.navigate(["/"]);
      }
      this.changePasswordService.closeBrowserExtensionPopout?.();
    } catch (error) {
      this.logService.error(error);
      if (error instanceof InvalidCurrentPasswordError) {
        this.toastService.showToast({
          variant: "error",
          message: this.i18nService.t("invalidMasterPassword"),
        });
      } else if (error instanceof UndecryptableItemsError) {
        this.toastService.showToast({
          variant: "error",
          message:
            "Some items cannot be decrypted. Delete them before you rotate the encryption key.",
        });
      } else if (
        error instanceof ErrorResponse &&
        error.statusCode === 400 &&
        (!rotatesUserKey || isRefusedForAChangedVault(error))
      ) {
        await this.syncAfterRefusal(account, rotatesUserKey);
      } else {
        // Such as that the vault folder cannot be reached, or a refusal of a rotation that another
        // attempt would get as well, which the message of the local server says the reason of.
        this.validationService.showError(error);
      }
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * Syncs once the local server refused the change. The master password was right, as it was
   * checked here before, so another device changed how the master key is derived, or the master
   * password, since the page synced: the local server knows the master password by another hash
   * than the one that the settings of the app derive. Upstream would show the message of the
   * server, "Invalid master password."
   *
   * A rotation of the user key is refused as well when the vault has an item or a folder that it
   * does not have, or one that changed since, which another device added or changed since the
   * page synced (`isRefusedForAChangedVault`). Another refusal of a rotation would come again,
   * and its message is shown instead.
   *
   * A change of the settings, or of the vault, comes with the sync, and the next attempt is made
   * with them. A change of the master password logs the account out at the sync instead, which
   * leaves nothing to try again here.
   */
  private async syncAfterRefusal(account: Account, rotatesUserKey: boolean) {
    await this.syncService.fullSync(false);
    const activeAccount = await firstValueFrom(this.accountService.activeAccount$);
    if (activeAccount?.id !== account.id) {
      return;
    }
    this.toastService.showToast({
      variant: "error",
      message: rotatesUserKey
        ? "Your vault was changed on another device. Try again."
        : "Your encryption key settings were changed on another device. Try again.",
    });
  }
}
