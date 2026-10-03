#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -x .tools/cargo/bin/cargo ]; then
  export CARGO_HOME="$PWD/.tools/cargo"
  export RUSTUP_HOME="$PWD/.tools/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
fixture_tmp="$(mktemp)"
trap 'rm -f "$fixture_tmp"' EXIT
# The committed fixture uses the undeployed test ID, independent of deployment builds.
env -u RED_PACKET_PROGRAM_ID cargo run --locked --quiet --example mobile_abi > "$fixture_tmp"
cmp "$fixture_tmp" apps/mobile/tests/fixtures/red-packet-abi.json
