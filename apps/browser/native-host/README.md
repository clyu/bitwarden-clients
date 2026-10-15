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

Firefox from a Snap or Flatpak package runs in a sandbox and may not start the helper, or may
ask for permission first. The package of your distribution or of Mozilla does not have that
limit.

## The vault folder

The folder holds one directory per account, as described in `docs/LOCAL_VAULT_FORMAT.md` of the
local vault (`../local-vault-rs/`). To share a vault with the Android app or with another
computer, use the folder that a tool such as Syncthing keeps in sync with it, and log in with the
email address and the master password of the account. Nothing has to be registered.

To change the folder, log out in the extension, run `install.py` with the new folder, and
restart Firefox. Accounts are not copied from the old folder.

The helper reaches nothing outside of the vault folder: the extension can only name files by
names made of letters, digits, `.`, `-` and `_`, relative to that folder, and the folder itself
is not something the extension can set.

## Uninstall

```sh
python3 install.py --uninstall
```

The vault folder is left as it is.

## Tests

```sh
python3 -m unittest
```
