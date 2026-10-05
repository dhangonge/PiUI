#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
case "$ROOT" in
  /sdcard/*|/storage/*|/mnt/media_rw/*)
    echo 'Android shared storage cannot execute this runtime. Extract the archive under Termux HOME, then run this script again.' >&2
    exit 1 ;;
esac
sh "$ROOT/piui" doctor
exec sh "$ROOT/piui" start "$@"
