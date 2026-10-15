#!/usr/bin/env python3
"""The local vault helper of the decentralized Bitwarden browser extension.

A browser extension cannot reach a folder of the user by itself. The browser starts this program
for the extension and passes messages between the two (native messaging), and this program reads
and writes the files of the vault folder for it. The format of those files is not known here:
see docs/LOCAL_VAULT_FORMAT.md of the local vault (../local-vault-rs/). What it has to do with
them is checked by src/local-vault/browser/local-vault-helper.spec.ts.

The vault folder is read from `local_vault_host.json` next to this file, which `install.py`
writes. The extension cannot name another folder, and cannot reach anything outside of it.

A message is a JSON object with an `id`, an `op` and a `path`, which is a list of names relative
to the vault folder. The answer carries the same `id` and `ok`, and an `error` if `ok` is false.

    list    -> names    the entries of a directory, none if it does not exist
    exists  -> exists   whether there is a file or a directory
    read    -> found, data, done, version   `length` bytes from `offset`, as Base64
    write   <- offset, data, last   Base64 to write at `offset`; a file starts over at offset 0
    rename  <- newName -> done      within the same directory, replacing what is there
    delete  -> done     a file, or a directory with everything in it

The `version` of a file is another one once the file was replaced or changed. A file that is
read in several parts was read as it is only if all of the parts came with the same version.
"""

import base64
import json
import os
import re
import shutil
import struct
import sys

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_vault_host.json")

# The names that the local vault uses are made of these characters only.
SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# The browser does not deliver a message that is larger than 1 MB to the extension.
MAX_READ_BYTES = 512 * 1024
MAX_MESSAGE_BYTES = 64 * 1024 * 1024


def load_vault_folder():
    with open(CONFIG_FILE, encoding="utf-8") as config:
        folder = json.load(config)["vaultFolder"]
    folder = os.path.realpath(os.path.expanduser(folder))
    os.makedirs(folder, exist_ok=True)
    return folder


def resolve(vault_folder, path, allow_root=False):
    """Returns the file that the given list of names refers to, inside of the vault folder."""
    if not isinstance(path, list) or (not path and not allow_root):
        raise ValueError("invalid path")
    for name in path:
        if not isinstance(name, str) or not SAFE_NAME.match(name) or name in (".", ".."):
            raise ValueError("invalid path")
    target = os.path.join(vault_folder, *path)
    # A link inside of the vault folder must not lead out of it either.
    real_target = os.path.realpath(target)
    if real_target != vault_folder and not real_target.startswith(vault_folder + os.sep):
        raise ValueError("invalid path")
    return target


def sync_directory(directory):
    """Makes sure that a change of the entries of a directory is on storage."""
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def handle(vault_folder, message):
    op = message.get("op")
    if op == "list":
        directory = resolve(vault_folder, message.get("path"), allow_root=True)
        return {"names": sorted(os.listdir(directory)) if os.path.isdir(directory) else []}

    if op == "exists":
        return {"exists": os.path.lexists(resolve(vault_folder, message.get("path")))}

    if op == "read":
        target = resolve(vault_folder, message.get("path"))
        offset = int(message.get("offset", 0))
        length = max(0, min(int(message.get("length", MAX_READ_BYTES)), MAX_READ_BYTES))
        if offset < 0 or not os.path.isfile(target):
            return {"found": False}
        with open(target, "rb") as file:
            status = os.fstat(file.fileno())
            file.seek(offset)
            data = file.read(length)
            done = len(data) < length or file.read(1) == b""
        # Which file it is, its size and when it was changed: at least one of these is another
        # one after the file was replaced or changed.
        version = "%d-%d-%d" % (status.st_ino, status.st_size, status.st_mtime_ns)
        return {
            "found": True,
            "data": base64.b64encode(data).decode("ascii"),
            "done": done,
            "version": version,
        }

    if op == "write":
        target = resolve(vault_folder, message.get("path"))
        offset = int(message.get("offset", 0))
        data = base64.b64decode(message.get("data", ""), validate=True)
        if offset < 0:
            raise ValueError("invalid offset")
        if offset == 0:
            os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb" if offset == 0 else "r+b") as file:
            file.seek(offset)
            file.write(data)
            if message.get("last", True):
                file.flush()
                os.fsync(file.fileno())
        if offset == 0:
            sync_directory(os.path.dirname(target))
        return {}

    if op == "rename":
        source = resolve(vault_folder, message.get("path"))
        new_name = message.get("newName")
        if not os.path.lexists(source):
            return {"done": False}
        destination = resolve(vault_folder, message.get("path")[:-1] + [new_name])
        os.replace(source, destination)
        sync_directory(os.path.dirname(source))
        return {"done": True}

    if op == "delete":
        target = resolve(vault_folder, message.get("path"))
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        elif os.path.lexists(target):
            os.remove(target)
        sync_directory(os.path.dirname(target))
        return {"done": not os.path.lexists(target)}

    raise ValueError("unknown operation")


def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    if length > MAX_MESSAGE_BYTES:
        return None
    content = stream.read(length)
    if len(content) < length:
        return None
    return json.loads(content.decode("utf-8"))


def write_message(stream, message):
    content = json.dumps(message, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("=I", len(content)))
    stream.write(content)
    stream.flush()


def main():
    if sys.platform == "win32":
        import msvcrt

        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer

    try:
        vault_folder = load_vault_folder()
        failure = None
    except (OSError, ValueError, KeyError, TypeError) as error:
        vault_folder = None
        failure = "The vault folder is not set up: " + type(error).__name__

    while True:
        message = read_message(stdin)
        if message is None:
            return
        answer = {"id": message.get("id") if isinstance(message, dict) else None}
        try:
            if failure is not None:
                raise OSError(failure)
            answer.update(handle(vault_folder, message))
            answer["ok"] = True
        except (OSError, ValueError, TypeError, AttributeError) as error:
            # Only what kind of error it is: the extension has no use for the paths of this machine.
            answer = {"id": answer["id"], "ok": False, "error": failure or type(error).__name__}
        write_message(stdout, answer)


if __name__ == "__main__":
    main()
