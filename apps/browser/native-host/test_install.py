"""Tests of the installer of the helper: `python3 -m unittest` in this directory."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import install  # noqa: E402

INSTALL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "install.py")

# Takes the place of flatpak, and keeps what it is asked to do in a file. The overrides are in a
# key file in $FLATPAK_USER_DIR, as flatpak writes them. As with flatpak, the sandbox reaches a
# folder if the closest of it and the folders that it is in that has an entry is allowed. It then
# runs what the sandbox is given with the Python of the test.
FAKE_FLATPAK = r"""
import json, os, re, subprocess, sys

with open(os.environ["FAKE_FLATPAK_STATE"], encoding="utf-8") as file:
    state = json.load(file)
arguments = sys.argv[1:]
state["calls"].append(arguments)
with open(os.environ["FAKE_FLATPAK_STATE"], "w", encoding="utf-8") as file:
    json.dump(state, file)

overrides = os.path.join(os.environ["FLATPAK_USER_DIR"], "overrides", "org.mozilla.firefox")
lines = open(overrides, encoding="utf-8").read().split("\n") if os.path.exists(overrides) else []
index, items, group, context = None, [], None, None
for number, line in enumerate(lines):
    group = line if line.startswith("[") else group
    context = number if line == "[Context]" else context
    if group == "[Context]" and line.startswith("filesystems="):
        index, items = number, re.findall(r"(?:[^;\\]|\\.)+", line[len("filesystems="):])
entries = [re.sub(r"\\(.)", r"\1", item) for item in items]

def folder(entry):
    return re.sub(r":(ro|rw|create)$", "", entry.lstrip("!"))

status = 0
if arguments[0] == "info":
    status = 0 if state["installed"] else 1
elif arguments[0] == "override" and arguments[2] == "--show":
    print("\n".join(lines), end="")
elif arguments[0] == "override":
    option, path = arguments[2].split("=", 1)
    item = path.replace("\\", "\\\\").replace(";", "\\;")
    item = item if option == "--filesystem" else "!" + item
    items = [item if folder(entry) == path else old for old, entry in zip(items, entries)]
    items += [] if item in items else [item]
    line = "filesystems=" + "".join(item + ";" for item in items)
    if context is None:
        lines[:0] = ["[Context]", line] + ([""] if lines else [])
    elif index is None:
        lines.insert(context + 1, line)
    else:
        lines[index] = line
    os.makedirs(os.path.dirname(overrides), exist_ok=True)
    with open(overrides, "w", encoding="utf-8") as file:
        file.write("\n".join(lines) + ("" if lines[-1] == "" else "\n"))
elif arguments[0] == "run":
    path = closest = arguments[-1]
    allowed = {folder(entry): not entry.startswith("!") and not entry.endswith(":ro")
               for entry in entries}
    while closest not in allowed and closest != "/":
        closest = os.path.dirname(closest)
    if not (allowed.get(closest) and state["sandboxWorks"]):
        path = os.path.join(path, "not in the sandbox")
    status = subprocess.run([sys.executable, "-c", arguments[4], path]).returncode
if status:
    print("error: it failed", file=sys.stderr)
sys.exit(status)
"""


@unittest.skipUnless(sys.platform.startswith("linux"), "the directories are those of Linux")
class InstallTest(unittest.TestCase):
    def setUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)
        self.app = os.path.join(self.home, ".var", "app", "org.mozilla.firefox")
        self.config = os.path.join(self.app, "data", "localwarden", "local_vault_host.json")
        self.manifest = os.path.join(
            self.app, ".mozilla", "native-messaging-hosts", "localwarden.json"
        )
        # Out of the home directory, which the tests look through.
        self.tools = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tools, ignore_errors=True)
        flatpak = os.path.join(self.tools, "flatpak")
        with open(flatpak, "w", encoding="utf-8") as file:
            file.write("#!" + sys.executable + "\n" + FAKE_FLATPAK)
        os.chmod(flatpak, 0o755)
        self.user_directory = os.path.join(self.tools, "user")
        self.overrides = os.path.join(self.user_directory, "overrides", "org.mozilla.firefox")
        self.state_file = os.path.join(self.tools, "state.json")
        self.set_state()

    def set_state(self, installed=True, sandbox_works=True):
        with open(self.state_file, "w", encoding="utf-8") as file:
            json.dump({"installed": installed, "sandboxWorks": sandbox_works, "calls": []}, file)

    def calls(self):
        return self.read_json(self.state_file)["calls"]

    def write_overrides(self, content):
        os.makedirs(os.path.dirname(self.overrides), exist_ok=True)
        with open(self.overrides, "w", encoding="utf-8") as file:
            file.write(content)

    def read_overrides(self):
        with open(self.overrides, encoding="utf-8") as file:
            return file.read()

    def install(self, *arguments, check=True):
        environment = dict(
            os.environ,
            HOME=self.home,
            PATH=self.tools + os.pathsep + os.environ.get("PATH", ""),
            FLATPAK_USER_DIR=self.user_directory,
            FAKE_FLATPAK_STATE=self.state_file,
        )
        environment.pop("XDG_DATA_HOME", None)
        return subprocess.run(
            [sys.executable, INSTALL, *arguments],
            env=environment,
            capture_output=True,
            text=True,
            check=check,
        )

    def read_json(self, *path):
        with open(os.path.join(*path), encoding="utf-8") as file:
            return json.load(file)

    def test_installs_for_firefox_from_flathub_in_the_directory_of_the_app(self):
        vault = os.path.join(self.home, "Sync", "vault")
        self.install("--flatpak", vault)

        helper = os.path.join(self.app, "data", "localwarden", "local_vault_host.py")
        manifest = self.read_json(self.manifest)
        self.assertEqual(manifest["path"], helper)
        self.assertEqual(manifest["allowed_extensions"], ["localwarden@local.invalid"])
        self.assertTrue(os.access(helper, os.X_OK))
        self.assertEqual(
            self.read_json(self.config), {"vaultFolder": vault, "flatpakOverride": True}
        )
        self.assertTrue(os.path.isdir(vault))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".mozilla")))
        self.assertFalse(os.path.exists(os.path.join(self.home, ".local")))
        self.assertEqual(self.read_overrides(), "[Context]\nfilesystems=%s;\n" % vault)

    def test_takes_back_only_the_entries_that_it_added(self):
        others = (
            "[Context]\nsockets=x11;\nfilesystems=xdg-music;/srv/a\\;b;~/Music:ro;\n\n"
            "[Environment]\nFOO=bar\n"
        )
        self.write_overrides(others)
        old = os.path.join(self.home, "old vault")
        new = os.path.join(self.home, "new;vault")
        self.install("--flatpak", old)
        self.install("--flatpak", new)
        self.assertEqual(
            self.read_overrides(),
            others.replace("~/Music:ro;", "~/Music:ro;%s;" % new.replace(";", "\\;")),
        )

        self.install("--flatpak", "--uninstall")
        self.assertEqual(self.read_overrides(), others)
        self.assertNotIn("--nofilesystem", json.dumps(self.calls()))
        self.assertFalse(os.path.exists(os.path.join(self.app, "data", "localwarden")))
        self.assertFalse(os.path.exists(self.manifest))
        self.assertTrue(os.path.isdir(new))

    def test_removes_the_list_of_filesystems_when_nothing_else_is_in_it(self):
        self.install("--flatpak", os.path.join(self.home, "vault"))
        self.install("--flatpak", "--uninstall")
        self.assertEqual(self.read_overrides(), "[Context]\n")

    def test_allows_a_folder_that_firefox_from_flathub_reached_through_the_one_from_before(self):
        sync = os.path.join(self.home, "Sync")
        vault = os.path.join(sync, "vault")
        self.install("--flatpak", sync)
        self.install("--flatpak", vault)
        self.assertEqual(self.read_overrides(), "[Context]\nfilesystems=%s;\n" % vault)
        self.assertEqual(self.read_json(self.config)["flatpakOverride"], True)

    def test_leaves_alone_what_firefox_from_flathub_could_reach_before(self):
        sync = os.path.join(self.home, "Sync")
        vault = os.path.join(sync, "vault")
        self.write_overrides("[Context]\nfilesystems=%s;\n" % sync)
        self.install("--flatpak", vault)
        self.assertEqual(self.read_json(self.config), {"vaultFolder": vault})

        self.install("--flatpak", "--uninstall")
        self.assertEqual(self.read_overrides(), "[Context]\nfilesystems=%s;\n" % sync)
        self.assertNotIn("filesystem=", json.dumps(self.calls()))

    def test_does_not_change_an_entry_of_the_user_for_the_vault_folder(self):
        vault = os.path.join(self.home, "vault")
        self.write_overrides("[Context]\nfilesystems=!%s;\n" % vault)
        result = self.install("--flatpak", vault, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("have an entry for the vault folder", result.stderr)
        self.assertFalse(os.path.exists(self.manifest))
        self.assertEqual(self.read_overrides(), "[Context]\nfilesystems=!%s;\n" % vault)

    def test_unregisters_the_helper_if_the_sandbox_does_not_reach_the_folder(self):
        old = os.path.join(self.home, "old")
        new = os.path.join(self.home, "new")
        self.install("--flatpak", old)
        self.set_state(sandbox_works=False)

        result = self.install("--flatpak", new, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not reach the vault folder", result.stderr)
        self.assertFalse(os.path.exists(self.manifest))
        self.assertEqual(self.read_overrides(), "[Context]\nfilesystems=%s;\n" % old)
        self.assertEqual(self.read_json(self.config)["vaultFolder"], old)

    def test_does_not_register_the_helper_without_firefox_from_flathub(self):
        self.set_state(installed=False)
        result = self.install("--flatpak", os.path.join(self.home, "vault"), check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("flatpak info: error: it failed", result.stderr)
        self.assertFalse(os.path.exists(self.manifest))
        self.assertEqual(self.calls(), [["info", "org.mozilla.firefox"]])

    def test_installs_for_firefox_from_the_distribution_without_flatpak(self):
        output = self.install(os.path.join(self.home, "vault")).stdout

        manifest = self.read_json(
            self.home, ".mozilla", "native-messaging-hosts", "localwarden.json"
        )
        self.assertEqual(
            manifest["path"],
            os.path.join(self.home, ".local", "share", "localwarden", "local_vault_host.py"),
        )
        self.assertFalse(os.path.exists(os.path.join(self.home, ".var")))
        self.assertNotIn("Flathub", output)
        self.assertEqual(self.calls(), [])


@unittest.skipUnless(shutil.which("flatpak"), "flatpak is not installed")
class FlatpakOverridesTest(unittest.TestCase):
    """What the installer does to the overrides, with flatpak itself in a user installation of
    the test, which does not need Firefox for that."""

    def setUp(self):
        self.directory = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        environment = mock.patch.dict(os.environ, {"FLATPAK_USER_DIR": self.directory})
        environment.start()
        self.addCleanup(environment.stop)

    def override(self, *options):
        return install.run_flatpak("override", "--user", *options, install.FLATPAK_APP)

    def test_takes_back_only_the_entry_that_it_added(self):
        self.override(
            "--socket=x11",
            "--env=FOO=bar",
            "--filesystem=xdg-music",
            "--filesystem=/srv/a;b",
            "--filesystem=~/Music:ro",
        )
        before = self.override("--show")
        vault = os.path.join(self.directory, "my;vault")
        self.override("--filesystem=" + vault)
        self.assertIn(vault, install.override_entries())

        install.disallow_folder(vault)
        self.assertEqual(self.override("--show"), before)


if __name__ == "__main__":
    unittest.main()
