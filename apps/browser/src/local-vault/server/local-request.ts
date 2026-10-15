/**
 * A request to the local server, as the app would have sent it to a Bitwarden server. What it
 * asks for is worked out by the local vault.
 */
export interface LocalRequest {
  /** The HTTP method. */
  method: string;
  /** The address, such as `https://vault.local.invalid/api/sync`. */
  url: string;
  /** The headers, with `Authorization` and `Content-Type` among them. */
  headers: Record<string, string>;
  /** The body, if any. */
  body: Uint8Array | null;
}

/**
 * A response from the local server.
 */
export interface LocalResponse {
  /** The HTTP status code. */
  code: number;
  /** The media type of the body, if there is one. */
  contentType: string | null;
  /** The JSON body, if any. */
  body: string | null;
  /** The binary body, if any. */
  bytes: Uint8Array | null;
}
