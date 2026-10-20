import { Provider, SkipSelf } from "@angular/core";

import { I18nService } from "@bitwarden/common/platform/abstractions/i18n.service";

/** The message of upstream that explains the master password hint under its field. */
const HINT_TEXT_KEY = "masterPassHintText";

/**
 * What the local vault says about the master password hint, with how many characters the hint has
 * and may have. It is in English only, as it is not among the messages of upstream.
 */
function localVaultHintText(current?: string | number, maximum?: string | number): string {
  return `Anyone who can read the vault folder can read the hint. ${current}/${maximum} character maximum.`;
}

/**
 * Provides the messages of the app to a page and to the components in it, with what the local
 * vault says about the master password hint in place of what upstream says: that the hint can be
 * sent to the email of the account. No email is sent here. The local server answers a request for
 * the hint with the hint itself, and whoever can read the vault folder can read it there
 * (`docs/DESIGN.md` of the local vault, "Limits to keep in mind").
 *
 * The form of upstream (`InputPasswordComponent`) says it under the field of the hint, which is
 * how a page of the local vault replaces it without a change to the form.
 */
export function provideLocalVaultHintText(): Provider {
  return {
    provide: I18nService,
    useFactory: (i18nService: I18nService): I18nService => {
      const t: I18nService["t"] = (id, p1, p2, p3) =>
        id === HINT_TEXT_KEY ? localVaultHintText(p1, p2) : i18nService.t(id, p1, p2, p3);
      // Every other member is that of the messages of the app. `t` is defined on the new object
      // itself: assigning it would go through the messages of the app, which can have it set on
      // themselves instead, as a mock of them does, and `t` would then call itself.
      return Object.create(i18nService, { t: { value: t } });
    },
    deps: [[new SkipSelf(), I18nService]],
  };
}
