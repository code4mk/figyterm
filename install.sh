#!/bin/sh
#
# FigyTerm installer for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/code4mk/figyterm/main/install.sh | sh
#
# Why this exists: FigyTerm is not code-signed with an Apple Developer ID, so a
# .dmg downloaded through a browser gets flagged with com.apple.quarantine and
# macOS refuses to open it until you clear the flag by hand. Quarantine is set by
# the *downloading application* — browsers set it, curl does not. So downloading
# this way sidesteps Gatekeeper entirely: no security dialog, no `xattr` step.
#
# It only ever touches two things: a temporary directory, and FigyTerm.app in
# your applications folder. Read it before running it — you should read anything
# you pipe to a shell.
#
# Environment overrides:
#   FIGYTERM_VERSION       tag to install (default: latest release), e.g. v0.1.0
#   FIGYTERM_INSTALL_DIR   destination (default: /Applications)

set -eu

REPO="code4mk/figyterm"
APP_NAME="FigyTerm"
BINARY_NAME="figy-term"
INSTALL_DIR="${FIGYTERM_INSTALL_DIR:-/Applications}"
REQUESTED_VERSION="${FIGYTERM_VERSION:-latest}"

TMP_DIR=""
MOUNT_POINT=""

cleanup() {
  if [ -n "$MOUNT_POINT" ] && [ -d "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

step() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() { printf '\n\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

# --- Preflight ---------------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "FigyTerm is macOS only (found $(uname -s))."

case "$(uname -m)" in
  arm64)  ARCH_SUFFIX="aarch64" ; ARCH_LABEL="Apple Silicon" ;;
  x86_64) ARCH_SUFFIX="x64"     ; ARCH_LABEL="Intel" ;;
  *)      die "Unsupported architecture: $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required but was not found."
command -v hdiutil >/dev/null 2>&1 || die "hdiutil is required but was not found."

# Replacing a running app leaves it in a broken half-state, and FigyTerm may well
# have live terminal sessions in it. Refuse rather than kill someone's work.
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
DMG_NAME="${APP_NAME}_${VERSION}_${ARCH_SUFFIX}.dmg"
DMG_URL="https://github.com/$REPO/releases/download/$TAG/$DMG_NAME"

info "$APP_NAME $TAG ($ARCH_LABEL)"

# --- Download ----------------------------------------------------------------

TMP_DIR=$(mktemp -d) || die "Could not create a temporary directory."
DMG_PATH="$TMP_DIR/$DMG_NAME"

step "Downloading $DMG_NAME"
curl -fL --progress-bar "$DMG_URL" -o "$DMG_PATH" ||
  die "Download failed. Is $TAG a real release with a $ARCH_LABEL build?
       $DMG_URL"

# A 404 body saved as a .dmg would fail confusingly at mount time.
if [ ! -s "$DMG_PATH" ]; then
  die "The downloaded file is empty."
fi

# --- Install -----------------------------------------------------------------

step "Mounting the disk image"
# -nobrowse keeps it out of Finder, and an explicit private mountpoint avoids
# colliding with any volume already mounted as /Volumes/FigyTerm.
MOUNT_POINT="$TMP_DIR/mnt"
mkdir -p "$MOUNT_POINT"
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -readonly -quiet ||
  die "Could not mount $DMG_NAME."

[ -d "$MOUNT_POINT/$APP_NAME.app" ] ||
  die "$APP_NAME.app was not found inside the disk image."

[ -d "$INSTALL_DIR" ] || die "$INSTALL_DIR does not exist."

if [ -w "$INSTALL_DIR" ]; then
  SUDO=""
else
  SUDO="sudo"
  info "$INSTALL_DIR needs administrator access; you may be asked for your password."
fi

if [ -d "$INSTALL_DIR/$APP_NAME.app" ]; then
  step "Removing the previous version"
  $SUDO rm -rf "$INSTALL_DIR/$APP_NAME.app" ||
    die "Could not remove the existing $INSTALL_DIR/$APP_NAME.app."
fi

step "Installing to $INSTALL_DIR"
$SUDO cp -R "$MOUNT_POINT/$APP_NAME.app" "$INSTALL_DIR/" ||
  die "Could not copy $APP_NAME.app into $INSTALL_DIR."

# Belt and braces. curl does not set com.apple.quarantine, so there should be
# nothing to clear — but if the flag ever arrives by another route, this is what
# stops macOS from calling the app damaged.
$SUDO xattr -cr "$INSTALL_DIR/$APP_NAME.app" 2>/dev/null || true

hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
MOUNT_POINT=""

# --- Done --------------------------------------------------------------------

printf '\n\033[1;32m✓\033[0m %s %s installed to %s\n\n' "$APP_NAME" "$TAG" "$INSTALL_DIR"
info "Launch it from Spotlight, or run:  open -a $APP_NAME"
info "From here on, $APP_NAME updates itself — no need to run this again."
printf '\n'
