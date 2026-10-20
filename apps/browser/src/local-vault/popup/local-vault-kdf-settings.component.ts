import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormBuilder, FormControl, ReactiveFormsModule, Validators } from "@angular/forms";
import { firstValueFrom } from "rxjs";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { getUserId } from "@bitwarden/common/auth/services/account.service";
import { SyncService } from "@bitwarden/common/platform/sync";
import {
  ButtonModule,
  CalloutModule,
  CardComponent,
  DialogService,
  FormFieldModule,
  SectionComponent,
  SelectModule,
  TypographyModule,
} from "@bitwarden/components";
import { KdfConfigService } from "@bitwarden/key-management";
// eslint-disable-next-line no-restricted-imports
import { Argon2KdfConfig, KdfConfig, KdfType, PBKDF2KdfConfig } from "@bitwarden/legacy-crypto";

import { PopOutComponent } from "../../platform/popup/components/pop-out.component";
import { PopupFooterComponent } from "../../platform/popup/layout/popup-footer.component";
import { PopupHeaderComponent } from "../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../platform/popup/layout/popup-page.component";

import { keepAtTop } from "./keep-at-top";
import { LocalVaultKdfConfirmationComponent } from "./local-vault-kdf-confirmation.component";

type KdfOption = { name: string; value: KdfType };

/**
 * The algorithms that the master key can be derived with.
 */
const KDF_OPTIONS: readonly KdfOption[] = Object.freeze([
  { name: "PBKDF2 SHA-256", value: KdfType.PBKDF2_SHA256 },
  { name: "Argon2id", value: KdfType.Argon2id },
]);

function defaultKdfConfig(kdfType: KdfType): KdfConfig {
  switch (kdfType) {
    case KdfType.PBKDF2_SHA256:
      return PBKDF2KdfConfig.createDefault();
    case KdfType.Argon2id:
      return Argon2KdfConfig.createDefault();
    default:
      throw new Error("Unknown KDF type.");
  }
}

/**
 * Changes how the master key of the account is derived from the master password: the algorithm,
 * and what deriving it takes. It is the page of the web vault with the same name, which does not
 * exist here, and asks for the master password before anything is changed
 * (`LocalVaultKdfConfirmationComponent`).
 */
@Component({
  selector: "local-vault-kdf-settings",
  templateUrl: "local-vault-kdf-settings.component.html",
  imports: [
    ButtonModule,
    CalloutModule,
    CardComponent,
    FormFieldModule,
    PopOutComponent,
    PopupFooterComponent,
    PopupHeaderComponent,
    PopupPageComponent,
    ReactiveFormsModule,
    SectionComponent,
    SelectModule,
    TypographyModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalVaultKdfSettingsComponent implements OnInit {
  private readonly accountService = inject(AccountService);
  private readonly kdfConfigService = inject(KdfConfigService);
  private readonly syncService = inject(SyncService);
  private readonly dialogService = inject(DialogService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly kdfOptions = KDF_OPTIONS;
  protected readonly loading = signal(true);
  protected readonly kdfConfig = signal<KdfConfig>(PBKDF2KdfConfig.createDefault());
  protected readonly isArgon2 = computed(() => this.kdfConfig() instanceof Argon2KdfConfig);

  protected readonly formGroup = this.formBuilder.group({
    kdf: new FormControl<KdfType>(KdfType.PBKDF2_SHA256, [Validators.required]),
    kdfConfig: this.formBuilder.group({
      iterations: new FormControl<number | null>(null),
      memory: new FormControl<number | null>(null),
      parallelism: new FormControl<number | null>(null),
    }),
  });

  protected readonly PBKDF2_ITERATIONS = PBKDF2KdfConfig.ITERATIONS;
  protected readonly ARGON2_ITERATIONS = Argon2KdfConfig.ITERATIONS;
  protected readonly ARGON2_MEMORY = Argon2KdfConfig.MEMORY;
  protected readonly ARGON2_PARALLELISM = Argon2KdfConfig.PARALLELISM;

  constructor() {
    keepAtTop();
  }

  async ngOnInit() {
    const userId = await firstValueFrom(getUserId(this.accountService.activeAccount$));
    // Another device that shares the vault folder may have changed the settings, which this one
    // takes at a sync. The SDK proves the master password to the local server with the settings
    // that the app has, so with the ones from before, a change here would be refused as if the
    // master password were wrong. A sync that fails leaves the settings that the app has.
    await this.syncService.fullSync(false);
    const kdfConfig = await this.kdfConfigService.getKdfConfig(userId);
    this.kdfConfig.set(kdfConfig);
    this.formGroup.controls.kdf.setValue(kdfConfig.kdfType);
    this.setFormControlValues(kdfConfig);
    this.setFormValidators(kdfConfig.kdfType);
    this.loading.set(false);

    this.formGroup.controls.kdf.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((kdfType) => this.updateKdfConfig(kdfType!));
  }

  protected openConfirmation() {
    this.formGroup.markAllAsTouched();
    if (this.formGroup.invalid) {
      return;
    }
    const controls = this.formGroup.controls.kdfConfig.controls;
    const kdfConfig: KdfConfig = this.isArgon2()
      ? new Argon2KdfConfig(
          controls.iterations.value!,
          controls.memory.value!,
          controls.parallelism.value!,
        )
      : new PBKDF2KdfConfig(controls.iterations.value!);
    this.kdfConfig.set(kdfConfig);
    LocalVaultKdfConfirmationComponent.open(this.dialogService, { kdfConfig });
  }

  private updateKdfConfig(kdfType: KdfType) {
    const kdfConfig = defaultKdfConfig(kdfType);
    this.kdfConfig.set(kdfConfig);
    this.setFormValidators(kdfType);
    this.setFormControlValues(kdfConfig);
  }

  private setFormValidators(kdfType: KdfType) {
    const controls = this.formGroup.controls.kdfConfig.controls;
    switch (kdfType) {
      case KdfType.PBKDF2_SHA256:
        controls.iterations.setValidators([
          Validators.required,
          Validators.min(PBKDF2KdfConfig.ITERATIONS.min),
          Validators.max(PBKDF2KdfConfig.ITERATIONS.max),
        ]);
        controls.memory.setValidators([]);
        controls.parallelism.setValidators([]);
        break;
      case KdfType.Argon2id:
        controls.iterations.setValidators([
          Validators.required,
          Validators.min(Argon2KdfConfig.ITERATIONS.min),
          Validators.max(Argon2KdfConfig.ITERATIONS.max),
        ]);
        controls.memory.setValidators([
          Validators.required,
          Validators.min(Argon2KdfConfig.MEMORY.min),
          Validators.max(Argon2KdfConfig.MEMORY.max),
        ]);
        controls.parallelism.setValidators([
          Validators.required,
          Validators.min(Argon2KdfConfig.PARALLELISM.min),
          Validators.max(Argon2KdfConfig.PARALLELISM.max),
        ]);
        break;
      default:
        throw new Error("Unknown KDF type.");
    }
    controls.iterations.updateValueAndValidity();
    controls.memory.updateValueAndValidity();
    controls.parallelism.updateValueAndValidity();
  }

  private setFormControlValues(kdfConfig: KdfConfig) {
    const kdfConfigFormGroup = this.formGroup.controls.kdfConfig;
    kdfConfigFormGroup.reset();
    kdfConfigFormGroup.controls.iterations.setValue(kdfConfig.iterations);
    if (kdfConfig.kdfType === KdfType.Argon2id) {
      kdfConfigFormGroup.controls.memory.setValue(kdfConfig.memory);
      kdfConfigFormGroup.controls.parallelism.setValue(kdfConfig.parallelism);
    }
  }
}
