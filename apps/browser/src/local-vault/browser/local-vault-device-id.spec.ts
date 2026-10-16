import { localVaultDeviceId } from "./local-vault-device-id";

describe("the ID of the installation for the local vault", () => {
  function storage(entries: [string, unknown][] = []) {
    const stored = new Map<string, unknown>(entries);
    return {
      stored,
      get: async <T>(key: string) => stored.get(key) as T,
      save: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
    };
  }

  it("is made the first time and kept", async () => {
    const local = storage();

    const first = await localVaultDeviceId(local);
    const second = await localVaultDeviceId(local);

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).toBe(first);
    expect([...local.stored.values()]).toEqual([first]);
  });

  it("is made again in place of one that cannot name a directory", async () => {
    const local = storage([["localVaultDeviceId", "../other"]]);

    const deviceId = await localVaultDeviceId(local);

    expect(deviceId).not.toBe("../other");
    expect(local.stored.get("localVaultDeviceId")).toBe(deviceId);
  });

  it("is kept if the local vault takes it, whether or not it is a UUID", async () => {
    const local = storage([["localVaultDeviceId", "mockDeviceId_2"]]);

    expect(await localVaultDeviceId(local)).toBe("mockDeviceId_2");
  });
});
