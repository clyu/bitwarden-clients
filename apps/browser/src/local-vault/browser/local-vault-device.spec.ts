import { DeviceType } from "@bitwarden/common/enums";

import { BrowserPlatformUtilsService } from "../../platform/services/platform-utils/browser-platform-utils.service";

import { localVaultDevice } from "./local-vault-device";

describe("the device that the files of the local vault say the extension is in", () => {
  const userAgent = navigator.userAgent;

  function inBrowser(value: string) {
    Object.defineProperty(navigator, "userAgent", { configurable: true, value });
  }

  afterEach(() => {
    // Which browser the extension is in is read once, and kept.
    Reflect.set(BrowserPlatformUtilsService, "deviceCache", null);
    inBrowser(userAgent);
  });

  it("is the browser and the type of the extension, as a Bitwarden server is told", () => {
    inBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:58.0) Gecko/20100101 Firefox/58.0");

    expect(localVaultDevice(window)).toEqual({
      name: "firefox",
      type: DeviceType.FirefoxExtension,
    });
  });

  it("is the browser for one that is built on another", () => {
    inBrowser(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
    );

    expect(localVaultDevice(window)).toEqual({ name: "edge", type: DeviceType.EdgeExtension });
  });

  it("is an unknown browser for one that is not known", () => {
    inBrowser("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)");

    expect(localVaultDevice(window)).toEqual({
      name: "unknownbrowser",
      type: DeviceType.UnknownBrowser,
    });
  });
});
