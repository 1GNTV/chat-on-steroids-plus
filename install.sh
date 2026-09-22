#!/usr/bin/env sh
set -eu

REPO_URL="https://github.com/1GNTV/chat-on-steroids-plus.git"
INSTALL_DIR="${COS_PLUS_HOME:-$HOME/.chat-on-steroids-plus}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[cos-plus] Missing dependency: $1" >&2
    exit 1
  }
}

need git
need node
need npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[cos-plus] Node.js 20 or newer is required (found $(node -v))." >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[cos-plus] Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth 1 origin main
  git -C "$INSTALL_DIR" checkout -q main
  git -C "$INSTALL_DIR" reset --hard origin/main
elif [ -e "$INSTALL_DIR" ]; then
  echo "[cos-plus] $INSTALL_DIR already exists and is not a git checkout." >&2
  exit 1
else
  echo "[cos-plus] Downloading Chat On Steroids Plus"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

echo "[cos-plus] Installing the lightweight host CLI"
npm install --global "$INSTALL_DIR/agent-bridge"

cos-plus --help >/dev/null

echo ""
echo "COS+ installed successfully."
echo ""
echo "Open your project and run:"
echo "  cos-plus start ."
echo ""
echo "COS+ will print one command to paste into ChatGPT."
