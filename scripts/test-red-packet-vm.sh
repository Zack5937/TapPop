#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -x .tools/cargo/bin/cargo ]; then
  export CARGO_HOME="$PWD/.tools/cargo"
  export RUSTUP_HOME="$PWD/.tools/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
# Pin the VM-compatible architecture and compiler; this does not deploy.
cargo build-sbf --manifest-path programs/red-packet/Cargo.toml --arch v0 --tools-version v1.57 --jobs 4
cargo test --locked --package tap-pay-red-packet --test lifecycle --jobs 4 -- --ignored
