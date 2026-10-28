import { ApiService } from "@bitwarden/common/abstractions/api.service";
import { DeviceType } from "@bitwarden/common/enums";
import { BaseResponse } from "@bitwarden/common/models/response/base.response";
import { ListResponse } from "@bitwarden/common/models/response/list.response";

/**
 * A device that has a file in the vault of the account, as the local vault lists it: an
 * installation of a client that shares the vault folder.
 */
export class LocalVaultDeviceResponse extends BaseResponse {
  /** The ID of the installation, which names the directory that it writes its changes to. */
  id: string;
  /**
   * The name of the device, as its client names it to a Bitwarden server: the model of a phone, or
   * the browser that an extension is in. `null` if its file does not say, as one that an earlier
   * version of a client wrote does not.
   */
  name: string | null;
  /** The type of the device, as its client names it to a Bitwarden server, if its file says. */
  type: DeviceType | null;
  /** Whether it is this installation of the extension. */
  isCurrentDevice: boolean;
  /** When the device last changed the vault, if its file says so. */
  revisionDate: string | null;
  /** When the device was retired, if it was. */
  retiredDate: string | null;
  /** When the directory of the device is deleted, if it was retired. */
  removalDate: string | null;

  constructor(response: any) {
    super(response);
    this.id = this.getResponseProperty("Id");
    this.name = this.getResponseProperty("Name");
    this.type = this.getResponseProperty("Type");
    this.isCurrentDevice = this.getResponseProperty("IsCurrentDevice");
    this.revisionDate = this.getResponseProperty("RevisionDate");
    this.retiredDate = this.getResponseProperty("RetiredDate");
    this.removalDate = this.getResponseProperty("RemovalDate");
  }
}

/**
 * Lists the devices that have a file in the vault of the active account, this one among them
 * whether or not it has one yet. The local vault answers it (`GET local-vault/devices`), which a
 * Bitwarden server does not.
 */
export async function getLocalVaultDevices(
  apiService: ApiService,
): Promise<LocalVaultDeviceResponse[]> {
  const response = await apiService.send("GET", "/local-vault/devices", null, true, true);
  return new ListResponse(response, LocalVaultDeviceResponse).data;
}

/**
 * Retires a device that is gone for good: this device takes its file over, and its directory is
 * deleted 90 days later, unless it is still used (`POST local-vault/devices/{id}/retire`).
 * Resolves to the device as it is listed then, and fails with the message of the local vault for
 * this device, and for one whose file has not fully come to this device yet.
 */
export async function retireLocalVaultDevice(
  apiService: ApiService,
  deviceId: string,
): Promise<LocalVaultDeviceResponse> {
  const path = `/local-vault/devices/${encodeURIComponent(deviceId)}/retire`;
  const response = await apiService.send("POST", path, null, true, true);
  return new LocalVaultDeviceResponse(response);
}
