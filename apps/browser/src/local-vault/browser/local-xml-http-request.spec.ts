/**
 * Runs with the `Request` and `Headers` of Node, which jsdom does not have. Node in turn has no
 * `XMLHttpRequest`, so one stands in for it here, as far as these tests need one.
 * @jest-environment node
 */
import { mock } from "jest-mock-extended";

import { AccountService } from "@bitwarden/common/auth/abstractions/account.service";
import { TokenService } from "@bitwarden/common/auth/abstractions/token.service";
import { DeviceType } from "@bitwarden/common/enums";
import { VaultTimeoutSettingsService } from "@bitwarden/common/key-management/vault-timeout";
import { AppIdService } from "@bitwarden/common/platform/abstractions/app-id.service";
import { EnvironmentService } from "@bitwarden/common/platform/abstractions/environment.service";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { ApiService } from "@bitwarden/common/services/api.service";

import { InMemoryLocalVaultFileSystem } from "../server/in-memory-local-vault-file-system";
import { LocalResponse } from "../server/local-request";
import { LocalServer } from "../server/local-server";
import { LocalVaultIoError } from "../server/local-vault-file-system";
import { localVaultRequest, LocalVaultRequestOptions } from "../server/local-vault-request";

import { installLocalXmlHttpRequest } from "./local-xml-http-request";

const EMAIL = "user@example.com";
const PASSWORD_HASH = "cGFzc3dvcmQtaGFzaA==";
const OTHER_URL = "https://example.com/file";

/**
 * Calls the handler that is set for an event, such as `onload`, the way a browser does for what
 * it sends events to.
 */
class HandlerTarget extends EventTarget {
  dispatchEvent(event: Event): boolean {
    const handler: unknown = (this as any)[`on${event.type}`];
    if (typeof handler === "function") {
      handler.call(this, event);
    }
    return super.dispatchEvent(event);
  }
}

/**
 * Stands in for the `XMLHttpRequest` of a browser. It keeps what it is asked for, and never
 * gets an answer.
 */
class FakeXMLHttpRequest extends HandlerTarget {
  static opened: string[] = [];
  static sent: string[] = [];
  readonly upload = new HandlerTarget();
  responseType = "";
  private url = "";

  open(method: string, url: string): void {
    this.url = url;
    FakeXMLHttpRequest.opened.push(`${method} ${url}`);
  }

  setRequestHeader(): void {}

  send(): void {
    FakeXMLHttpRequest.sent.push(this.url);
  }

  get status(): number {
    return 599;
  }
}

class FakeProgressEvent extends Event {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;

  constructor(type: string, init: ProgressEventInit = {}) {
    super(type);
    this.lengthComputable = init.lengthComputable ?? false;
    this.loaded = init.loaded ?? 0;
    this.total = init.total ?? 0;
  }
}

/**
 * What the app does with `XMLHttpRequest`, which is in `ApiService.nativeXMLHttpRequest`, on a
 * local vault. The upload of an attachment goes through it where the app shows how far the
 * upload is.
 */
describe("XMLHttpRequest on a local vault", () => {
  let fileSystem: InMemoryLocalVaultFileSystem;
  let server: LocalServer;
  let apiService: ApiService;
  let contentUrl: string;

  beforeEach(async () => {
    FakeXMLHttpRequest.opened = [];
    FakeXMLHttpRequest.sent = [];
    globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest;
    globalThis.ProgressEvent ??= FakeProgressEvent as unknown as typeof ProgressEvent;
    fileSystem = new InMemoryLocalVaultFileSystem();
    server = new LocalServer(fileSystem);
    installLocalXmlHttpRequest((request) => server.handle(request));

    const platformUtilsService = mock<PlatformUtilsService>();
    platformUtilsService.getDevice.mockReturnValue(DeviceType.FirefoxExtension);
    apiService = new ApiService(
      mock<TokenService>(),
      platformUtilsService,
      mock<EnvironmentService>(),
      mock<AppIdService>(),
      jest.fn(),
      mock<LogService>(),
      jest.fn(),
      mock<VaultTimeoutSettingsService>(),
      mock<AccountService>(),
      { createRequest: (url, request) => new Request(url, request) },
    );
    contentUrl = await attachmentUrl();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "XMLHttpRequest");
  });

  function request(
    method: string,
    path: string,
    options: LocalVaultRequestOptions = {},
  ): Promise<LocalResponse> {
    return server.handle(localVaultRequest(method, path, options));
  }

  /**
   * Makes an account with an item that has an attachment, and returns where its content goes.
   */
  async function attachmentUrl(): Promise<string> {
    await request("POST", "accounts/register/finish", {
      json: {
        email: EMAIL,
        userAsymmetricKeys: { publicKey: "publicKey", encryptedPrivateKey: "2.privateKey" },
        masterPasswordAuthentication: { masterPasswordAuthenticationHash: PASSWORD_HASH },
        masterPasswordUnlock: {
          salt: EMAIL,
          kdf: { kdfType: 0, iterations: 600000 },
          masterKeyWrappedUserKey: "2.key",
        },
      },
    });
    const login = await request("POST", "connect/token", {
      form: { grant_type: "password", username: EMAIL, password: PASSWORD_HASH },
    });
    const token: string = JSON.parse(login.body!).access_token;
    const cipher = await request("POST", "ciphers", { token, json: { type: 1 } });
    const cipherId: string = JSON.parse(cipher.body!).id;
    const upload = await request("POST", `ciphers/${cipherId}/attachment/v2`, {
      token,
      json: {},
    });
    return JSON.parse(upload.body!).url;
  }

  function send(
    sent: Request,
    onProgress: (percentage: number) => void = jest.fn(),
  ): Promise<Response> {
    return apiService.nativeXMLHttpRequest(sent, onProgress);
  }

  it("stores what the app uploads, and tells it that all of it is there", async () => {
    const content = new Uint8Array([1, 2, 3, 250]);
    const onProgress = jest.fn();

    const response = await send(
      new Request(contentUrl, { method: "PUT", body: content }),
      onProgress,
    );

    expect(response.status).toBe(201);
    expect(onProgress.mock.calls).toEqual([[100]]);
    const stored = [...fileSystem.files].filter(([path]) => path.includes("/attachments/"));
    expect(stored.map(([, bytes]) => bytes)).toEqual([content]);
    // Nothing of it went to what makes requests to a server.
    expect(FakeXMLHttpRequest.opened).toEqual([]);
  });

  it("answers with the status and the content that the local server has", async () => {
    const content = new Uint8Array([1, 2, 3, 250]);
    await send(new Request(contentUrl, { method: "PUT", body: content }));

    const found = await send(new Request(contentUrl));
    // A part of an upload in blocks, which the local server refuses.
    const refused = await send(
      new Request(`${contentUrl}?comp=blocklist`, { method: "PUT", body: "<BlockList/>" }),
    );

    expect(found.status).toBe(200);
    expect(new Uint8Array(await found.arrayBuffer())).toEqual(content);
    expect(refused.status).toBe(400);
    expect((await refused.json()).object).toBe("error");
  });

  it("fails like a request that does not reach its server when the vault folder is gone", async () => {
    jest.spyOn(fileSystem, "read").mockRejectedValue(new LocalVaultIoError("gone"));

    const upload = send(new Request(contentUrl, { method: "PUT", body: "content" }));

    await expect(upload).rejects.toThrow("Network error");
  });

  it("leaves requests for other hosts to XMLHttpRequest", () => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", OTHER_URL);
    xhr.send();

    expect(FakeXMLHttpRequest.opened).toEqual([`GET ${OTHER_URL}`]);
    expect(FakeXMLHttpRequest.sent).toEqual([OTHER_URL]);
    expect(xhr.status).toBe(599);
  });

  it("gives a request back to XMLHttpRequest when it is opened for another host", () => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", contentUrl);
    expect(xhr.status).toBe(0);

    xhr.open("GET", OTHER_URL);
    xhr.send();

    expect(xhr.status).toBe(599);
    expect(FakeXMLHttpRequest.sent).toEqual([OTHER_URL]);
  });
});
