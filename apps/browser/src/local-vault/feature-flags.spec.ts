import { DefaultFeatureFlagValue, FeatureFlag } from "@bitwarden/common/enums/feature-flag.enum";

import { flagsThatMustBeOff } from "../../local-vault-rs/pkg";

/**
 * The flags that the local vault counts on to be off, with what the app does when they are on.
 * Each of these moves requests to where the local server does not follow them: into the
 * Bitwarden SDK, which makes them by itself, or to routes that the local server refuses. The list
 * is the one of the local vault for every client: these are the flags of the extension.
 *
 * A flag that upstream removed is not there to look up any more, and its line fails. What it
 * turned on then happens for everyone, so the local server has to be ready for it before the
 * flag is taken out of the list of the local vault.
 */
const RULES = flagsThatMustBeOff("browser");
const FLAGS_THAT_HAVE_TO_BE_OFF = RULES.map((rule): [string, string] => [rule.key, rule.reason]);

/**
 * The local server reports no feature flags (`GET /config`), so every flag has the value that
 * the app gives it by default. These tests fail when an update from upstream changes what that
 * means for the local vault.
 */
describe("the feature flags of the app", () => {
  it("are listed by the local vault", () => {
    expect(FLAGS_THAT_HAVE_TO_BE_OFF.length).toBeGreaterThan(0);
  });

  it.each(FLAGS_THAT_HAVE_TO_BE_OFF)("%s is off, as otherwise %s", (key) => {
    expect(Object.values(FeatureFlag)).toContain(key);
    expect(DefaultFeatureFlagValue[key as FeatureFlag]).toBe(false);
  });

  it("are all off by default, but for the ones that are not switches", () => {
    const notOff = Object.entries(DefaultFeatureFlagValue).filter(([, value]) => value !== false);

    // A flag that shows here is on for everyone who has a local vault. Look at what it turns
    // on before it is added to this list.
    expect(Object.fromEntries(notOff)).toEqual({
      [FeatureFlag.PM29438_DialogWithExtensionPromptAccountAge]: 5,
      [FeatureFlag.PM32180PremiumUpsellAccountAge]: 7,
    });
  });

  /**
   * Every flag with its default value. Update the snapshot after looking at the lines that
   * changed: `npm test -- feature-flags -u`.
   *
   * - A flag that was added is off, and changes nothing. If it moves requests the way the
   *   flags at the top of this file do, add it there, so that it is noticed when it goes.
   * - A flag that was removed is a code path that is now always taken, or never. Find out
   *   which, in the commit that removed it.
   */
  it("are the ones that were looked at", () => {
    expect(DefaultFeatureFlagValue).toMatchSnapshot();
  });
});
