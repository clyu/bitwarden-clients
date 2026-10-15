import { BrowserApi } from "../../platform/browser/browser-api";
import { LocalRequest, LocalResponse } from "../server/local-request";
import { LocalVaultIoError } from "../server/local-vault-file-system";

import { deserializeResponse, installLocalFetch, serializeRequest } from "./local-fetch";
import {
  LOCAL_VAULT_PORT_NAME,
  LocalVaultPortAnswer,
  LocalVaultPortRequest,
} from "./local-vault-port";
import { installLocalXmlHttpRequest } from "./local-xml-http-request";

type PendingRequest = {
  resolve: (response: LocalResponse) => void;
  reject: (error: LocalVaultIoError) => void;
};

/**
 * Sends the requests that a page of the extension makes to the Bitwarden server to the local
 * server in the background of the extension instead.
 *
 * This is imported before anything else of the page, so that no request can be made before it is
 * in place.
 */
let port: chrome.runtime.Port | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

installLocalFetch(sendToBackground);
installLocalXmlHttpRequest(sendToBackground);

function sendToBackground(request: LocalRequest): Promise<LocalResponse> {
  return new Promise<LocalResponse>((resolve, reject) => {
    const message: LocalVaultPortRequest = { id: nextId++, request: serializeRequest(request) };
    pending.set(message.id, { resolve, reject });
    try {
      connectedPort().postMessage(message);
    } catch {
      pending.delete(message.id);
      reject(new LocalVaultIoError("The background of the extension cannot be reached."));
    }
  });
}

function connectedPort(): chrome.runtime.Port {
  if (port != null) {
    return port;
  }
  const newPort = chrome.runtime.connect({ name: LOCAL_VAULT_PORT_NAME });
  BrowserApi.addListener(newPort.onMessage, (answer: LocalVaultPortAnswer) => {
    const request = pending.get(answer.id);
    if (request == null) {
      return;
    }
    pending.delete(answer.id);
    if (answer.response == null) {
      request.reject(new LocalVaultIoError("The local vault folder cannot be reached."));
    } else {
      request.resolve(deserializeResponse(answer.response));
    }
  });
  BrowserApi.addListener(newPort.onDisconnect, () => {
    if (port === newPort) {
      port = null;
    }
    const requests = [...pending.values()];
    pending.clear();
    requests.forEach((request) =>
      request.reject(new LocalVaultIoError("The background of the extension cannot be reached.")),
    );
  });
  port = newPort;
  return newPort;
}
