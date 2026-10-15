import { SerializedLocalRequest, SerializedLocalResponse } from "./local-fetch";

/**
 * The name of the port that the pages of the extension send their requests for the local server
 * to the background through.
 */
export const LOCAL_VAULT_PORT_NAME = "local-vault";

export type LocalVaultPortRequest = { id: number; request: SerializedLocalRequest };

/**
 * The answer to a {@link LocalVaultPortRequest}. It has no response if the vault folder could
 * not be reached.
 */
export type LocalVaultPortAnswer = { id: number; response?: SerializedLocalResponse };
