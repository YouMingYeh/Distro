#!/usr/bin/env bash
# Distro CLI installer.
#   curl -fsSL https://trydistro.app/install.sh | bash
# Optional: DISTRO_VERSION=cli-v0.1.0 (default: latest release), DISTRO_INSTALL_DIR (default: ~/.local/bin)
set -euo pipefail

REPO="YouMingYeh/Distro"
DIR="${DISTRO_INSTALL_DIR:-$HOME/.local/bin}"
fail() { echo "install: $1" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS: $(uname -s) (macOS and Linux only)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=amd64 ;;
  *) fail "unsupported CPU: $(uname -m)" ;;
esac

asset="distro-$os-$arch"
if [ -n "${DISTRO_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$DISTRO_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading $asset..."
curl -fsSL "$base/$asset" -o "$tmp/$asset" || fail "download failed: $base/$asset"
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt" || fail "download failed: $base/checksums.txt"

# Refuse to install a binary that does not match the published checksum.
want="$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/checksums.txt")"
[ -n "$want" ] || fail "no checksum published for $asset"
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
else
  got="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
fi
[ "$got" = "$want" ] || fail "checksum mismatch for $asset"

mkdir -p "$DIR"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$DIR/distro"
echo "Installed distro $("$DIR/distro" version) to $DIR/distro"

case ":$PATH:" in
  *":$DIR:"*) echo "Next: distro login" ;;
  *) echo "Add it to your PATH, then run 'distro login':"
     echo "  export PATH=\"$DIR:\$PATH\"" ;;
esac
