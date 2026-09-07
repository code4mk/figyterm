#!/bin/sh
#
# FigyTerm installer for Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install-linux.sh | sh
#
# Installs the AppImage build. Of the three Linux formats FigyTerm publishes, the
# AppImage is the one that updates itself: a .deb or .rpm install belongs to your
# package manager, and the app will not rewrite files it doesn't own. Prefer the
# distro package if you'd rather your package manager stayed in charge — this
# script is for people who want the self-updating build.
#
# It touches a temporary directory, the install directory below, and one
# .desktop file. Read it before running it — you should read anything you pipe
# to a shell.
#
# Environment overrides:
#   FIGYTERM_VERSION       tag to install (default: latest release), e.g. v0.1.0
#   FIGYTERM_INSTALL_DIR   destination (default: ~/.local/bin)

set -eu

REPO="code4mk/figyterm"
APP_NAME="FigyTerm"
BINARY_NAME="figy-term"
INSTALL_DIR="${FIGYTERM_INSTALL_DIR:-$HOME/.local/bin}"
REQUESTED_VERSION="${FIGYTERM_VERSION:-latest}"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/512x512/apps"

TMP_DIR=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

step() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# --- Preflight ---------------------------------------------------------------

[ "$(uname -s)" = "Linux" ] || die "This installer is for Linux (found $(uname -s)).
       On macOS, use install.sh instead."

case "$(uname -m)" in
  x86_64) ARCH_SUFFIX="amd64" ;;
  aarch64 | arm64) die "No arm64 Linux build is published yet. Building from source is
       documented in docs/CONTRIBUTING.md." ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required but was not found."

# Replacing the AppImage under a running process leaves it in a broken state,
# and FigyTerm may well have live terminal sessions in it.
if pgrep -x "$BINARY_NAME" >/dev/null 2>&1 || pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  die "$APP_NAME is running. Quit it first, then run this again."
fi

# --- Resolve the version -----------------------------------------------------

if [ "$REQUESTED_VERSION" = "latest" ]; then
  step "Finding the latest release"
  TAG=$(
    curl -fsSL -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
      head -n1
  ) || die "Could not reach the GitHub API. Check your connection and try again."
  [ -n "$TAG" ] || die "Could not determine the latest version."
else
  TAG="$REQUESTED_VERSION"
fi

VERSION="${TAG#v}"
IMAGE_NAME="${APP_NAME}_${VERSION}_${ARCH_SUFFIX}.AppImage"
IMAGE_URL="https://github.com/$REPO/releases/download/$TAG/$IMAGE_NAME"

info "$APP_NAME $TAG (x86_64)"

# --- Download ----------------------------------------------------------------

TMP_DIR=$(mktemp -d) || die "Could not create a temporary directory."
IMAGE_PATH="$TMP_DIR/$IMAGE_NAME"

step "Downloading $IMAGE_NAME"
curl -fL --progress-bar "$IMAGE_URL" -o "$IMAGE_PATH" ||
  die "Download failed. Is $TAG a real release with a Linux build?
       $IMAGE_URL"

# A 404 body saved as an AppImage would fail confusingly at launch.
[ -s "$IMAGE_PATH" ] || die "The downloaded file is empty."

# --- Install -----------------------------------------------------------------

mkdir -p "$INSTALL_DIR" || die "Could not create $INSTALL_DIR."

# A stable filename, so the .desktop entry doesn't need rewriting on every
# update and the app's own updater has one path to replace.
TARGET="$INSTALL_DIR/$BINARY_NAME"

step "Installing to $TARGET"
cp "$IMAGE_PATH" "$TARGET" || die "Could not write $TARGET."
chmod +x "$TARGET" || die "Could not make $TARGET executable."

# The icon comes out of the AppImage itself, so the desktop entry has something
# to show without shipping a second download.
step "Adding a desktop entry"
mkdir -p "$DESKTOP_DIR" "$ICON_DIR"

(
  cd "$TMP_DIR" && "$TARGET" --appimage-extract "usr/share/icons/hicolor/512x512/apps/*.png" >/dev/null 2>&1
) || true

EXTRACTED_ICON=$(find "$TMP_DIR/squashfs-root" -name '*.png' 2>/dev/null | head -n1 || true)
if [ -n "$EXTRACTED_ICON" ]; then
  cp "$EXTRACTED_ICON" "$ICON_DIR/$BINARY_NAME.png" 2>/dev/null || true
  ICON_VALUE="$BINARY_NAME"
else
  # No icon is a cosmetic loss, not a reason to fail the install.
  ICON_VALUE="utilities-terminal"
fi

cat > "$DESKTOP_DIR/$BINARY_NAME.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=A modern terminal with autocomplete superpowers
Exec=$TARGET
Icon=$ICON_VALUE
Terminal=false
Categories=System;TerminalEmulator;
Keywords=terminal;shell;command;console;prompt;autocomplete;
DESKTOP

command -v update-desktop-database >/dev/null 2>&1 &&
  update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

# --- Done --------------------------------------------------------------------

printf '\n\033[1;32m✓\033[0m %s %s installed to %s\n\n' "$APP_NAME" "$TAG" "$TARGET"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) info "Launch it from your app menu, or run:  $BINARY_NAME" ;;
  *)
    info "Launch it from your app menu, or run:  $TARGET"
    info "$INSTALL_DIR is not on your PATH — add it to use the short name."
    ;;
esac

info "From here on, $APP_NAME updates itself — no need to run this again."
info "If the window comes up blank, start it with WEBKIT_DISABLE_DMABUF_RENDERER=1."
printf '\n'
