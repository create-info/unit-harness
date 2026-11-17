#!/usr/bin/env bash
# UnitHarness installer (Linux / macOS)
#   curl -fsSL https://raw.githubusercontent.com/create-info/unit-harness/master/install.sh | bash
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

# 目前只发布 macOS arm64：GitHub 的 Intel mac runner（macos-13）已退役，
# darwin-x64 不再构建。Intel Mac 上给一条明确的出路，而不是让人对着 404 猜。
if [ "$target" = "darwin" ] && [ "$arch" = "x64" ]; then
  echo "no prebuilt binary for Intel macOS (darwin-x64)" >&2
  echo "build from source instead:" >&2
  echo "  git clone https://github.com/${REPO} && cd unit-harness && npm i -g ." >&2
  exit 1
fi

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
