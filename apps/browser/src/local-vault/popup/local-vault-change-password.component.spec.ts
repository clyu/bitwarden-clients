import { ComponentFixture, TestBed } from "@angular/core/testing";
import { By } from "@angular/platform-browser";
import { provideRouter, Router } from "@angular/router";
import { mock, MockProxy } from "jest-mock-extended";

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
import { AuditService } from "@bitwarden/common/abstractions/audit.service";
import { PolicyService } from "@bitwarden/common/admin-console/abstractions/policy/policy.service.abstraction";
import { Account, AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { MasterPasswordServiceAbstraction } from "@bitwarden/common/key-management/master-password/abstractions/master-password.service.abstraction";
import { ErrorResponse } from "@bitwarden/common/models/response/error.response";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { ValidationService } from "@bitwarden/common/platform/abstractions/validation.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { FakeAccountService, mockAccountServiceWith } from "@bitwarden/common/spec";
import { PasswordStrengthServiceAbstraction } from "@bitwarden/common/tools/password-strength";
import { UserId } from "@bitwarden/common/types/guid";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { DialogService, ToastService } from "@bitwarden/components";
import { PasswordGenerationServiceAbstraction } from "@bitwarden/generator-legacy";
import { KdfConfigService } from "@bitwarden/key-management";

import { PopupRouterCacheService } from "../../platform/popup/view-cache/popup-router-cache.service";

import { LocalVaultChangePasswordComponent } from "./local-vault-change-password.component";

const USER_ID = "user-id" as UserId;
const EMAIL = "user@example.com";

/** What the form of upstream gives once it has checked the new master password. */
const PASSWORD_INPUT_RESULT: PasswordInputResult = {
  currentPassword: "the-current-master-password",
  newPassword: "the-new-master-password",
  newPasswordHint: "the hint",
};

/**
 * The page of account security that changes the master password, with the services of the app
 * standing in for the real ones.
 */
describe("the page that changes the master password", () => {
  let accountService: FakeAccountService;
  let syncService: MockProxy<SyncService>;
  let changePasswordService: MockProxy<ChangePasswordService>;
  let logoutService: MockProxy<LogoutService>;
  let toastService: MockProxy<ToastService>;
  let validationService: MockProxy<ValidationService>;
  let navigate: jest.SpyInstance;

  beforeEach(() => {
    accountService = mockAccountServiceWith(USER_ID, { email: EMAIL });
    syncService = mock<SyncService>();
    syncService.fullSync.mockResolvedValue(true);
    changePasswordService = mock<ChangePasswordService>();
    changePasswordService.changePassword.mockResolvedValue();
    changePasswordService.shouldNavigateToRoot.mockReturnValue(true);
    logoutService = mock<LogoutService>();
    toastService = mock<ToastService>();
    validationService = mock<ValidationService>();
    const i18nService = mock<I18nService>();
    // A message is told by its key.
    i18nService.t.mockImplementation((key) => key);

    TestBed.configureTestingModule({
      imports: [LocalVaultChangePasswordComponent],
      providers: [
        provideRouter([]),
        { provide: AccountService, useValue: accountService },
        { provide: SyncService, useValue: syncService },
        { provide: ChangePasswordService, useValue: changePasswordService },
        { provide: LogoutService, useValue: logoutService },
        { provide: ToastService, useValue: toastService },
        { provide: ValidationService, useValue: validationService },
        { provide: I18nService, useValue: i18nService },
        { provide: LogService, useValue: mock<LogService>() },
        { provide: PlatformUtilsService, useValue: mock<PlatformUtilsService>() },
        { provide: PopupRouterCacheService, useValue: mock<PopupRouterCacheService>() },
        // What the form of upstream needs.
        { provide: AuditService, useValue: mock<AuditService>() },
        { provide: CipherService, useValue: mock<CipherService>() },
        { provide: KdfConfigService, useValue: mock<KdfConfigService>() },
        {
          provide: MasterPasswordServiceAbstraction,
          useValue: mock<MasterPasswordServiceAbstraction>(),
        },
        {
          provide: PasswordGenerationServiceAbstraction,
          useValue: mock<PasswordGenerationServiceAbstraction>(),
        },
        {
          provide: PasswordStrengthServiceAbstraction,
          useValue: mock<PasswordStrengthServiceAbstraction>(),
        },
        { provide: PolicyService, useValue: mock<PolicyService>() },
      ],
    });
    // The modules of the components library that the form imports provide one of their own.
    TestBed.overrideProvider(DialogService, { useValue: mock<DialogService>() });
    navigate = jest.spyOn(TestBed.inject(Router), "navigate").mockResolvedValue(true);
  });

  /** Opens the page, which syncs before it shows the form. */
  async function open(): Promise<LocalVaultChangePasswordComponent> {
    const component = TestBed.createComponent(LocalVaultChangePasswordComponent).componentInstance;
    await component.ngOnInit();
    return component;
  }

  /** Renders the page once it has synced. */
  async function render(): Promise<ComponentFixture<LocalVaultChangePasswordComponent>> {
    const fixture = TestBed.createComponent(LocalVaultChangePasswordComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it("shows the form for the account once it has synced", async () => {
    const component = TestBed.createComponent(LocalVaultChangePasswordComponent).componentInstance;
    let accountWhileSyncing: Account | null | undefined;
    syncService.fullSync.mockImplementation(async () => {
      accountWhileSyncing = component["account"]();
      return true;
    });

    await component.ngOnInit();

    // A change that another device made comes with the sync, before the form is shown.
    expect(syncService.fullSync).toHaveBeenCalledWith(false);
    expect(accountWhileSyncing).toBeNull();
    expect(component["account"]()).toMatchObject({ id: USER_ID, email: EMAIL });
    expect(component["loading"]()).toBe(false);
  });

  it("shows the form when the sync fails", async () => {
    syncService.fullSync.mockResolvedValue(false);

    const component = await open();

    expect(component["account"]()).toMatchObject({ id: USER_ID, email: EMAIL });
    expect(component["loading"]()).toBe(false);
  });

  it("has the form of upstream for a change of the master password of the account", async () => {
    const fixture = await render();

    const form: InputPasswordComponent = fixture.debugElement.query(
      By.directive(InputPasswordComponent),
    ).componentInstance;
    expect(form.flow).toBe(InputPasswordFlow.ChangePassword);
    expect(form.userId).toBe(USER_ID);
    expect(form.email).toBe(EMAIL);
    const currentPassword = "#input-password-form_current-password";
    expect(fixture.nativeElement.querySelector(currentPassword)).not.toBeNull();
  });

  it("changes the master password, and logs out to log in with the new one", async () => {
    const component = await open();

    await component["changePassword"](PASSWORD_INPUT_RESULT);

    expect(changePasswordService.changePassword).toHaveBeenCalledWith(
      PASSWORD_INPUT_RESULT,
      USER_ID,
    );
    expect(toastService.showToast).toHaveBeenCalledWith({
      variant: "success",
      message: "masterPasswordChanged",
    });
    expect(logoutService.logout).toHaveBeenCalledWith(USER_ID);
    expect(changePasswordService.changePassword.mock.invocationCallOrder[0]).toBeLessThan(
      logoutService.logout.mock.invocationCallOrder[0],
    );
    expect(navigate).toHaveBeenCalledWith(["/"]);
    expect(changePasswordService.closeBrowserExtensionPopout).toHaveBeenCalled();
    expect(component["submitting"]()).toBe(false);
  });

  it("says that a mistyped master password is wrong, and stays logged in", async () => {
    changePasswordService.changePassword.mockRejectedValue(new InvalidCurrentPasswordError());
    const component = await open();

    await component["changePassword"](PASSWORD_INPUT_RESULT);

    expect(toastService.showToast).toHaveBeenCalledWith({
      variant: "error",
      message: "invalidMasterPassword",
    });
    expect(logoutService.logout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(component["submitting"]()).toBe(false);
  });

  it("syncs once the local server refused the change, and asks to try again", async () => {
    // What the local server answers when the settings that the hash of the master password was
    // derived with are not those of the account, which another device changed since the sync.
    const refused = new ErrorResponse({ message: "Invalid master password." }, 400);
    changePasswordService.changePassword.mockRejectedValue(refused);
    const component = await open();
    syncService.fullSync.mockClear();

    await component["changePassword"](PASSWORD_INPUT_RESULT);

    // Not the message of the server, as the master password is right.
    expect(syncService.fullSync).toHaveBeenCalledWith(false);
    expect(toastService.showToast).toHaveBeenCalledWith({
      variant: "error",
      message: "Your encryption key settings were changed on another device. Try again.",
    });
    expect(validationService.showError).not.toHaveBeenCalled();
    expect(logoutService.logout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(component["submitting"]()).toBe(false);
  });

  it("says nothing once the sync after a refusal logged the account out", async () => {
    changePasswordService.changePassword.mockRejectedValue(
      new ErrorResponse({ message: "Invalid master password." }, 400),
    );
    const component = await open();
    // Another device changed the master password, which the sync finds.
    syncService.fullSync.mockImplementation(async () => {
      accountService.activeAccountSubject.next(null);
      return false;
    });

    await component["changePassword"](PASSWORD_INPUT_RESULT);

    expect(syncService.fullSync).toHaveBeenCalledTimes(2);
    expect(toastService.showToast).not.toHaveBeenCalled();
    expect(validationService.showError).not.toHaveBeenCalled();
  });

  it("shows why the change failed otherwise, and stays logged in", async () => {
    const failed = new Error("The vault folder cannot be reached.");
    changePasswordService.changePassword.mockRejectedValue(failed);
    const component = await open();
    syncService.fullSync.mockClear();

    await component["changePassword"](PASSWORD_INPUT_RESULT);

    expect(validationService.showError).toHaveBeenCalledWith(failed);
    expect(syncService.fullSync).not.toHaveBeenCalled();
    expect(toastService.showToast).not.toHaveBeenCalled();
    expect(logoutService.logout).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("says what the local vault does with the master password hint", async () => {
    const fixture = await render();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain(
      "Anyone who can read the vault folder can read the hint. 0/50 character maximum.",
    );
    // That the hint can be sent to the email of the account, which upstream says.
    expect(text).not.toContain("masterPassHintText");
  });

  function scroll(region: HTMLElement, to: number) {
    region.scrollTop = to;
    region.dispatchEvent(new Event("scroll"));
  }

  it("stays at its top as it opens, until the user scrolls it", async () => {
    const fixture = await render();
    const region: HTMLElement = fixture.nativeElement.querySelector(
      "[data-testid=popup-layout-scroll-region]",
    );

    // What Firefox does with the scroll position of account security, which links to the page.
    scroll(region, 300);
    expect(region.scrollTop).toBe(0);

    region.dispatchEvent(new Event("wheel"));
    scroll(region, 120);
    expect(region.scrollTop).toBe(120);
  });
});
