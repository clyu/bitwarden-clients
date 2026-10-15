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
  it as WebAssembly. `server/local-server.ts` hands it the vault folder, the clock and the
  requests as they are (method, address, headers, body): which service a request is for, whose
  it is and what its form holds is worked out by the local vault, as it is for the app. The
  local vault also stores and reads the content of attachments, which the extension has in
  memory, under the same lock as the request. What it answers differently for this client is
  the master password hint: a 400 and not a 429, as this client replaces the message of a 429.
  The README of `local-vault-rs` lists where the implementations that came before it differed.

## What is changed in upstream files

Everything else is new: the files in this directory and in `native-host/`, the submodule
`local-vault-rs/` with `.gitmodules` at the root of the repository, the workflows that test and
check them, `test-local-vault.yml` and `lint-local-vault.yml` in `.github/workflows/`, and the
action that builds the local vault for them, `.github/actions/build-local-vault/`.

| File                                                   | Change                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/platform/background.ts`                           | Imports `local-vault/browser/install-background` first.                                                                                                                                                                                               |
| `src/popup/main.ts`                                    | Imports `local-vault/browser/install-foreground` first.                                                                                                                                                                                               |
| `src/popup/app-routing.module.ts`                      | The login pages say that the vault is the local one on this device, and offer no server to choose.                                                                                                                                                    |
| `src/platform/services/browser-environment.service.ts` | Overrides `buildEnvironment`.                                                                                                                                                                                                                         |
| `src/manifest.json`, `src/manifest.v3.json`            | The name, description, author and homepage are those of this fork. Firefox: `nativeMessaging` is a required permission, the extension has an ID of its own, and it says that it sends browsing activity (for website icons), which needs Firefox 140. |
| `src/platform/badge/badge-browser-api.ts`              | Firefox: the title of the sidebar is the name of this fork.                                                                                                                                                                                           |
| `src/autofill/browser/main-context-menu-handler.ts`    | The title of the context menu is the name of this fork.                                                                                                                                                                                               |
| `src/background/nativeMessaging.background.ts`         | Does not start trying to connect to the desktop app every ten seconds; it connects when a message is sent.                                                                                                                                            |
| `src/background/native-messaging.background.spec.ts`   | Tests that it does not try to connect when it is created.                                                                                                                                                                                             |
| `src/platform/ipc/ipc-background.service.ts`           | Does not initialize the transport to the desktop app, which would try to connect to it every ten seconds.                                                                                                                                             |
| `../../.github/workflows/build-browser.yml`            | Runs the tests of the local vault before every other job, and builds with the local vault that they built, from the submodule that the sources have.                                                                                                  |

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
reach both before either of them writes it.

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

Those of the Android app apply: no organizations, Sends, two-step login or single sign-on;
changes on two devices at once lose one side; changes arrive at the next sync. In addition:

- Firefox with manifest version 2 is what this is made for. Nothing is known to break in other
  browsers, but nothing was tried, and the helper is only installed for Firefox. The manifest of
  version 3 has the same changes, but was not tried either: there the browser stops the
  background when it is idle, which the local server was not made for.
- Changing the master password opens the web vault, which does not exist here. Change it in the
  Android app; the extension logs out at its next sync and logs in with the new one.
- An attachment is held in memory as a whole. One that is larger than 256 MB is refused: the app
  sends it in blocks, which the local server does not put together.
- The extension does not try to reach the Bitwarden desktop app every ten seconds, as upstream
  does. It reaches it for biometric unlock only when the settings of the account ask whether
  that is available, so until then the lock screen does not offer it.
- Website icons are loaded from the icon service of Bitwarden, which tells it which websites are
  in the vault. Turn off "Show website icons" to avoid that. This is the browsing activity that
  Firefox says the extension sends when it is installed (`data_collection_permissions` in the
  manifests).
