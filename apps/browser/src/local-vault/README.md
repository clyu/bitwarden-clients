# Local vault

This fork of the Bitwarden browser extension works without a Bitwarden server. What a server
would have stored is kept in files in a folder on this machine, in the format that the
decentralized Bitwarden Android app (`clyu/bitwarden-android`) uses, so that both can share a
vault folder with any tool that moves files between devices.

The design and the file format are described in `docs/DESIGN.md` and `docs/LOCAL_VAULT_FORMAT.md`
of the local vault (`../../local-vault-rs/`). This document covers what is specific to the
extension, and what to do when updating from upstream.

## How it works

The extension is not changed to work on files. The server is replaced by a stand-in that answers
the same HTTP API from the files: the **local server**.

```
popup, sidebar                          background page
  fetch (patched)                         fetch (patched)
    └─ port "local-vault" ─────────────►    └─ LocalServer            server/
                                                └─ the local vault, in WebAssembly   ../../local-vault-rs/
                                                    └─ NativeMessagingLocalVaultFileSystem
                                                         └─ native messaging
                                                              └─ local_vault_host.py   ../../native-host/
                                                                   └─ the vault folder
```

- **`fetch` is where requests are taken over.** `installLocalFetch` wraps `globalThis.fetch` and
  answers every request for the host `vault.local.invalid`. This is the one place that the
  requests of `ApiService`, of code that calls `fetch` by itself (attachment downloads) and of
  the Bitwarden SDK all pass through. Requests for any other host are passed on unchanged.
  `installLocalXmlHttpRequest` does the same for `XMLHttpRequest`, which the app uses in the one
  place where it shows how far an upload is.
- **Every address of a server is that host.** `BrowserEnvironmentService.buildEnvironment`
  returns it whatever region is selected or stored. `.invalid` never resolves, so a request that
  the local server does not answer fails instead of reaching a server.
- **The local server runs in the background only**, so that all requests are handled in one
  place, one at a time. The other pages of the extension send theirs through a port.
- **A browser extension cannot reach a folder of the user**, so the files are read and written
  by a helper that the browser starts (native messaging). The vault folder is set where the
  helper is installed; the extension cannot name another one. See `native-host/README.md`.
- **No feature flags are reported** (`GET /config`), which keeps the app on the code paths that
  go through `ApiService` rather than those where the SDK does more by itself.
- **The local server is the local vault of the Android app.** It is written once, in Rust, in
  the repository `clyu/local-vault-rs`, which is the submodule `local-vault-rs/` of the extension
  and of the app, so that both read and write the vault folder the same way. The extension runs
  it as WebAssembly. `server/local-server.ts` hands it the vault folder, the clock, the ID of this
  installation of the extension and the requests as they are (method, address, headers, body):
  which service a request is for, whose it is and what its form holds is worked out by the local
  vault, as it is for the app. The local vault also stores and reads the content of attachments,
  which the extension has in memory, under the same lock as the request. What it answers
  differently for this client is the master password hint: a 400 and not a 429, as this client
  replaces the message of a 429. The README of `local-vault-rs` lists where the implementations
  that came before it differed.
- **Every installation writes a directory of its own.** The local vault writes the changes of
  the extension to `<account id>/devices/<device id>/` of the vault folder, which no other device
  writes, and puts the vault together from the directories of every device, so that a tool that
  syncs the folder never has two versions of a file to choose from. The ID is a random UUID that
  is made the first time that the background starts (`browser/local-vault-device-id.ts`), and kept
  in the local storage of the extension under `localVaultDeviceId`, which no other browser has:
  two browsers, or two profiles, that use the same vault folder are two devices. A copy of the
  profile, such as one moved to another computer or restored from a backup there, has the ID as
  well: as long as the profile that it was copied from uses the vault folder too, the two write
  the same file, and the tool that syncs the folder keeps the changes of only one of them. Remove
  the extension from the copy and install it again before it uses the vault folder. If the ID
  cannot be read or kept, the requests fail until it can, as `server/local-server.ts` reads it
  again for each request until it has it, once more for a request that was waiting for it as
  well: an ID that is not kept would leave a new directory in the vault folder every time.
  Removing the extension takes the ID with it, so once it is installed again it writes a
  directory of its own, and the one before stays in the vault folder. That one must not be
  deleted by hand, as part of the vault may be only in it.

## Changing how the master key is derived

Account security has "Encryption key settings": upstream has that page only in the web vault,
which does not exist here. It is a page of the local vault
(`popup/local-vault-kdf-settings.component.ts`) that changes how the master key is derived from
the master password: with PBKDF2-SHA256 or with Argon2id, and with how much work. Once the master
password is confirmed, the Bitwarden SDK encrypts the user key again with the master key that the
new settings derive, and sends it to the local server (`POST accounts/kdf`), which keeps it in
place of the one before, along with what the master password is now recognized by. The user key
stays the same, so the items do not change. The page is in English only, as its texts are not
among the messages of upstream.

No device is logged out, as with a Bitwarden server. The other devices that share the vault folder
take the new settings at their next sync. Until then, a device that has not synced still unlocks
with the settings before, but when it proves the master password to the local server, such as to
delete the account, the master password is taken to be wrong. That is why the page syncs before it
shows the settings: a change made with the settings before would be refused the same way. If the
local server refuses the change all the same, as another device changed the settings since, the
dialog that asks for the master password syncs again, says so, and stays open to try again
(`popup/local-vault-kdf-confirmation.component.ts`), in place of what the SDK says about it: that
the request failed with a 400, and the answer of the local server, "Invalid master password.". The
SDK does not tell such a refusal apart from other failures of its request, so the dialog tells it by
whether the sync brought other settings. If the sync logs the account out, as another device changed
the master password, it says nothing.

## What is changed in upstream files

Everything else is new: the files in this directory and in `native-host/`, the submodule
`local-vault-rs/` with `.gitmodules` at the root of the repository, the workflows that test and
check them, `test-local-vault.yml` and `lint-local-vault.yml` in `.github/workflows/`, and the
action that builds the local vault for them, `.github/actions/build-local-vault/`.

| File                                                      | Change                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform/background.ts`                              | Imports `local-vault/browser/install-background` first.                                                                                                                                                                                               |
| `src/popup/main.ts`                                       | Imports `local-vault/browser/install-foreground` first.                                                                                                                                                                                               |
| `src/popup/app-routing.module.ts`                         | The login pages say that the vault is the local one on this device, and offer no server to choose. The pages of the local vault come first in its routes (`popup/local-vault-routes.ts`).                                                             |
| `src/auth/popup/settings/account-security.component.html` | Links to the encryption key settings of the local vault (`popup/local-vault-kdf-settings.component.ts`).                                                                                                                                              |
| `src/platform/services/browser-environment.service.ts`    | Overrides `buildEnvironment`.                                                                                                                                                                                                                         |
| `src/manifest.json`, `src/manifest.v3.json`               | The name, description, author and homepage are those of this fork. Firefox: `nativeMessaging` is a required permission, the extension has an ID of its own, and it says that it sends browsing activity (for website icons), which needs Firefox 140. |
| `src/platform/badge/badge-browser-api.ts`                 | Firefox: the title of the sidebar is the name of this fork.                                                                                                                                                                                           |
| `src/autofill/browser/main-context-menu-handler.ts`       | The title of the context menu is the name of this fork.                                                                                                                                                                                               |
| `src/background/nativeMessaging.background.ts`            | Does not start trying to connect to the desktop app every ten seconds; it connects when a message is sent.                                                                                                                                            |
| `src/background/native-messaging.background.spec.ts`      | Tests that it does not try to connect when it is created.                                                                                                                                                                                             |
| `src/platform/ipc/ipc-background.service.ts`              | Does not initialize the transport to the desktop app, which would try to connect to it every ten seconds.                                                                                                                                             |
| `../../.github/workflows/build-browser.yml`               | Runs the tests of the local vault before every other job, and builds with the local vault that they built, from the submodule that the sources have.                                                                                                  |

## Building

The local vault is built from the submodule before the extension is, and before its tests run.
It needs Rust, with the toolchain that `local-vault-rs` pins and its target for WebAssembly, and
[wasm-pack](https://github.com/drager/wasm-pack). In `apps/browser`:

```sh
git submodule update --init
(cd local-vault-rs && rustup target add wasm32-unknown-unknown)
cargo install wasm-pack
src/local-vault/build-local-vault.sh
```

`build-local-vault.sh` puts the package in `local-vault-rs/pkg`, which git ignores, and builds in
`node_modules/.cache/local-vault-rs`. Run it again whenever the submodule changes, and before
`npm run build:firefox` or Jest. Without it, both fail to find `local-vault-rs/pkg`.

GitHub builds the local vault in the tests of the local vault, and the extension with the one
that they built.

## Updating the local vault

1. Check out the commit of `local-vault-rs` to update to, in `apps/browser/local-vault-rs`.
2. Build it, and run the tests of the local vault (below).
3. Commit the submodule, which records the commit that it is at.

The Android app has `local-vault-rs` as well. A change to the format of the vault folder has to
reach both before either of them writes it. Version 2, in which every device writes a directory
of its own, is such a change. The first write of an updated client takes a vault of version 1
over, and once that has come to a client that knows only version 1, that client does not write
the account, but does not have it either:

- Its requests for the account are refused as unauthorized, which logs the account out.
- The email of the account is taken to belong to no account, so the master key is derived with
  the default KDF settings, and the master password is taken to be wrong.
- The email can be registered again. An updated client then has two accounts with that email,
  and logs in to the first of them, by their IDs, that the master password is right for, which
  can be the new, empty one.

Until it has come, that client still changes the vault of version 1, and a tool that syncs the
folder can keep the vault that it writes in place of the `vault.json` of version 2. The updated
clients then take that vault over again. An item that it changed is kept as it changed it if that
change is the later one, and one that it deleted stays deleted unless an updated client changed
it after taking the vault over. What an updated client changed of the account, the master
password included, is kept over that vault, which does not say when it changed either of them:
a change of the master password on the client of version 1 is lost.

So the Android app is released with such a change before the extension, or at the same time,
and not after it: a browser can update the extension before the user has updated the app.

A client of version 2 deals with a file of a later version better. It fails the requests of the
account, and those that look for an account by an email that no other account has, as ones that
did not reach the server, until it is updated: it does not log the account out, take the master
password to be wrong, or let the email be registered again. The account cannot be used on a
client that does not have the next change of the format yet, but nothing else goes wrong there.

The `vault.json` that says that an account was deleted (`LOCAL_VAULT_FORMAT.md`, "Deleting an
account") is a change of the same kind, the other way round. A client from before it takes such
an account for one of a layout that it does not know, which it leaves alone. But it deletes the
whole directory of an account that it deletes, which can leave behind the file of a device that
changed the vault while the deletion was on its way to it. An updated client takes that file for
an account whose other files are still on their way, for good: its requests, and those for an
email that no other account has, fail until the directory is deleted by hand.

## Updating from upstream

1. Merge, and resolve conflicts in the files above.
2. Build the local vault, and run `npm test -- apps/browser/src/local-vault` (in `apps/browser`:
   `npx jest src/local-vault`).
   GitHub runs the same tests, and those of the helper, for a pull request and for a push to
   `main`, and builds the extension only when they pass. It also checks the code of the local
   vault with ESLint and prettier, and its types. The types of the tests are checked nowhere
   else: `npx tsc --project apps/browser/src/local-vault/tsconfig.spec.json` does that here.
   - `endpoint-inventory` fails when a request was added, changed or removed. Its snapshot lists
     the requests that the code of the extension can make, those that the route table of the
     local vault answers (`isAnswered`) apart from those that it refuses, and the paths that the
     SDK has in it for the requests that it makes by itself. Decide for each changed line
     whether the local server has to answer it, add a route to `local-vault-rs` if so, and
     update the snapshot with `-u`. A request that disappeared from the code may have moved into
     the SDK.
   - `feature-flags` fails when a feature flag was added or removed, or is on by default. The
     local server reports no flags, so a flag that upstream removed is a code path that is now
     always taken. The flags that move requests away from the local server are listed by the
     local vault (`FLAGS_THAT_MUST_BE_OFF`), for the app as well.
   - `local-service-client` runs the API services of the app against the local server. It fails
     when what the app sends, or what it expects back, changed in a way that the local server
     does not follow.
   - `local-sdk-client` does the same with the SDK itself, which fails when an update of the SDK
     changes what it sends or what it accepts back.
   - `manifest` fails when a merge took something out of the manifests that the local vault
     helper needs.
   - `local-vault-helper` runs the helper with `python3`, and checks it, with what the extension
     makes of it, against the rules of the local vault for a file system (`checkFileSystem`).
3. Check new uses of the SDK that make requests. A request that the local server refuses is
   logged as a warning in the console of the background page as
   `Local server refused: <method> <path>`, which shows what the code does not.
4. Build (`npm run build:firefox`) and try it on a copy of a vault folder.

## Limits

Those of the Android app apply: no organizations, Sends, two-step login or single sign-on; of
changes to the same item on two devices at once, only the later one is kept; changes arrive at
the next sync; a deletion is forgotten after 90 days, so a device that changed the item before
it was deleted and comes back later than that brings it back. In addition:

- A tool that syncs the vault folder brings the files of the devices in no particular order.
  Once any file of an account has come, but not yet the one that holds the account, the requests
  of the account fail as ones that did not reach the server, and so does looking for an account
  by an email that no other account has, to log in or to register. A device that gets the files
  of the others more than 90 days late can be without an item until the file with its newer
  version comes too.
- If the file that holds an account never comes, those requests keep failing on every device
  that shares the vault folder, registering a new account and logging in with a mistyped email
  included. They fail as if the server could not be reached, and the console of the background
  page has a warning that starts with `Local server cannot use account <account id>` and says
  that the vault of the account has not fully come to this device yet. The ID is the name of the
  directory of the account in the vault folder. Such a directory is usually what is left of an
  account that a client from before version 2 deleted, or that lost the directory of a device to
  a deletion by hand: its `vault.json` is missing or only says that it is of version 2, and none of
  the files `devices/<device id>/vault.json` in it has `account` in its `records`, or none has
  `masterPassword` there. Once every device that shares the folder has synced, delete that
  directory by hand, as the local vault cannot use it without the file that never came. If the
  warning says instead that a newer client wrote the vault, update the extension.
- Firefox with manifest version 2 is what this is made for. Nothing is known to break in other
  browsers, but nothing was tried, and the helper is only installed for Firefox. The manifest of
  version 3 has the same changes, but was not tried either: there the browser stops the
  background when it is idle, which the local server was not made for.
- Changing the master password opens the web vault, which does not exist here. Change it in the
  Android app; the extension logs out at its next sync and logs in with the new one.
- Changing the master password is not enough if someone else may know the old one. The user key
  stays the same, and the vault folder keeps it encrypted with the old master password: in the
  directory of every device until that device next changes the vault, or syncs a day or more
  after it last looked through its file for what other devices replaced, which it also does at
  its first sync after its background starts, and at the sync after one where it could not; in
  the backup of that file until the device writes the file again; and for good in the directory
  of an installation that was removed, which nothing writes anymore and which must not be deleted
  by hand. The extension mostly leaves the old one out of its file soon after the change comes:
  at the sync that brings it, if it last looked through its file a day or more before, or else
  at its first sync after you log in with the new master password, as the extension restarts
  when it logs out, unless another of its accounts is unlocked, or the one that it switches to is
  locked with a PIN that has "Require master password on browser restart" on. The backup of its
  file then holds the old one until the extension next writes that file. Whoever has the old
  master password and a copy of the folder can decrypt the vault, items added since included.
  Export the vault, import it into a new account, and delete the old account, which deletes the
  files of every device, and what a tool that syncs the folder left in its directory.
- Stronger encryption key settings do not protect a copy of the vault folder that was taken
  before. The user key encrypted with the master key of the settings before stays in the vault
  folder in the same places as after a change of the master password, and the master password is
  as easy to guess from it as it was.
- If another account in the vault folder has the same email, a client is told the settings of the
  first of them by ID before it logs in (`docs/DESIGN.md` of the local vault). Once the settings of
  one of them change, an account whose settings are not those of the first one can no longer be
  logged in to.
- What the Android app does with encryption key settings that another device changed was not
  tried.
- An attachment is held in memory as a whole. One that is larger than 256 MB is refused: the app
  sends it in blocks, which the local server does not put together.
- The extension does not try to reach the Bitwarden desktop app every ten seconds, as upstream
  does. It reaches it for biometric unlock only when the settings of the account ask whether
  that is available, so until then the lock screen does not offer it.
- Website icons are loaded from the icon service of Bitwarden, which tells it which websites are
  in the vault. Turn off "Show website icons" to avoid that. This is the browsing activity that
  Firefox says the extension sends when it is installed (`data_collection_permissions` in the
  manifests).
