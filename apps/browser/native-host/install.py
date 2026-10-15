#!/usr/bin/env python3
"""Installs the local vault helper for Firefox and sets the vault folder.

    python3 install.py [--flatpak] <vault folder>
    python3 install.py [--flatpak] --uninstall

The vault folder is the folder that the accounts are kept in, one directory each. To share a
vault with another device, choose the folder that a tool such as Syncthing keeps in sync with it.
Run this again to change the folder; log out in the extension first, as what it has cached
belongs to the vault of the old folder.

Pass `--flatpak` for Firefox from Flathub, which starts the helper in its sandbox. This then also
allows the sandbox to reach the vault folder, unless it could already, and takes that back when
the folder changes or the helper is removed.
"""

import argparse
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys

HOST_NAME = "localwarden"
HOST_FILE = "local_vault_host.py"
CONFIG_FILE = "local_vault_host.json"

# The ID of the extension, from `browser_specific_settings` in its manifest.
EXTENSION_ID = "localwarden@local.invalid"

# Firefox from Flathub. Of the home directory, its sandbox reaches the directory of the app in
# ~/.var/app, which it also sees as ~/.mozilla, and the folders that it is allowed to.
FLATPAK_APP = "org.mozilla.firefox"

# What the Python of that sandbox, which also runs the helper, is given: which folder the path is
# there and whether it can be written to, if the sandbox reaches it at all.
SANDBOX_CHECK = """
import os, sys
try:
    status = os.stat(sys.argv[1])
    print(status.st_dev, status.st_ino, os.access(sys.argv[1], os.W_OK))
except OSError:
    print("-")
"""


class FlatpakError(Exception):
    pass


def directories(flatpak):
    """Returns where the helper is installed and where Firefox looks for its manifest."""
    home = os.path.expanduser("~")
    if flatpak:
        if not sys.platform.startswith("linux"):
            sys.exit("Flatpak is only available on Linux.")
        app = os.path.join(home, ".var", "app", FLATPAK_APP)
        return (
            os.path.join(app, "data", "localwarden"),
            os.path.join(app, ".mozilla", "native-messaging-hosts"),
        )
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


def read_config(host_directory):
    """Returns the config of the helper in the given directory, or an empty one."""
    try:
        with open(os.path.join(host_directory, CONFIG_FILE), encoding="utf-8") as config:
            content = json.load(config)
    except (OSError, ValueError):
        return {}
    return content if isinstance(content, dict) else {}


def allowed_folder(config):
    """Returns the folder that this allowed Firefox from Flathub to reach, or None."""
    folder = config.get("vaultFolder")
    if config.get("flatpakOverride") is True and isinstance(folder, str) and os.path.isabs(folder):
        return folder
    return None


def run_flatpak(*arguments):
    """Runs flatpak with the given arguments, and returns what it printed."""
    try:
        result = subprocess.run(
            ["flatpak", *arguments],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise FlatpakError("flatpak %s: %s" % (arguments[0], error)) from None
    if result.returncode != 0:
        lines = result.stderr.strip().splitlines() or ["exit status %d" % result.returncode]
        raise FlatpakError("flatpak %s: %s" % (arguments[0], lines[-1]))
    return result.stdout


def sandbox_reaches(folder):
    """Returns whether the sandbox of Firefox from Flathub can write to the folder, as the same
    folder that it is outside of the sandbox."""
    output = run_flatpak("run", "--command=python3", FLATPAK_APP, "-c", SANDBOX_CHECK, folder)
    status = os.stat(folder)
    return output.split()[-3:] == [str(status.st_dev), str(status.st_ino), "True"]


def context_filesystems(lines):
    """Returns the index of the line that lists the filesystems in the Context group of a key file
    of flatpak overrides, and the items of that list as they are written, in which a ; is \\;.
    Without such a line, returns None and none."""
    group = None
    for index, line in enumerate(lines):
        if line.startswith("["):
            group = line.strip()
            continue
        match = re.match(r"filesystems\s*=(.*)", line)
        if group == "[Context]" and match:
            return index, re.findall(r"(?:[^;\\]|\\.)+", match.group(1))
    return None, []


def unescape(item):
    escapes = {"s": " ", "n": "\n", "t": "\t", "r": "\r"}
    return re.sub(r"\\(.)", lambda match: escapes.get(match.group(1), match.group(1)), item)


def override_entries():
    """Returns what the overrides of the user list for Firefox from Flathub to reach, or not."""
    output = run_flatpak("override", "--user", "--show", FLATPAK_APP)
    return [unescape(item) for item in context_filesystems(output.split("\n"))[1]]


def entry_folder(entry):
    """Returns the folder that an entry of the overrides, such as !~/Sync or /srv/vault:ro, is
    about, or the entry itself if it is not about one."""
    folder = re.sub(r":(ro|rw|create)$", "", entry.lstrip("!"))
    return os.path.realpath(os.path.expanduser(folder)) if folder.startswith(("/", "~")) else folder


def remove_override(folder):
    """Removes the entry that allow_folder added for the folder from the file that flatpak keeps
    the overrides of the user in, which flatpak-override(1) says where it is, and nothing else."""
    home = os.path.expanduser("~")
    data = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    user_directory = os.environ.get("FLATPAK_USER_DIR") or os.path.join(data, "flatpak")
    path = os.path.join(user_directory, "overrides", FLATPAK_APP)
    with open(path, encoding="utf-8") as file:
        lines = file.read().split("\n")
    index, items = context_filesystems(lines)
    kept = [item for item in items if unescape(item) != folder]
    if len(kept) == len(items):
        return
    if kept:
        lines[index] = "filesystems=" + "".join(item + ";" for item in kept)
    else:
        del lines[index]
    temporary = path + ".localwarden"
    with open(temporary, "w", encoding="utf-8") as file:
        file.write("\n".join(lines))
    shutil.copymode(path, temporary)
    os.replace(temporary, path)


def allow_folder(folder):
    # Taking this back removes the entry for the folder, so there must not be one already: that
    # would be one of the user, which does not let Firefox write to the folder.
    if any(entry_folder(entry) == folder for entry in override_entries()):
        raise FlatpakError(
            "the overrides of the user (flatpak override --user --show %s) have an entry for the "
            "vault folder, with which its sandbox does not reach it" % FLATPAK_APP
        )
    run_flatpak("override", "--user", "--filesystem=" + folder, FLATPAK_APP)
    if not sandbox_reaches(folder):
        disallow_folder(folder)
        raise FlatpakError("its sandbox does not reach the vault folder even when allowed to")


def disallow_folder(folder):
    """Takes back what allow_folder allowed, by removing the entry that it added. Flatpak has no
    command for that: `--nofilesystem` adds an entry that says that Firefox is not to reach the
    folder, which is what this falls back to if the entry is still there."""
    try:
        remove_override(folder)
    except OSError:
        pass
    if folder in override_entries():
        run_flatpak("override", "--user", "--nofilesystem=" + folder, FLATPAK_APP)


def allow_flatpak(vault_folder, old_folder):
    """Makes sure that Firefox from Flathub reaches the vault folder, and takes back that this
    allowed it to reach the folder from before (old_folder, or None). Returns whether this is
    what allows it to reach the vault folder."""
    run_flatpak("info", FLATPAK_APP)
    allowed = old_folder == vault_folder
    if not sandbox_reaches(vault_folder):
        allow_folder(vault_folder)
        allowed = True
    if old_folder not in (None, vault_folder):
        disallow_folder(old_folder)
        # The vault folder may be in the old one, and have been reached through it.
        if not allowed and not sandbox_reaches(vault_folder):
            allow_folder(vault_folder)
            allowed = True
    return allowed


def install(vault_folder, extension_id, flatpak):
    host_directory, manifest_directory = directories(flatpak)
    vault_folder = os.path.realpath(os.path.expanduser(vault_folder))
    old_folder = allowed_folder(read_config(host_directory)) if flatpak else None
    os.makedirs(vault_folder, exist_ok=True)
    os.makedirs(host_directory, exist_ok=True)
    os.makedirs(manifest_directory, exist_ok=True)
    manifest = os.path.join(manifest_directory, HOST_NAME + ".json")

    config = {"vaultFolder": vault_folder}
    if flatpak:
        try:
            if allow_flatpak(vault_folder, old_folder):
                config["flatpakOverride"] = True
        except FlatpakError as error:
            # Without the manifest, Firefox does not start a helper that may not reach the folder.
            if os.path.exists(manifest):
                os.remove(manifest)
            sys.exit("Firefox from Flathub could not be set up, so the helper is not: %s" % error)

    host = os.path.join(host_directory, HOST_FILE)
    shutil.copyfile(os.path.join(os.path.dirname(os.path.abspath(__file__)), HOST_FILE), host)
    os.chmod(host, os.stat(host).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    write_json(os.path.join(host_directory, CONFIG_FILE), config)
    write_json(
        manifest,
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
    if flatpak:
        if old_folder not in (None, vault_folder):
            print("Firefox from Flathub is no longer allowed to reach " + old_folder)
        if "flatpakOverride" in config:
            print("Firefox from Flathub is allowed to reach the vault folder, until --uninstall.")
        else:
            print("Firefox from Flathub could reach the vault folder already.")
        print("Close Firefox and start it again, for it to find the helper and reach the folder.")
    else:
        print("Restart Firefox, or turn the extension off and on, for it to find the helper.")


def uninstall(flatpak):
    host_directory, manifest_directory = directories(flatpak)
    folder = allowed_folder(read_config(host_directory)) if flatpak else None
    manifest = os.path.join(manifest_directory, HOST_NAME + ".json")
    if os.path.exists(manifest):
        os.remove(manifest)
    shutil.rmtree(host_directory, ignore_errors=True)
    print("The helper is removed. The vault folder is left as it is.")
    if folder is not None:
        try:
            disallow_folder(folder)
            print("Firefox from Flathub is no longer allowed to reach it.")
        except FlatpakError as error:
            print("Firefox from Flathub is still allowed to reach it (%s), until:" % error)
            print(
                "  flatpak override --user --nofilesystem=%s %s"
                % (shlex.quote(folder), FLATPAK_APP)
            )


def main():
    parser = argparse.ArgumentParser(description="Installs the Localwarden helper.")
    parser.add_argument("vault_folder", nargs="?", help="the folder to keep the vault in")
    parser.add_argument("--extension-id", default=EXTENSION_ID, help="the ID of the extension")
    parser.add_argument("--uninstall", action="store_true", help="remove the helper")
    parser.add_argument(
        "--flatpak", action="store_true", help="for Firefox from Flathub (%s)" % FLATPAK_APP
    )
    arguments = parser.parse_args()
    if arguments.uninstall:
        uninstall(arguments.flatpak)
    elif arguments.vault_folder:
        install(arguments.vault_folder, arguments.extension_id, arguments.flatpak)
    else:
        parser.error("a vault folder is required")


if __name__ == "__main__":
    main()
