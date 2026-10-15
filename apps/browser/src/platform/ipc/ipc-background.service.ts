import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { PlatformUtilsService } from "@bitwarden/common/platform/abstractions/platform-utils.service";
import { SdkLoadService } from "@bitwarden/common/platform/abstractions/sdk/sdk-load.service";
import { IpcService } from "@bitwarden/common/platform/ipc";
import {
  BroadcastGroup,
  BroadcastResolution,
  IpcCommunicationBackend,
  IncomingMessage,
  OutgoingMessage,
  ipcRegisterDiscoverHandler,
  IpcClient,
} from "@bitwarden/sdk-internal";

import { BrowserForegroundIpcTransport, DesktopIpcTransport, WebIpcTransport } from "./transports";

export class IpcBackgroundService extends IpcService {
  private communicationBackend?: IpcCommunicationBackend;
  private webTransport?: WebIpcTransport;
  private desktopTransport?: DesktopIpcTransport;
  private foregroundTransport?: BrowserForegroundIpcTransport;

  constructor(
    private platformUtilsService: PlatformUtilsService,
    private logService: LogService,
  ) {
    super();
  }

  override async init() {
    try {
      // This function uses classes and functions defined in the SDK, so we need to wait for the SDK to load.
      await SdkLoadService.Ready;

      const receive = (message: IncomingMessage) => this.communicationBackend?.receive(message);

      this.communicationBackend = new IpcCommunicationBackend({
        send: async (message: OutgoingMessage): Promise<void> => {
          if (
            typeof message.destination === "object" &&
            "Web" in message.destination &&
            this.webTransport != null
          ) {
            await this.webTransport!.send(message);
            return;
          }

          if (
            (message.destination === "DesktopMain" || message.destination === "DesktopRenderer") &&
            this.desktopTransport != null
          ) {
            await this.desktopTransport!.send(message);
            return;
          }

          if (
            typeof message.destination === "object" &&
            "BrowserForeground" in message.destination &&
            this.foregroundTransport != null
          ) {
            await this.foregroundTransport.send(message);
            return;
          }

          throw new Error("Destination not supported.");
        },
        resolve: async (group: BroadcastGroup): Promise<BroadcastResolution> => {
          if (group === "AllBrowserForeground") {
            return { Endpoints: this.foregroundTransport?.connectedEndpoints() ?? [] };
          }

          return "Unsupported";
        },
      });

      if (!this.platformUtilsService.isFirefox()) {
        this.webTransport = new WebIpcTransport(this.logService, receive);
        this.webTransport.init();
      }

      this.foregroundTransport = new BrowserForegroundIpcTransport(this.logService, receive);
      this.foregroundTransport.init();

      await super.initWithClient(IpcClient.newWithSdkInMemorySessions(this.communicationBackend));

      await ipcRegisterDiscoverHandler(this.client, {
        version: await this.platformUtilsService.getApplicationVersion(),
      });

      if (!this.platformUtilsService.isSafari()) {
        // Not initialized, so that it does not try to connect to the desktop app every ten seconds:
        // nothing uses it while the local server reports no feature flags. Sending fails as when
        // the desktop app is not running.
        this.desktopTransport = new DesktopIpcTransport(this.client, this.logService, receive);
      }
    } catch (e) {
      this.logService.error("[IPC] Initialization failed", e);
    }
  }
}
