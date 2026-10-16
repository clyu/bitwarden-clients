import { AbstractStorageService } from "@bitwarden/common/platform/abstractions/storage.service";

/**
 * The key that the ID of this installation of the extension is kept under, in the local storage
 * of the extension.
 */
const DEVICE_ID_KEY = "localVaultDeviceId";

/**
 * Returns the ID of this installation of the extension for the local vault, which writes the
 * changes of the extension to a directory of the vault folder named after it, and which no other
 * device writes. It is made the first time, and kept in the local storage of the extension, which
 * no other browser has and which goes when the extension is removed. An installation that gets
 * another ID leaves the directory of the one before behind, which the local vault still reads.
 *
 * The ID is a random UUID from the cryptographic random number generator of the browser: two
 * installations with the same ID would write the same file of the vault folder. One that is kept
 * is made again if the local vault would not name a directory after it (`isSafeSegment`).
 */
export async function localVaultDeviceId(
  storage: Pick<AbstractStorageService, "get" | "save">,
): Promise<string> {
  const { isSafeSegment } = await import("../../../local-vault-rs/pkg");
  const stored = await storage.get<unknown>(DEVICE_ID_KEY);
  if (typeof stored === "string" && isSafeSegment(stored)) {
    return stored;
  }
  const deviceId = crypto.randomUUID();
  await storage.save(DEVICE_ID_KEY, deviceId);
  return deviceId;
}
