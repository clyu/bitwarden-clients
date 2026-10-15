// The local vault stands in for the Bitwarden server. It has to be in place before anything else.
import "../local-vault/browser/install-foreground";

import { enableProdMode, provideZoneChangeDetection } from "@angular/core";
import { platformBrowser } from "@angular/platform-browser";

import { PopupSizeService } from "../platform/popup/layout/popup-size.service";
import { BrowserPlatformUtilsService } from "../platform/services/platform-utils/browser-platform-utils.service";

import { AppModule } from "./app.module";

import "./scss";

// We put these first to minimize the delay in window changing.
PopupSizeService.initBodyWidthFromLocalStorage();
// Should be removed once we deprecate support for Safari 16.0 and older. See Jira ticket [PM-1861]
if (BrowserPlatformUtilsService.shouldApplySafariHeightFix(window)) {
  document.documentElement.classList.add("safari_height_fix");
}

if (process.env.ENV === "production") {
  enableProdMode();
}

function init() {
  void platformBrowser().bootstrapModule(AppModule, {
    applicationProviders: [provideZoneChangeDetection()],
  });
}

init();
