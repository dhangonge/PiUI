#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
export PIUI_BUNDLE_ROOT="$ROOT"
if [ -f "$ROOT/runtime/termux-runtime" ]; then
  export LD_LIBRARY_PATH="$ROOT/runtime/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export SSL_CERT_FILE="$ROOT/runtime/etc/tls/cert.pem"
  export NODE_EXTRA_CA_CERTS="$ROOT/runtime/etc/tls/cert.pem"
fi
export PATH="$ROOT/runtime/bin:$PATH"
case "$(basename -- "$0")" in
  pi) exec "$ROOT/runtime/bin/node" "$ROOT/deploy/launcher.mjs" pi "$@" ;;
  *) exec "$ROOT/runtime/bin/node" "$ROOT/deploy/launcher.mjs" "$@" ;;
esac
