#!/usr/bin/env python3
"""Installs the local vault helper for Firefox and sets the vault folder.

    python3 install.py <vault folder>
    python3 install.py --uninstall

The vault folder is the folder that the accounts are kept in, one directory each. To share a
vault with another device, choose the folder that a tool such as Syncthing keeps in sync with it.
Run this again to change the folder; log out in the extension first, as what it has cached
belongs to the vault of the old folder.
"""

import argparse
import json
import os
import shutil
import stat
import sys

HOST_NAME = "localwarden"
HOST_FILE = "local_vault_host.py"
CONFIG_FILE = "local_vault_host.json"

# The ID of the extension, from `browser_specific_settings` in its manifest.
EXTENSION_ID = "localwarden@local.invalid"


def directories():
    """Returns where the helper is installed and where Firefox looks for its manifest."""
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        support = os.path.join(home, "Library", "Application Support")
        return (
            os.path.join(support, "localwarden"),
            os.path.join(support, "Mozilla", "NativeMessagingHosts"),
        )
    if sys.platform.startswith("linux"):
        data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
        return (
            os.path.join(data, "localwarden"),
            os.path.join(home, ".mozilla", "native-messaging-hosts"),
        )
    sys.exit(
        "This platform is not supported by the installer. See README.md for what it sets up."
    )


def write_json(path, content):
    with open(path, "w", encoding="utf-8") as file:
        json.dump(content, file, indent=2)
        file.write("\n")


def install(vault_folder, extension_id):
    host_directory, manifest_directory = directories()
    vault_folder = os.path.realpath(os.path.expanduser(vault_folder))
    os.makedirs(vault_folder, exist_ok=True)
    os.makedirs(host_directory, exist_ok=True)
    os.makedirs(manifest_directory, exist_ok=True)

    host = os.path.join(host_directory, HOST_FILE)
    shutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), HOST_FILE), host)
    os.chmod(host, os.stat(host).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    write_json(os.path.join(host_directory, CONFIG_FILE), {"vaultFolder": vault_folder})
    write_json(
        os.path.join(manifest_directory, HOST_NAME + ".json"),
        {
            "name": HOST_NAME,
            "description": "Keeps the local vault of the Localwarden extension in a folder",
            "path": host,
            "type": "stdio",
            "allowed_extensions": [extension_id],
        },
    )
    print("Vault folder: " + vault_folder)
    print("Helper:       " + host)
    print("Restart Firefox, or turn the extension off and on, for it to find the helper.")


def uninstall():
    host_directory, manifest_directory = directories()
    manifest = os.path.join(manifest_directory, HOST_NAME + ".json")
    if os.path.exists(manifest):
        os.remove(manifest)
    shutil.rmtree(host_directory, ignore_errors=True)
    print("The helper is removed. The vault folder is left as it is.")


def main():
    parser = argparse.ArgumentParser(description="Installs the Localwarden helper.")
    parser.add_argument("vault_folder", nargs="?", help="the folder to keep the vault in")
    parser.add_argument("--extension-id", default=EXTENSION_ID, help="the ID of the extension")
    parser.add_argument("--uninstall", action="store_true", help="remove the helper")
    arguments = parser.parse_args()
    if arguments.uninstall:
        uninstall()
    elif arguments.vault_folder:
        install(arguments.vault_folder, arguments.extension_id)
    else:
        parser.error("a vault folder is required")


if __name__ == "__main__":
    main()
