import { ConsoleLogService } from "@bitwarden/common/platform/services/console-log.service";

import { BrowserApi } from "../../platform/browser/browser-api";
import BrowserLocalStorageService from "../../platform/services/browser-local-storage.service";
import { LocalServer } from "../server/local-server";

import { deserializeRequest, installLocalFetch, serializeResponse } from "./local-fetch";
import { localVaultDeviceId } from "./local-vault-device-id";
import { LOCAL_VAULT_NATIVE_HOST } from "./local-vault-environment";
import {
  LOCAL_VAULT_PORT_NAME,
  LocalVaultPortAnswer,
  LocalVaultPortRequest,
} from "./local-vault-port";
import { installLocalXmlHttpRequest } from "./local-xml-http-request";
import { NativeMessagingLocalVaultFileSystem } from "./native-messaging-local-vault-file-system";

/**
 * Starts the local server, which stands in for the Bitwarden server, in the background of the
 * extension. It answers the requests of the background itself and those that the other pages
 * of the extension send here, so that all of them are handled in one place, one at a time.
 *
 * This is imported before anything else of the background, so that no request can be made
 * before it is in place.
 */
const logService = new ConsoleLogService(false);
const fileSystem = new NativeMessagingLocalVaultFileSystem(() =>
  BrowserApi.connectNative(LOCAL_VAULT_NATIVE_HOST),
);
const extensionStorage = new BrowserLocalStorageService(logService);
const localServer = new LocalServer(
  fileSystem,
  // Read again for the next request if it cannot be read.
  () => localVaultDeviceId(extensionStorage),
  () => new Date(),
  // The levels of the local server are methods of the log service.
  (level, message) => logService[level](message),
);

installLocalFetch((request) => localServer.handle(request));
installLocalXmlHttpRequest((request) => localServer.handle(request));

BrowserApi.addListener(chrome.runtime.onConnect, (port: chrome.runtime.Port) => {
  // Content scripts can connect as well. They run inside of websites and must not get to the
  // vault, so only the pages of the extension itself are answered.
  if (port.name !== LOCAL_VAULT_PORT_NAME) {
    return;
  }
  if (!BrowserApi.senderIsInternal(port.sender, logService)) {
    return;
  }
  port.onMessage.addListener((message: LocalVaultPortRequest) => {
    localServer
      .handle(deserializeRequest(message.request))
      .then(
        (response): LocalVaultPortAnswer => ({
          id: message.id,
          response: serializeResponse(response),
        }),
        (): LocalVaultPortAnswer => ({ id: message.id }),
      )
      .then((answer) => port.postMessage(answer))
      // The page that asked is gone.
      .catch((): undefined => undefined);
  });
});
