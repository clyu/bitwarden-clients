import { ChangeDetectionStrategy, Component } from "@angular/core";

import { TypographyModule } from "@bitwarden/components";

/**
 * Takes the place of the environment selector at the foot of the login pages, which would offer
 * to choose a Bitwarden server. There is none to choose: every request of the extension is
 * answered by the local vault on this device.
 */
@Component({
  selector: "local-vault-environment",
  template: `
    <div class="tw-mb-1">
      <div bitTypography="body2">
        Accessing: <b class="tw-font-medium">local vault on this device</b>
      </div>
    </div>
  `,
  imports: [TypographyModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LocalVaultEnvironmentComponent {}
