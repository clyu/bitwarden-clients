# Local vault helper

A browser extension cannot read or write a folder of the user. The decentralized Bitwarden
extension keeps its vault in one anyway, through this helper: a small program that the browser
starts for the extension (native messaging) and that reads and writes the files of the vault
folder for it.

It needs Python 3 and nothing else. Linux and macOS are supported, with Firefox.

## Install

```sh
python3 install.py ~/Sync/bitwarden-vault
```

This copies `local_vault_host.py` to `~/.local/share/localwarden/` (macOS:
`~/Library/Application Support/localwarden/`), writes the vault folder to
`local_vault_host.json` next to it, and registers the helper with Firefox in
`~/.mozilla/native-messaging-hosts/localwarden.json` (macOS:
`~/Library/Application Support/Mozilla/NativeMessagingHosts/`). Then restart Firefox.

Firefox only lets the extension with the ID in that file start the helper. If you build the
extension with another ID than the one in `src/manifest.json`, pass it with `--extension-id`.

Firefox from a Snap package runs in a sandbox and may not start the helper, or may ask for
permission first. For Firefox from Flathub, see below. The package of your distribution or of
Mozilla does not have that limit.

## Firefox from Flathub

Firefox from Flathub (`org.mozilla.firefox`) starts the helper in its sandbox. Of the home
directory, the sandbox reaches the directory of the app in `~/.var/app/` and the folders that it
is allowed to, so install the helper with `--flatpak`:

```sh
python3 install.py --flatpak ~/Sync/bitwarden-vault
```

This copies `local_vault_host.py` to `~/.var/app/org.mozilla.firefox/data/localwarden/` and
registers it in `~/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/`, which the
sandbox sees as `~/.mozilla/`. Unless the sandbox reaches the vault folder already, it allows it
to, with `flatpak override --user --filesystem=<vault folder> org.mozilla.firefox`. It then
checks in the sandbox that the helper, which runs with the Python 3 of the Flatpak runtime of
Firefox, can write to the folder. If it cannot, the helper is not registered, so that the
extension does not keep its vault where the folder is not. Close Firefox and start it again for
its sandbox to reach the folder.

When the folder changes, and with `--uninstall --flatpak`, it takes back what it allowed: it
removes the entry that it added from `~/.local/share/flatpak/overrides/org.mozilla.firefox`,
where flatpak-override(1) says that the overrides of the user are, and leaves the others as they
are. Flatpak has no command for that: `flatpak override --nofilesystem` adds an entry that says
that Firefox is not to reach the folder, which the installer only falls back to if its entry is
still there. What Firefox could reach before the installer ran, the installer leaves as it is,
and it stops if there is an entry for the vault folder already that does not let Firefox write
there. `flatpak override --user --show org.mozilla.firefox` lists the overrides.

Do not let Firefox start the helper outside of the sandbox with `flatpak-spawn --host`. It needs
Firefox to be allowed to talk to `org.freedesktop.Flatpak`, with which it can start any program
outside of the sandbox.

## The vault folder

The folder holds one directory per account, as described in `docs/LOCAL_VAULT_FORMAT.md` of the
local vault (`../local-vault-rs/`). To share a vault with the Android app or with another
computer, use the folder that a tool such as Syncthing keeps in sync with it, and log in with the
email address and the master password of the account. Nothing has to be registered.

To change the folder, log out in the extension, run `install.py` with the new folder, and
restart Firefox. Accounts are not copied from the old folder. With `--flatpak`, Firefox is then no
longer allowed to reach the old folder, if the installer allowed it to.

The helper reaches nothing outside of the vault folder: the extension can only name files by
names made of letters, digits, `.`, `-` and `_`, relative to that folder, and the folder itself
is not something the extension can set.

## Uninstall

```sh
python3 install.py --uninstall
```

The vault folder is left as it is. Add `--flatpak` to remove the helper of Firefox from Flathub,
and what the installer allowed its sandbox to reach.

## Tests

```sh
python3 -m unittest
```
