import { Routes } from "@angular/router";

import { authGuard, hasPasswordGuard } from "@bitwarden/angular/auth/guards";

import { AuthExtensionRoute } from "../../auth/popup/constants/auth-extension-route.constant";
import type { RouteDataProperties } from "../../popup/app-routing.module";

import { LocalVaultChangePasswordComponent } from "./local-vault-change-password.component";
import { LocalVaultKdfSettingsComponent } from "./local-vault-kdf-settings.component";

/**
 * Where the page that changes the master password is, which account security links to in place of
 * the web vault (`account-security.component.html`). Like every path of the settings, it must not
 * contain "change-password", which `authGuard` lets through as the page that a forced change of
 * the master password is made on.
 */
export const LOCAL_VAULT_PASSWORD_PATH = "local-vault-password";

/**
 * Where the page that changes how the master key is derived is, which account security links to
 * (`account-security.component.html`). Like every path of the settings, it must not contain
 * "change-password", which `authGuard` lets through as the page that a forced change of the master
 * password is made on.
 */
export const LOCAL_VAULT_KDF_SETTINGS_PATH = "local-vault-kdf";

/**
 * The pages of the local vault, which upstream does not have. They come first in the routes of the
 * popup (`app-routing.module.ts`).
 */
export const LOCAL_VAULT_ROUTES: Routes = [
  {
    path: LOCAL_VAULT_PASSWORD_PATH,
    component: LocalVaultChangePasswordComponent,
    canActivate: [authGuard, hasPasswordGuard([`/${AuthExtensionRoute.AccountSecurity}`])],
    data: { elevation: 2 } satisfies RouteDataProperties,
  },
  {
    path: LOCAL_VAULT_KDF_SETTINGS_PATH,
    component: LocalVaultKdfSettingsComponent,
    canActivate: [authGuard, hasPasswordGuard([`/${AuthExtensionRoute.AccountSecurity}`])],
    data: { elevation: 2 } satisfies RouteDataProperties,
  },
];
