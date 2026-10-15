import { utf8Encode } from "../browser/encoding";
import { LOCAL_VAULT_HOST } from "../browser/local-vault-environment";

import { LocalRequest } from "./local-request";

/**
 * What a request of a test has, apart from its method and its path.
 */
export interface LocalVaultRequestOptions {
  /** The access token of the account that makes the request. */
  token?: string | null;
  /** A body of JSON. */
  json?: unknown;
  /** A body that is a form. */
  form?: Record<string, string>;
  /** A body of bytes, such as the content of an attachment. */
  bytes?: Uint8Array;
}

/**
 * A request to the local vault, for tests, as the app makes it: to the path at the address of
 * the local vault, or to an address that the local vault handed out, with the bearer token of an
 * account, and with the media type of its body.
 */
export function localVaultRequest(
  method: string,
  path: string,
  options: LocalVaultRequestOptions = {},
): LocalRequest {
  const headers: Record<string, string> = {};
  let body: Uint8Array | null = null;
  if (options.form != null) {
    headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
    body = utf8Encode(new URLSearchParams(options.form).toString());
  } else if (options.json !== undefined) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    body = utf8Encode(JSON.stringify(options.json));
  } else if (options.bytes != null) {
    body = options.bytes;
  }
  if (options.token != null) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  const url = path.includes("://")
    ? path
    : `https://${LOCAL_VAULT_HOST}/${path.replace(/^\//, "")}`;
  return { method, url, headers, body };
}
