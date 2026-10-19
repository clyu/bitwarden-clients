import { TestBed } from "@angular/core/testing";
import { FormControl } from "@angular/forms";
import { mock, MockProxy } from "jest-mock-extended";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import { mockAccountServiceWith } from "@bitwarden/common/spec";
import { UserId } from "@bitwarden/common/types/guid";
import { DialogService } from "@bitwarden/components";
import { KdfConfigService } from "@bitwarden/key-management";
// eslint-disable-next-line no-restricted-imports
import { Argon2KdfConfig, KdfConfig, KdfType, PBKDF2KdfConfig } from "@bitwarden/legacy-crypto";

import { PopupRouterCacheService } from "../../platform/popup/view-cache/popup-router-cache.service";

import { LocalVaultKdfConfirmationComponent } from "./local-vault-kdf-confirmation.component";
import { LocalVaultKdfSettingsComponent } from "./local-vault-kdf-settings.component";

const USER_ID = "user-id" as UserId;

type KdfConfigControls = {
  iterations: FormControl<number | null>;
  memory: FormControl<number | null>;
  parallelism: FormControl<number | null>;
};

/**
 * The page of account security that changes how the master key is derived, with the services of
 * the app standing in for the real ones.
 */
describe("the page that changes how the master key is derived", () => {
  let kdfConfigService: MockProxy<KdfConfigService>;
  let syncService: MockProxy<SyncService>;
  let dialogService: MockProxy<DialogService>;

  beforeEach(() => {
    kdfConfigService = mock<KdfConfigService>();
    syncService = mock<SyncService>();
    syncService.fullSync.mockResolvedValue(true);
    dialogService = mock<DialogService>();

    TestBed.configureTestingModule({
      imports: [LocalVaultKdfSettingsComponent],
      providers: [
        { provide: AccountService, useValue: mockAccountServiceWith(USER_ID) },
        { provide: KdfConfigService, useValue: kdfConfigService },
        { provide: SyncService, useValue: syncService },
        { provide: DialogService, useValue: dialogService },
        { provide: I18nService, useValue: mock<I18nService>() },
        { provide: PlatformUtilsService, useValue: mock<PlatformUtilsService>() },
        { provide: PopupRouterCacheService, useValue: mock<PopupRouterCacheService>() },
      ],
    });
    // The modules of the components library that the page imports provide one of their own.
    TestBed.overrideProvider(DialogService, { useValue: dialogService });
  });

  /** Opens the page for an account whose master key is derived with the settings. */
  async function openWith(kdfConfig: KdfConfig): Promise<LocalVaultKdfSettingsComponent> {
    kdfConfigService.getKdfConfig.mockResolvedValue(kdfConfig);
    const component = TestBed.createComponent(LocalVaultKdfSettingsComponent).componentInstance;
    await component.ngOnInit();
    return component;
  }

  function controlsOf(component: LocalVaultKdfSettingsComponent): KdfConfigControls {
    return component["formGroup"].controls.kdfConfig.controls;
  }

  /** Checks that the fields are held to the limits of PBKDF2, and that it has no others. */
  function expectPbkdf2Limits(controls: KdfConfigControls) {
    expect(controls.iterations.valid).toBe(true);
    expect(controls.memory.validator).toBeNull();
    expect(controls.parallelism.validator).toBeNull();

    controls.iterations.setValue(PBKDF2KdfConfig.ITERATIONS.min - 1);
    expect(controls.iterations.hasError("min")).toBe(true);
    controls.iterations.setValue(PBKDF2KdfConfig.ITERATIONS.max + 1);
    expect(controls.iterations.hasError("max")).toBe(true);
  }

  /** Checks that the fields are held to the limits of Argon2id. */
  function expectArgon2Limits(controls: KdfConfigControls) {
    expect(controls.iterations.valid).toBe(true);
    expect(controls.memory.valid).toBe(true);
    expect(controls.parallelism.valid).toBe(true);

    controls.iterations.setValue(Argon2KdfConfig.ITERATIONS.min - 1);
    expect(controls.iterations.hasError("min")).toBe(true);
    controls.memory.setValue(Argon2KdfConfig.MEMORY.min - 1);
    expect(controls.memory.hasError("min")).toBe(true);
    controls.parallelism.setValue(Argon2KdfConfig.PARALLELISM.min - 1);
    expect(controls.parallelism.hasError("min")).toBe(true);

    controls.iterations.setValue(Argon2KdfConfig.ITERATIONS.max + 1);
    expect(controls.iterations.hasError("max")).toBe(true);
    controls.memory.setValue(Argon2KdfConfig.MEMORY.max + 1);
    expect(controls.memory.hasError("max")).toBe(true);
    controls.parallelism.setValue(Argon2KdfConfig.PARALLELISM.max + 1);
    expect(controls.parallelism.hasError("max")).toBe(true);
  }

  it("shows the PBKDF2 settings that the account has, once it has synced", async () => {
    const component = await openWith(new PBKDF2KdfConfig(650_000));

    // A change that another device made comes with a sync, before the settings are read.
    expect(syncService.fullSync).toHaveBeenCalledWith(false);
    expect(syncService.fullSync.mock.invocationCallOrder[0]).toBeLessThan(
      kdfConfigService.getKdfConfig.mock.invocationCallOrder[0],
    );
    expect(kdfConfigService.getKdfConfig).toHaveBeenCalledWith(USER_ID);
    expect(component["formGroup"].controls.kdf.value).toBe(KdfType.PBKDF2_SHA256);
    const controls = controlsOf(component);
    expect(controls.iterations.value).toBe(650_000);
    expect(controls.memory.value).toBeNull();
    expect(controls.parallelism.value).toBeNull();
    expect(component["loading"]()).toBe(false);
    expectPbkdf2Limits(controls);
  });

  it("shows the Argon2id settings that the account has", async () => {
    const component = await openWith(new Argon2KdfConfig(3, 64, 4));

    expect(component["formGroup"].controls.kdf.value).toBe(KdfType.Argon2id);
    const controls = controlsOf(component);
    expect(controls.iterations.value).toBe(3);
    expect(controls.memory.value).toBe(64);
    expect(controls.parallelism.value).toBe(4);
    expectArgon2Limits(controls);
  });

  it("shows the settings that the app has when the sync fails", async () => {
    syncService.fullSync.mockResolvedValue(false);

    const component = await openWith(new PBKDF2KdfConfig(650_000));

    expect(controlsOf(component).iterations.value).toBe(650_000);
    expect(component["loading"]()).toBe(false);
  });

  it("starts from the defaults of Argon2id when it is chosen, and holds it to its limits", async () => {
    const component = await openWith(new PBKDF2KdfConfig(650_000));

    component["formGroup"].controls.kdf.setValue(KdfType.Argon2id);

    const defaults = Argon2KdfConfig.createDefault();
    const controls = controlsOf(component);
    expect(controls.iterations.value).toBe(defaults.iterations);
    expect(controls.memory.value).toBe(defaults.memory);
    expect(controls.parallelism.value).toBe(defaults.parallelism);
    expectArgon2Limits(controls);
  });

  it("starts from the default of PBKDF2 when it is chosen, and holds it to its limits", async () => {
    const component = await openWith(new Argon2KdfConfig(3, 64, 4));

    component["formGroup"].controls.kdf.setValue(KdfType.PBKDF2_SHA256);

    const controls = controlsOf(component);
    expect(controls.iterations.value).toBe(PBKDF2KdfConfig.ITERATIONS.defaultValue);
    expect(controls.memory.value).toBeNull();
    expect(controls.parallelism.value).toBeNull();
    expectPbkdf2Limits(controls);
  });

  it.each([
    ["PBKDF2-SHA256", new PBKDF2KdfConfig(650_000), new PBKDF2KdfConfig(700_000)],
    ["Argon2id", new Argon2KdfConfig(3, 64, 4), new Argon2KdfConfig(4, 128, 2)],
  ])(
    "asks for the master password to change the %s settings to the ones of the form",
    async (_, current, changed) => {
      const component = await openWith(current);
      const controls = controlsOf(component);
      controls.iterations.setValue(changed.iterations);
      if (changed instanceof Argon2KdfConfig) {
        controls.memory.setValue(changed.memory);
        controls.parallelism.setValue(changed.parallelism);
      }

      component["openConfirmation"]();

      expect(dialogService.open).toHaveBeenCalledWith(LocalVaultKdfConfirmationComponent, {
        data: { kdfConfig: changed },
      });
    },
  );

  it("does not ask for the master password for settings outside of the limits", async () => {
    const component = await openWith(new PBKDF2KdfConfig(650_000));
    controlsOf(component).iterations.setValue(PBKDF2KdfConfig.ITERATIONS.min - 1);

    component["openConfirmation"]();

    expect(dialogService.open).not.toHaveBeenCalled();
  });

  /** Renders the page, and returns the part of it that scrolls. */
  async function renderPage(): Promise<HTMLElement> {
    kdfConfigService.getKdfConfig.mockResolvedValue(new PBKDF2KdfConfig(650_000));
    const fixture = TestBed.createComponent(LocalVaultKdfSettingsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement.querySelector("[data-testid=popup-layout-scroll-region]");
  }

  function scroll(region: HTMLElement, to: number) {
    region.scrollTop = to;
    region.dispatchEvent(new Event("scroll"));
  }

  it("stays at its top when something else than the user scrolls it as it opens", async () => {
    const region = await renderPage();

    // What Firefox does with the scroll position of the page before.
    scroll(region, 300);

    expect(region.scrollTop).toBe(0);
  });

  it.each(["wheel", "pointerdown", "touchstart"])(
    "is scrolled by the user after a %s on it",
    async (type) => {
      const region = await renderPage();

      region.dispatchEvent(new Event(type));
      scroll(region, 120);

      expect(region.scrollTop).toBe(120);
    },
  );

  it("is scrolled by the user with the keyboard", async () => {
    const region = await renderPage();

    document.dispatchEvent(new Event("keydown"));
    scroll(region, 120);

    expect(region.scrollTop).toBe(120);
  });
});
