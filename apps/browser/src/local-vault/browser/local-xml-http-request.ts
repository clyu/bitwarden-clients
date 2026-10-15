import { LocalResponse } from "../server/local-request";

import { utf8Decode, utf8Encode } from "./encoding";
import { isLocalVaultUrl, LocalRequestHandler, toLocalRequest } from "./local-fetch";

const OPENED = 1;
const DONE = 4;

/**
 * The names of what a request has in the place of its own while it is one for the local vault.
 */
const takenOver = new WeakMap<XMLHttpRequest, string[]>();

/**
 * Has the given handler answer the requests of this page for the host of the local vault that
 * are made with `XMLHttpRequest`, as {@link installLocalFetch} does for the ones that are made
 * with `fetch`. The app makes one where it shows how far an upload is, which `fetch` does not
 * tell. Requests for any other host are passed on.
 */
export function installLocalXmlHttpRequest(handler: LocalRequestHandler): void {
  const NativeXMLHttpRequest = globalThis.XMLHttpRequest;
  if (NativeXMLHttpRequest == null) {
    // A service worker has none, and so nothing in it makes such a request.
    return;
  }
  globalThis.XMLHttpRequest = new Proxy(NativeXMLHttpRequest, {
    construct(target, argumentsList, newTarget): XMLHttpRequest {
      const xhr: XMLHttpRequest = Reflect.construct(target, argumentsList, newTarget);
      // Where a request goes is known when it is opened. This is put on the request itself, so
      // that what else changes `XMLHttpRequest` for every request still does for the others.
      Object.defineProperty(xhr, "open", {
        configurable: true,
        value: (method: string, url: string | URL, ...rest: unknown[]): void => {
          restore(xhr);
          if (isLocalVaultUrl(String(url))) {
            new LocalExchange(xhr, method.toUpperCase(), String(url), handler).takeOver();
          } else {
            Object.getPrototypeOf(xhr).open.call(xhr, method, url, ...rest);
          }
        },
      });
      return xhr;
    },
  });
}

/**
 * Gives a request back what it had before it was one for the local vault.
 */
function restore(xhr: XMLHttpRequest): void {
  (takenOver.get(xhr) ?? []).forEach((name) => Reflect.deleteProperty(xhr, name));
  takenOver.delete(xhr);
}

/**
 * A request for the local vault and the answer to it, in the place of what an `XMLHttpRequest`
 * does with a server.
 */
class LocalExchange {
  private readonly headers = new Headers();
  private readyState = OPENED;
  private answer: LocalResponse | null = null;

  constructor(
    private readonly xhr: XMLHttpRequest,
    private readonly method: string,
    private readonly url: string,
    private readonly handler: LocalRequestHandler,
  ) {}

  /**
   * Puts this in the place of what the request does and tells, until it is opened again.
   */
  takeOver(): void {
    const members: PropertyDescriptorMap = {
      setRequestHeader: { value: (name: string, value: string) => this.setHeader(name, value) },
      send: { value: (body?: XMLHttpRequestBodyInit | null): void => void this.send(body) },
      abort: { value: () => this.finish("abort") },
      getResponseHeader: { value: (name: string) => this.header(name) },
      getAllResponseHeaders: { value: () => this.allHeaders() },
      readyState: { get: () => this.readyState },
      status: { get: () => this.answer?.code ?? 0 },
      statusText: { get: () => "" },
      response: { get: () => this.response() },
      responseText: { get: () => (this.answer == null ? "" : utf8Decode(this.content())) },
      responseURL: { get: () => (this.answer == null ? "" : this.url) },
    };
    for (const member of Object.values(members)) {
      member.configurable = true;
    }
    Object.defineProperties(this.xhr, members);
    takenOver.set(this.xhr, Object.keys(members));
  }

  private setHeader(name: string, value: string): void {
    this.headers.append(name, value);
  }

  private async send(body: XMLHttpRequestBodyInit | null | undefined): Promise<void> {
    let answer: LocalResponse;
    let size: number;
    try {
      const hasBody = body != null && this.method !== "GET" && this.method !== "HEAD";
      const request = await toLocalRequest(
        new Request(this.url, {
          method: this.method,
          headers: this.headers,
          body: hasBody ? body : undefined,
        }),
      );
      size = request.body?.length ?? 0;
      answer = await this.handler(request);
    } catch {
      // What a request that does not reach its server ends with.
      this.finish("error");
      return;
    }
    if (this.readyState === DONE) {
      // The request was given up on while it was under way.
      return;
    }
    this.answer = answer;
    // The local vault has the content as a whole, or it has none of it.
    this.xhr.upload.dispatchEvent(
      new ProgressEvent("progress", { lengthComputable: size > 0, loaded: size, total: size }),
    );
    this.finish("load");
  }

  private finish(event: "load" | "error" | "abort"): void {
    if (this.readyState === DONE) {
      return;
    }
    this.readyState = DONE;
    this.xhr.dispatchEvent(new Event("readystatechange"));
    this.xhr.dispatchEvent(new ProgressEvent(event));
    this.xhr.dispatchEvent(new ProgressEvent("loadend"));
  }

  private header(name: string): string | null {
    return this.answer != null && name.toLowerCase() === "content-type"
      ? this.answer.contentType
      : null;
  }

  private allHeaders(): string {
    const type = this.header("content-type");
    return type == null ? "" : `content-type: ${type}\r\n`;
  }

  /**
   * The answer in the form that the request asked for it in, with `responseType`.
   */
  private response(): unknown {
    const type = this.xhr.responseType;
    if (this.answer == null) {
      return type === "" || type === "text" ? "" : null;
    }
    switch (type) {
      case "arraybuffer":
        return this.content().buffer;
      case "blob":
        return new Blob([this.content()]);
      case "json":
        try {
          return JSON.parse(utf8Decode(this.content()));
        } catch {
          return null;
        }
      case "document":
        return null;
      default:
        return utf8Decode(this.content());
    }
  }

  private content(): Uint8Array<ArrayBuffer> {
    const bytes = this.answer?.bytes ?? utf8Encode(this.answer?.body ?? "");
    const content = new Uint8Array(bytes.length);
    content.set(bytes);
    return content;
  }
}
