import { DatePipe } from "@angular/common";
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from "@angular/core";

import { JslibModule } from "@bitwarden/angular/jslib.module";
import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { DevicesServiceAbstraction } from "@bitwarden/common/auth/abstractions/devices/devices.service.abstraction";
import { ValidationService } from "@bitwarden/common/platform/abstractions/validation.service";
import {
  ButtonModule,
  DialogService,
  ItemModule,
  SectionComponent,
  ToastService,
  TypographyModule,
} from "@bitwarden/components";

import { PopOutComponent } from "../../platform/popup/components/pop-out.component";
import { PopupHeaderComponent } from "../../platform/popup/layout/popup-header.component";
import { PopupPageComponent } from "../../platform/popup/layout/popup-page.component";

import { keepAtTop } from "./keep-at-top";
import {
  LocalVaultDeviceResponse,
  getLocalVaultDevices,
  retireLocalVaultDevice,
} from "./local-vault-devices-api";

/**
 * The devices that share the vault folder: the installations of a client that have a file in the
 * vault of the account, by their types and their names, as their clients name them to a Bitwarden
 * server, with when each of them last changed the vault. Those tell one that is still used, but
 * only to fill in passwords, from one that is gone for good, as neither has changed the vault for a
 * long time. One that is gone for good, such as the extension before it was installed again, is
 * retired here: this device takes its file over, and its directory is deleted 90 days later,
 * unless it turns out to be still in use.
 *
 * Account security links to it from "Manage devices", in place of the page of upstream, which lists
 * the devices that a Bitwarden server knows (`account-security.component.html`).
 */
@Component({
  selector: "local-vault-devices",
  templateUrl: "local-vault-devices.component.html",
  imports: [
    ButtonModule,
    DatePipe,
    ItemModule,
    JslibModule,
    PopOutComponent,
    PopupHeaderComponent,
    PopupPageComponent,
    SectionComponent,
    TypographyModule,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalVaultDevicesComponent implements OnInit {
  private readonly apiService = inject(ApiService);
  private readonly devicesService = inject(DevicesServiceAbstraction);
  private readonly dialogService = inject(DialogService);
  private readonly toastService = inject(ToastService);
  private readonly validationService = inject(ValidationService);

  protected readonly loading = signal(true);
  protected readonly devices = signal<LocalVaultDeviceResponse[]>([]);

  constructor() {
    keepAtTop();
  }

  async ngOnInit() {
    await this.load();
  }

  /**
   * The type of the device as upstream names it in its list of devices, such as "Extension -
   * Chrome", or `null` if its file does not say what the device is.
   */
  protected typeName(device: LocalVaultDeviceResponse): string | null {
    return device.type == null ? null : this.devicesService.getReadableDeviceTypeName(device.type);
  }

  /** Returns `true` if the device can be retired here: another one, that is not retired yet. */
  protected canRetire(device: LocalVaultDeviceResponse): boolean {
    return !device.isCurrentDevice && device.retiredDate == null;
  }

  protected async retire(device: LocalVaultDeviceResponse) {
    const confirmed = await this.dialogService.openSimpleDialog({
      title: "Retire this device?",
      content:
        "Retire a device only if it will not be used again. This device takes over what it kept " +
        "in the vault folder, and its folder there is deleted after 90 days. If it is still in " +
        "use, it is no longer retired once it syncs, within a day. Devices with an earlier " +
        "version of the app cannot open this vault until they are updated.",
      acceptButtonText: "Retire",
      type: "warning",
    });
    if (!confirmed) {
      return;
    }
    try {
      await retireLocalVaultDevice(this.apiService, device.id);
    } catch (error) {
      this.validationService.showError(error);
      return;
    }
    this.toastService.showToast({ variant: "success", message: "Device retired" });
    await this.load();
  }

  private async load() {
    try {
      this.devices.set(inListOrder(await getLocalVaultDevices(this.apiService)));
    } catch (error) {
      this.validationService.showError(error);
    }
    this.loading.set(false);
  }
}

/**
 * This device first, and the others by when they last changed the vault, the latest first: the
 * ones that are gone for good come last.
 */
function inListOrder(devices: LocalVaultDeviceResponse[]): LocalVaultDeviceResponse[] {
  const changedAt = (device: LocalVaultDeviceResponse) =>
    device.revisionDate == null ? 0 : new Date(device.revisionDate).getTime();
  return [...devices].sort(
    (a, b) => Number(b.isCurrentDevice) - Number(a.isCurrentDevice) || changedAt(b) - changedAt(a),
  );
}
