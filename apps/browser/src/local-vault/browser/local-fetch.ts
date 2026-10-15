import { LocalRequest, LocalResponse } from "../server/local-request";

import { base64Decode, base64Encode } from "./encoding";
import { LOCAL_VAULT_HOST } from "./local-vault-environment";

export type LocalRequestHandler = (request: LocalRequest) => Promise<LocalResponse>;

/**
 * A {@link LocalRequest} in a form that can be sent between the pages of the extension.
 */
export type SerializedLocalRequest = Omit<LocalRequest, "body"> & { body: string | null };

/**
 * A {@link LocalResponse} in a form that can be sent between the pages of the extension.
 */
export type SerializedLocalResponse = Omit<LocalResponse, "bytes"> & { bytes: string | null };

/**
 * Has the given handler answer every request of this page for the host of the local vault, so
 * that they never leave the browser. This covers the requests of the app, of code that calls
 * `fetch` by itself and of the Bitwarden SDK alike. Requests for any other host are passed on.
 */
export function installLocalFetch(handler: LocalRequestHandler): void {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!isLocalVaultUrl(urlOf(input))) {
      return await nativeFetch(input, init);
    }
    const request = new Request(input, init);
    const url = request.url;
    let response: LocalResponse;
    try {
      response = await handler(await toLocalRequest(request));
    } catch {
      // What a request that does not reach its server fails with.
      throw new TypeError(
        "The local vault folder cannot be reached. Check that the local vault helper is installed.",
      );
    }
    return toResponse(response, url);
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * Returns `true` if the given address is one of the local vault, which no request may leave the
 * browser for.
 */
export function isLocalVaultUrl(url: string): boolean {
  try {
    return new URL(url, globalThis.location?.href).hostname === LOCAL_VAULT_HOST;
  } catch {
    return false;
  }
}

/**
 * The request as it is. What it asks for is worked out by the local vault.
 */
export async function toLocalRequest(request: Request): Promise<LocalRequest> {
  const body = new Uint8Array(await request.arrayBuffer());
  return {
    method: request.method.toUpperCase(),
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: body.length === 0 ? null : body,
  };
}

export function toResponse(local: LocalResponse, url: string): Response {
  const response = newResponse(local);
  // A response that is not from the network has no address, and cannot be given one when it is
  // created. The Bitwarden SDK does not accept a response without the address of its request.
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function newResponse(response: LocalResponse): Response {
  const headers: Record<string, string> =
    response.contentType == null ? {} : { "Content-Type": response.contentType };
  const body = (response.bytes as BodyInit | null) ?? response.body;
  return new Response(body, { status: response.code, headers });
}

export function serializeRequest(request: LocalRequest): SerializedLocalRequest {
  return { ...request, body: request.body == null ? null : base64Encode(request.body) };
}

export function deserializeRequest(request: SerializedLocalRequest): LocalRequest {
  return { ...request, body: request.body == null ? null : (base64Decode(request.body) ?? null) };
}

export function serializeResponse(response: LocalResponse): SerializedLocalResponse {
  return { ...response, bytes: response.bytes == null ? null : base64Encode(response.bytes) };
}

export function deserializeResponse(response: SerializedLocalResponse): LocalResponse {
  return {
    ...response,
    bytes: response.bytes == null ? null : (base64Decode(response.bytes) ?? null),
  };
}
