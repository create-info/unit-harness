#!/usr/bin/env bash
# UnitHarness installer (Linux / macOS)
#   curl -fsSL https://raw.githubusercontent.com/create-info/unit-harness/main/install.sh | bash
set -euo pipefail

REPO="create-info/unit-harness"
BIN_DIR="${UH_INSTALL_DIR:-$HOME/.local/bin}"
TAG="${UH_VERSION:-latest}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux) target=linux ;;
  darwin) target=darwin ;;
  *) echo "unsupported OS: $os — on Windows use install.ps1"; exit 1 ;;
esac

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "unsupported architecture: $arch"; exit 1 ;;
esac

name="uh-${target}-${arch}"
if [ "$TAG" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${name}"
else
  url="https://github.com/${REPO}/releases/download/${TAG}/${name}"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "→ downloading $name"
if ! curl -fsSL "$url" -o "$tmp/uh"; then
  echo "download failed: $url" >&2
  echo "no release yet? build from source instead:" >&2
  echo "  git clone https://github.com/${REPO} && cd unit-harness && npm i -g ." >&2
  exit 1
fi

if curl -fsSL "${url}.sha256" -o "$tmp/uh.sha256" 2>/dev/null; then
  expected=$(awk '{print $1}' "$tmp/uh.sha256")
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$tmp/uh" | awk '{print $1}')
  else
    actual=$(shasum -a 256 "$tmp/uh" | awk '{print $1}')
  fi
  if [ "$expected" != "$actual" ]; then
    echo "checksum mismatch — refusing to install" >&2
    exit 1
  fi
  echo "→ checksum ok"
fi

mkdir -p "$BIN_DIR"
install -m 755 "$tmp/uh" "$BIN_DIR/uh"
ln -sf uh "$BIN_DIR/unitai" 2>/dev/null || true

echo "→ installed $BIN_DIR/uh ($("$BIN_DIR/uh" --version))"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo ""; echo "add to PATH:"; echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
