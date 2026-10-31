#!/bin/bash
# Android 开发辅助脚本：确保 Android SDK / NDK 环境变量就绪后启动 `tauri android dev`。
#
# 按需覆盖，例如：
#   ANDROID_HOME=/opt/android-sdk NDK_HOME=/opt/android-sdk/ndk/29.0.14206865 ./scripts/dev-android.sh
set -euo pipefail

: "${ANDROID_HOME:?请设置 ANDROID_HOME（Android SDK 根目录）}"

NDK_VERSION="${NDK_VERSION:-29.0.14206865}"
if [ -z "${NDK_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk/$NDK_VERSION" ]; then
  export NDK_HOME="$ANDROID_HOME/ndk/$NDK_VERSION"
fi

export PATH="$HOME/.cargo/bin:$PATH"

echo "ANDROID_HOME=$ANDROID_HOME"
if [ -n "${NDK_HOME:-}" ]; then
  echo "NDK_HOME=$NDK_HOME"
fi

echo "Checking connected Android devices..."
adb devices

echo "Starting Tauri Android Dev..."
npm run tauri android dev
