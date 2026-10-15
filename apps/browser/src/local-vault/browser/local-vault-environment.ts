import { Urls } from "@bitwarden/common/platform/abstractions/environment.service";

/**
 * The host of the addresses that the extension has in place of those of a server, and of those
 * that the local server hands out for the content of attachments. It is reserved, so it can never
 * resolve to a real server. The local vault has it as well, which the tests check.
 */
export const LOCAL_VAULT_HOST = "vault.local.invalid";

/**
 * The name that the helper is registered under with the browser. It gives the extension the
 * vault folder to keep the local vault in.
 */
export const LOCAL_VAULT_NATIVE_HOST = "localwarden";

/**
 * The addresses that the extension has in place of those of a Bitwarden server. Their host is
 * reserved and never resolves, so a request that the local vault does not answer fails instead
 * of reaching a server.
 */
export const LOCAL_VAULT_URLS: Readonly<Urls> = Object.freeze({
  base: `https://${LOCAL_VAULT_HOST}`,
  // Nothing pushes changes: a change from another device arrives at the next sync. This is the
  // address that the app does not connect to (DISABLED_NOTIFICATIONS_URL).
  notifications: "http://-",
  // Website icons never went to the vault API. Without this they would not load at all.
  icons: "https://icons.bitwarden.net",
});
