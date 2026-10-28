import { TestBed } from "@angular/core/testing";
import { mock, MockProxy } from "jest-mock-extended";

import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { DevicesServiceAbstraction } from "@bitwarden/common/auth/abstractions/devices/devices.service.abstraction";
import { DeviceType } from "@bitwarden/common/enums";
import { ErrorResponse } from "@bitwarden/common/models/response/error.response";
import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { ValidationService } from "@bitwarden/common/platform/abstractions/validation.service";
import { DialogService, ToastService } from "@bitwarden/components";

import { PopupRouterCacheService } from "../../platform/popup/view-cache/popup-router-cache.service";

import { LocalVaultDevicesComponent } from "./local-vault-devices.component";

/** A device as the local vault lists it (`GET local-vault/devices`). */
interface DeviceJson {
  object: string;
  id: string;
  name: string | null;
  type: DeviceType | null;
  isCurrentDevice: boolean;
  revisionDate: string | null;
  retiredDate: string | null;
  removalDate: string | null;
}

/**
 * A device that is not this one, which last changed the vault at the date, and whose file does not
 * say what it is.
 */
function device(id: string, revisionDate: string | null): DeviceJson {
  return {
    object: "localVaultDevice",
    id,
    name: null,
    type: null,
    isCurrentDevice: false,
    revisionDate,
    retiredDate: null,
    removalDate: null,
  };
}

const THIS_DEVICE: DeviceJson = {
  ...device("this-device", "2026-10-01T12:00:00.000Z"),
  name: "chrome",
  type: DeviceType.ChromeExtension,
  isCurrentDevice: true,
};
const GONE = device("gone-device", "2025-01-01T12:00:00.000Z");
const OTHER: DeviceJson = {
  ...device("other-device", "2026-10-20T12:00:00.000Z"),
  name: "Pixel 8",
  type: DeviceType.Android,
};
const RETIRED_GONE: DeviceJson = {
  ...GONE,
  retiredDate: "2026-10-28T12:00:00.000Z",
  removalDate: "2027-01-26T12:00:00.000Z",
};

function list(...devices: DeviceJson[]) {
  return { object: "list", data: devices, continuationToken: null as string | null };
}

/**
 * The page with the devices that share the vault folder, with the services of the app standing in
 * for the real ones.
 */
describe("the page with the devices that share the vault folder", () => {
  let apiService: MockProxy<ApiService>;
  let devicesService: MockProxy<DevicesServiceAbstraction>;
  let dialogService: MockProxy<DialogService>;
  let toastService: MockProxy<ToastService>;
  let validationService: MockProxy<ValidationService>;

  beforeEach(() => {
    apiService = mock<ApiService>();
    devicesService = mock<DevicesServiceAbstraction>();
    devicesService.getReadableDeviceTypeName.mockImplementation((type) =>
      type === DeviceType.Android ? "Mobile - Android" : "Extension - Chrome",
    );
    dialogService = mock<DialogService>();
    toastService = mock<ToastService>();
    validationService = mock<ValidationService>();

    TestBed.configureTestingModule({
      imports: [LocalVaultDevicesComponent],
      providers: [
        { provide: ApiService, useValue: apiService },
        { provide: DevicesServiceAbstraction, useValue: devicesService },
        { provide: DialogService, useValue: dialogService },
        { provide: ToastService, useValue: toastService },
        { provide: ValidationService, useValue: validationService },
        { provide: I18nService, useValue: mock<I18nService>() },
        { provide: PlatformUtilsService, useValue: mock<PlatformUtilsService>() },
        { provide: PopupRouterCacheService, useValue: mock<PopupRouterCacheService>() },
      ],
    });
    // The modules of the components library that the page imports provide one of their own.
    TestBed.overrideProvider(DialogService, { useValue: dialogService });
  });

  /** Opens the page, on which the local vault lists the devices. */
  async function openWith(...devices: DeviceJson[]): Promise<LocalVaultDevicesComponent> {
    apiService.send.mockResolvedValueOnce(list(...devices));
    const component = TestBed.createComponent(LocalVaultDevicesComponent).componentInstance;
    await component.ngOnInit();
    return component;
  }

  function idsOf(component: LocalVaultDevicesComponent): string[] {
    return component["devices"]().map((device) => device.id);
  }

  it("lists this device first, and the others by when they last changed the vault", async () => {
    const component = await openWith(GONE, OTHER, THIS_DEVICE);

    expect(apiService.send).toHaveBeenCalledWith("GET", "/local-vault/devices", null, true, true);
    expect(idsOf(component)).toEqual(["this-device", "other-device", "gone-device"]);
    expect(component["loading"]()).toBe(false);
  });

  it("names each device by its type and its name, as their clients name them", async () => {
    const component = await openWith(THIS_DEVICE, OTHER, GONE);

    const named = component["devices"]().map((device) => [
      component["typeName"](device),
      device.name,
    ]);

    expect(named).toEqual([
      ["Extension - Chrome", "chrome"],
      ["Mobile - Android", "Pixel 8"],
      // Its file does not say what it is, as one that an earlier version of a client wrote does not.
      [null, null],
    ]);
  });

  it("offers to retire only another device that is not retired yet", async () => {
    const component = await openWith(THIS_DEVICE, OTHER, RETIRED_GONE);

    const canRetire = component["devices"]().map((device) => component["canRetire"](device));

    expect(canRetire).toEqual([false, true, false]);
  });

  it("retires a device once the user confirms it, and lists the devices again", async () => {
    const component = await openWith(THIS_DEVICE, GONE);
    dialogService.openSimpleDialog.mockResolvedValue(true);
    apiService.send.mockResolvedValueOnce(RETIRED_GONE);
    apiService.send.mockResolvedValueOnce(list(THIS_DEVICE, RETIRED_GONE));

    await component["retire"](component["devices"]()[1]);

    const retire = "/local-vault/devices/gone-device/retire";
    expect(apiService.send).toHaveBeenCalledWith("POST", retire, null, true, true);
    expect(toastService.showToast).toHaveBeenCalledWith({
      variant: "success",
      message: "Device retired",
    });
    expect(component["devices"]()[1].retiredDate).toBe("2026-10-28T12:00:00.000Z");
  });

  it("does not retire a device unless the user confirms it", async () => {
    const component = await openWith(THIS_DEVICE, GONE);
    dialogService.openSimpleDialog.mockResolvedValue(false);

    await component["retire"](component["devices"]()[1]);

    expect(apiService.send).toHaveBeenCalledTimes(1);
    expect(toastService.showToast).not.toHaveBeenCalled();
  });

  it("shows why the local vault did not retire a device", async () => {
    const component = await openWith(THIS_DEVICE, GONE);
    dialogService.openSimpleDialog.mockResolvedValue(true);
    const message =
      "The file of the device has not fully come to this device yet. Try again later.";
    const refused = new ErrorResponse({ message }, 400);
    apiService.send.mockRejectedValueOnce(refused);

    await component["retire"](component["devices"]()[1]);

    expect(validationService.showError).toHaveBeenCalledWith(refused);
    expect(toastService.showToast).not.toHaveBeenCalled();
    expect(idsOf(component)).toEqual(["this-device", "gone-device"]);
  });

  it("shows why the devices could not be listed", async () => {
    const unreachable = new Error("The vault folder cannot be reached.");
    apiService.send.mockRejectedValueOnce(unreachable);

    const component = TestBed.createComponent(LocalVaultDevicesComponent).componentInstance;
    await component.ngOnInit();

    expect(validationService.showError).toHaveBeenCalledWith(unreachable);
    expect(component["devices"]()).toEqual([]);
    expect(component["loading"]()).toBe(false);
  });
});
