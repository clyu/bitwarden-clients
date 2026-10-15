import { readFileSync } from "fs";
import { join } from "path";

import {
  LOCAL_VAULT_HOST,
  LOCAL_VAULT_NATIVE_HOST,
  LOCAL_VAULT_URLS,
} from "./local-vault-environment";

const BROWSER = join(__dirname, "..", "..", "..");
const NATIVE_MESSAGING = "nativeMessaging";

function manifest(name: string): any {
  return JSON.parse(readFileSync(join(BROWSER, "src", name), "utf8"));
}

function installerConstant(name: string): string | undefined {
  const installer = readFileSync(join(BROWSER, "native-host", "install.py"), "utf8");
  return new RegExp(`^${name} = "([^"]*)"$`, "m").exec(installer)?.[1];
}

/**
 * What the manifests have to say for the browser to start the local vault helper. A key with the
 * prefix `__firefox__` takes the place of the key without it in a build for Firefox.
 *
 * The manifests are upstream files, so a merge can undo any of this without a conflict.
 */
describe("the manifests of the extension", () => {
  it("ask Firefox for what every browser is asked for, and for the local vault helper", () => {
    const { permissions, __firefox__permissions: firefoxPermissions } = manifest("manifest.json");

    // The list for Firefox is a copy of the other one, which upstream does not keep up to date:
    // a permission that it adds to `permissions` has to be added here by hand.
    expect(firefoxPermissions).toContain(NATIVE_MESSAGING);
    expect(firefoxPermissions.filter((p: string) => p !== NATIVE_MESSAGING).sort()).toEqual(
      [...permissions].sort(),
    );
  });

  it.each(["manifest.json", "manifest.v3.json"])(
    "need the local vault helper in Firefox without asking, in %s",
    (name) => {
      const {
        optional_permissions: optionalPermissions,
        __firefox__permissions: firefoxPermissions,
        __firefox__optional_permissions: firefoxOptionalPermissions,
      } = manifest(name);

      expect(firefoxPermissions).toContain(NATIVE_MESSAGING);
      expect(firefoxOptionalPermissions).toEqual(
        optionalPermissions.filter((p: string) => p !== NATIVE_MESSAGING),
      );
    },
  );

  it.each(["manifest.json", "manifest.v3.json"])(
    "have the ID in %s that the helper is installed for",
    (name) => {
      const settings = manifest(name).__firefox__browser_specific_settings;

      // Firefox only lets the extension with this ID start the helper.
      expect(installerConstant("EXTENSION_ID")).toBeTruthy();
      expect(settings.gecko.id).toBe(installerConstant("EXTENSION_ID"));
    },
  );

  it.each(["manifest.json", "manifest.v3.json"])(
    "tell Firefox in %s what leaves the machine",
    (name) => {
      const { gecko } = manifest(name).__firefox__browser_specific_settings;

      // Firefox shows this when the extension is installed, and addons.mozilla.org does not sign
      // an extension without it. What the helper writes stays on this machine. What leaves it are
      // the domains of the items in the vault, which go to the icon service for their icons.
      // Should the icons no longer come from a server, the declaration becomes `["none"]`.
      expect(LOCAL_VAULT_URLS.icons).not.toContain(LOCAL_VAULT_HOST);
      expect(gecko.data_collection_permissions).toEqual({ required: ["browsingActivity"] });
      // Firefox asks for the consent itself from version 140 on. An older one would not ask.
      expect(Number.parseFloat(gecko.strict_min_version)).toBeGreaterThanOrEqual(140);
    },
  );

  it("names the helper the way it is registered with the browser", () => {
    expect(installerConstant("HOST_NAME")).toBe(LOCAL_VAULT_NATIVE_HOST);
  });
});
