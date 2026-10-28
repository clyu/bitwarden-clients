import { DeviceType } from "@bitwarden/common/enums";

import { BrowserPlatformUtilsService } from "../../platform/services/platform-utils/browser-platform-utils.service";
import { LocalServerDevice } from "../server/local-server";

/**
 * Returns what the extension names its device to a Bitwarden server as it logs in
 * (`DeviceRequest`): the type of the extension in the browser that it is in, and the name of the
 * browser, as `BrowserPlatformUtilsService.getDeviceString` makes it, such as `chrome`. The local
 * vault writes them in the files of this device, so that the devices that share the vault folder
 * can be told apart.
 *
 * A browser that is not known is named as such, rather than keeping the background from starting.
 */
export function localVaultDevice(
  globalContext: Window | ServiceWorkerGlobalScope,
): LocalServerDevice {
  const type = BrowserPlatformUtilsService.getDevice(globalContext) ?? DeviceType.UnknownBrowser;
  return { name: DeviceType[type].toLowerCase().replace("extension", ""), type };
}
