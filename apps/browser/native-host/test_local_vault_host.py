"""Tests of the local vault helper: `python3 -m unittest` in this directory."""

import base64
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

HOST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "local_vault_host.py")


class LocalVaultHostTest(unittest.TestCase):
    def setUp(self):
        self.directory = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        self.vault = os.path.join(self.directory, "vault")
        self.outside = os.path.join(self.directory, "outside.txt")
        with open(self.outside, "w") as file:
            file.write("secret")
        # The helper reads the vault folder from the file next to it, as it does when installed.
        self.host = os.path.join(self.directory, "local_vault_host.py")
        shutil.copyfile(HOST, self.host)
        self.configure({"vaultFolder": self.vault})
        self.process = None
        self.next_id = 1

    def tearDown(self):
        if self.process is not None:
            self.process.stdin.close()
            self.process.wait(timeout=10)
            self.process.stdout.close()

    def configure(self, config):
        with open(os.path.join(self.directory, "local_vault_host.json"), "w") as file:
            json.dump(config, file)

    def call(self, op, path, **fields):
        if self.process is None:
            self.process = subprocess.Popen(
                [sys.executable, self.host], stdin=subprocess.PIPE, stdout=subprocess.PIPE
            )
        message = dict(fields, id=self.next_id, op=op, path=path)
        self.next_id += 1
        content = json.dumps(message).encode("utf-8")
        self.process.stdin.write(struct.pack("=I", len(content)) + content)
        self.process.stdin.flush()
        (length,) = struct.unpack("=I", self.process.stdout.read(4))
        self.assertLess(length, 1024 * 1024)
        answer = json.loads(self.process.stdout.read(length).decode("utf-8"))
        self.assertEqual(answer["id"], message["id"])
        return answer

    def write(self, path, content, **fields):
        data = base64.b64encode(content).decode("ascii")
        return self.call("write", path, offset=0, data=data, last=True, **fields)

    def read(self, path):
        answer = self.call("read", path, offset=0, length=1024 * 1024)
        return base64.b64decode(answer["data"]) if answer.get("found") else None

    def test_writes_reads_lists_renames_and_deletes(self):
        self.assertEqual(self.call("list", [])["names"], [])
        self.assertFalse(self.call("exists", ["account"])["exists"])
        self.assertIsNone(self.read(["account", "vault.json"]))

        self.assertTrue(self.write(["account", "vault.json.tmp"], b'{"a": 1}')["ok"])
        self.assertTrue(self.write(["account", "attachments", "cipher", "file"], b"\x00\xff")["ok"])
        self.assertEqual(self.read(["account", "vault.json.tmp"]), b'{"a": 1}')
        self.assertEqual(self.call("list", [])["names"], ["account"])
        self.assertEqual(
            self.call("list", ["account"])["names"], ["attachments", "vault.json.tmp"]
        )
        self.assertEqual(self.call("list", ["account", "vault.json.tmp"])["names"], [])
        self.assertTrue(self.call("exists", ["account", "attachments"])["exists"])

        renamed = self.call("rename", ["account", "vault.json.tmp"], newName="vault.json")
        self.assertTrue(renamed["done"])
        self.assertFalse(self.call("exists", ["account", "vault.json.tmp"])["exists"])
        self.assertEqual(self.read(["account", "vault.json"]), b'{"a": 1}')
        missing = self.call("rename", ["account", "vault.json.tmp"], newName="vault.json")
        self.assertEqual((missing["ok"], missing["done"]), (True, False))

        # A rename replaces what is there, and a write replaces the content.
        self.write(["account", "vault.json.tmp"], b"{}")
        self.call("rename", ["account", "vault.json.tmp"], newName="vault.json")
        self.assertEqual(self.read(["account", "vault.json"]), b"{}")
        self.write(["account", "vault.json"], b"")
        self.assertEqual(self.read(["account", "vault.json"]), b"")

        self.assertTrue(self.call("delete", ["account", "attachments"])["done"])
        self.assertTrue(self.call("delete", ["account", "missing"])["done"])
        self.assertEqual(self.call("list", ["account"])["names"], ["vault.json"])
        self.assertTrue(self.call("delete", ["account"])["done"])
        self.assertTrue(os.path.isdir(self.vault))
        self.assertEqual(os.listdir(self.vault), [])

    def test_moves_large_files_in_parts_that_fit_a_message(self):
        content = os.urandom(1300 * 1024)
        part = 512 * 1024
        for offset in range(0, len(content), part):
            data = base64.b64encode(content[offset : offset + part]).decode("ascii")
            last = offset + part >= len(content)
            answer = self.call("write", ["account", "file"], offset=offset, data=data, last=last)
            self.assertTrue(answer["ok"])

        received = b""
        while True:
            answer = self.call("read", ["account", "file"], offset=len(received), length=part)
            received += base64.b64decode(answer["data"])
            if answer["done"]:
                break
        self.assertEqual(received, content)
        # However much is asked for, an answer stays below what the browser delivers.
        answer = self.call("read", ["account", "file"], offset=0, length=10 * 1024 * 1024)
        self.assertEqual(len(base64.b64decode(answer["data"])), part)
        self.assertFalse(answer["done"])
        end = self.call("read", ["account", "file"], offset=len(content), length=part)
        self.assertEqual((end["found"], end["data"], end["done"]), (True, "", True))

    def test_tells_the_parts_of_a_file_from_those_of_one_that_replaced_it(self):
        path = ["account", "vault.json"]
        target = os.path.join(self.vault, "account", "vault.json")
        self.write(path, b"a" * 20)
        first = self.call("read", path, offset=0, length=10)
        second = self.call("read", path, offset=10, length=10)
        self.assertEqual(first["version"], second["version"])

        # A tool that syncs the vault folder puts another file in the place of the vault.
        with open(target + ".sync", "wb") as file:
            file.write(b"b" * 20)
        os.replace(target + ".sync", target)
        replaced = self.call("read", path, offset=10, length=10)
        self.assertEqual(base64.b64decode(replaced["data"]), b"b" * 10)
        self.assertNotEqual(replaced["version"], first["version"])

        # Another one writes to the file that is there.
        with open(target, "ab") as file:
            file.write(b"c")
        changed = self.call("read", path, offset=10, length=10)
        self.assertNotEqual(changed["version"], replaced["version"])

    def test_reaches_nothing_outside_of_the_vault_folder(self):
        self.write(["account", "vault.json"], b"{}")
        os.symlink(self.outside, os.path.join(self.vault, "account", "link"))
        os.symlink(self.directory, os.path.join(self.vault, "linked"))
        paths = [
            [".."],
            ["..", "outside.txt"],
            ["account", "..", "..", "outside.txt"],
            ["account/../../outside.txt"],
            [self.outside],
            ["account", ""],
            ["account", "a b"],
            ["account", 1],
            "account",
            ["account", "link"],
            ["linked", "outside.txt"],
        ]
        for path in paths:
            for op in ("read", "exists", "delete", "list"):
                answer = self.call(op, path, offset=0, length=10)
                self.assertFalse(answer["ok"], (op, path))
            self.assertFalse(self.write(path, b"changed")["ok"], path)
            self.assertFalse(self.call("rename", path, newName="x")["ok"], path)
        self.assertFalse(
            self.call("rename", ["account", "vault.json"], newName="../../moved")["ok"]
        )
        # The vault folder itself can be listed, and nothing else can be done to it.
        for op in ("read", "exists", "delete"):
            self.assertFalse(self.call(op, [], offset=0, length=10)["ok"])
        self.assertFalse(self.write([], b"")["ok"])
        self.assertFalse(self.call("unknown", ["account"])["ok"])

        with open(self.outside) as file:
            self.assertEqual(file.read(), "secret")
        self.assertEqual(self.read(["account", "vault.json"]), b"{}")

    def test_answers_every_request_with_an_error_without_a_vault_folder(self):
        self.configure({})

        answer = self.call("list", [])

        self.assertEqual(answer["ok"], False)
        self.assertIn("not set up", answer["error"])
        self.assertFalse(self.call("exists", ["account"])["ok"])


if __name__ == "__main__":
    unittest.main()
