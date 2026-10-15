#!/usr/bin/env bash
#
# Builds the local vault, which is the submodule local-vault-rs, as WebAssembly in
# local-vault-rs/pkg: a package that the local server imports, with a build for webpack
# ("module") and one for Node, where Jest runs it ("main").
#
# Run it before building the extension or running its tests, and again when the submodule
# changes. It needs Rust, with the target wasm32-unknown-unknown, and wasm-pack: see "Building"
# in README.md.

set -euo pipefail

browser="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workspace="$browser/local-vault-rs"
crate="$workspace/crates/local-vault-wasm"
package="$workspace/pkg"

if [ ! -f "$crate/Cargo.toml" ]; then
  echo "local-vault-rs is not checked out: run git submodule update --init" >&2
  exit 1
fi

# Outside of apps/browser, which Jest goes through file by file, and where nothing larger than
# 5 MB may be for Firefox.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$browser/../../node_modules/.cache/local-vault-rs}"

rm -rf "$package"
# Where Rust is run with the toolchain of rust-toolchain.toml.
cd "$workspace"
wasm-pack build "$crate" --release --no-pack --target bundler --out-dir "$package/bundler"
wasm-pack build "$crate" --release --no-pack --target nodejs --out-dir "$package/node"

cat >"$package/package.json" <<'EOF'
{
  "name": "local-vault-wasm",
  "private": true,
  "main": "node/local_vault_wasm.js",
  "module": "bundler/local_vault_wasm.js",
  "types": "bundler/local_vault_wasm.d.ts",
  "sideEffects": ["./bundler/local_vault_wasm.js"]
}
EOF
