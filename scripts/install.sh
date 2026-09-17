#!/bin/sh
set -eu

REPOSITORY="Gao327/codex-chatgpt-web"
if [ -n "${CODEX_CHATGPT_WEB_REPOSITORY:-}" ] && [ "$CODEX_CHATGPT_WEB_REPOSITORY" != "$REPOSITORY" ]; then
  echo "Updates are locked to $REPOSITORY; repository overrides are forbidden" >&2
  exit 1
fi
VERSION="${CODEX_CHATGPT_WEB_VERSION:-5.0.1}"
BIN_DIR="${CODEX_CHATGPT_WEB_BIN_DIR:-$HOME/.local/bin}"
LIB_DIR="${CODEX_CHATGPT_WEB_LIB_DIR:-$HOME/.local/lib/codex-chatgpt-web}"
DOC_DIR="${CODEX_CHATGPT_WEB_DOC_DIR:-$HOME/.local/share/doc/codex-chatgpt-web}"

# Keep this helper self-contained: the installer also runs directly through sh.
# GitHub may deliver this fork's assets from its CDN, but may not change repositories.
download_from_fork() (
  DOWNLOAD_URL="$1"
  DOWNLOAD_PATH="$2"
  DOWNLOAD_TIMEOUT="$3"
  DOWNLOAD_KIND="$4"
  DOWNLOAD_STATUS="$(curl --disable --fail --silent --show-error \
    --retry 3 --retry-all-errors --connect-timeout 15 --max-time "$DOWNLOAD_TIMEOUT" \
    --proto '=https' --max-redirs 0 --dump-header "$DOWNLOAD_PATH.headers" \
    --output "$DOWNLOAD_PATH" --write-out '%{http_code}' "$DOWNLOAD_URL")" || return 1
  if [ "$DOWNLOAD_STATUS" = "200" ]; then return 0; fi
  case "$DOWNLOAD_STATUS:$DOWNLOAD_KIND" in
    301:asset|302:asset|303:asset|307:asset|308:asset) ;;
    *) echo "Fork download failed with HTTP $DOWNLOAD_STATUS; repository redirects are forbidden" >&2; return 1 ;;
  esac
  DOWNLOAD_REDIRECT="$(awk 'tolower(substr($0, 1, 9)) == "location:" { sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); location = $0 } END { print location }' "$DOWNLOAD_PATH.headers")"
  if ! printf '%s\n' "$DOWNLOAD_REDIRECT" | grep -Eq '^https://release-assets\.githubusercontent\.com/github-production-release-asset/1357573628/[A-Za-z0-9_-]+(\?[^[:space:]#]*)?$'; then
    echo "Refusing a release redirect outside Gao327/codex-chatgpt-web" >&2
    return 1
  fi
  DOWNLOAD_STATUS="$(curl --disable --fail --silent --show-error \
    --retry 3 --retry-all-errors --connect-timeout 15 --max-time "$DOWNLOAD_TIMEOUT" \
    --proto '=https' --max-redirs 0 --output "$DOWNLOAD_PATH" \
    --write-out '%{http_code}' "$DOWNLOAD_REDIRECT")" || return 1
  if [ "$DOWNLOAD_STATUS" != "200" ]; then
    echo "Fork asset download failed with HTTP $DOWNLOAD_STATUS; further redirects are forbidden" >&2
    return 1
  fi
)

VERSION="${VERSION#v}"
case "$VERSION" in
  ""|[!0-9]*|*[!A-Za-z0-9._-]*) echo "Invalid release version: $VERSION" >&2; exit 1 ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The terminal-only installer supports macOS only; use the desktop launcher on Windows or Linux" >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="amd64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

ASSET="codex-chatgpt-web-darwin-$ARCH.tar.gz"
BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-chatgpt-web.XXXXXX")"
STAGE_DIR="$LIB_DIR/.stage-$VERSION-$$"
TARGET_DIR="$LIB_DIR/$VERSION"
BACKUP_DIR="$LIB_DIR/.previous-$VERSION-$$"
trap 'rm -rf "$TEMP_DIR" "$STAGE_DIR"' EXIT HUP INT TERM

download_from_fork "$BASE_URL/$ASSET" "$TEMP_DIR/$ASSET" 900 asset
download_from_fork "$BASE_URL/checksums.txt" "$TEMP_DIR/checksums.txt" 60 asset

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
ACTUAL="$(shasum -a 256 "$TEMP_DIR/$ASSET" | awk '{ print $1 }')"
if [ -z "$EXPECTED" ] || [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "SHA-256 verification failed for $ASSET" >&2
  exit 1
fi

for DOC in LICENSE Bun-1.4.0.md THIRD_PARTY_NOTICES.txt; do
  download_from_fork "$BASE_URL/$DOC" "$TEMP_DIR/$DOC" 60 asset
  DOC_EXPECTED="$(awk -v asset="$DOC" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
  DOC_ACTUAL="$(shasum -a 256 "$TEMP_DIR/$DOC" | awk '{ print $1 }')"
  if [ -z "$DOC_EXPECTED" ] || [ "$DOC_ACTUAL" != "$DOC_EXPECTED" ]; then
    echo "SHA-256 verification failed for $DOC" >&2
    exit 1
  fi
done

mkdir -p "$LIB_DIR" "$BIN_DIR" "$DOC_DIR"
mkdir "$STAGE_DIR"
tar -xzf "$TEMP_DIR/$ASSET" -C "$STAGE_DIR"
if [ ! -x "$STAGE_DIR/bin/codex-chatgpt-web" ] || [ ! -x "$STAGE_DIR/runtime/bun" ]; then
  echo "Runtime archive is incomplete" >&2
  exit 1
fi
if [ "$("$STAGE_DIR/bin/codex-chatgpt-web" --version)" != "$VERSION" ]; then
  echo "Runtime archive version does not match $VERSION" >&2
  exit 1
fi

if [ -e "$TARGET_DIR" ]; then
  mv "$TARGET_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGE_DIR" "$TARGET_DIR"; then
  if [ -e "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$TARGET_DIR"; fi
  exit 1
fi

ln -sfn "$TARGET_DIR/bin/codex-chatgpt-web" "$BIN_DIR/.codex-chatgpt-web.next"
mv -f "$BIN_DIR/.codex-chatgpt-web.next" "$BIN_DIR/codex-chatgpt-web"
rm -f "$BIN_DIR/codex-chatgpt-web.legacy-standalone"
for DOC in LICENSE Bun-1.4.0.md THIRD_PARTY_NOTICES.txt; do
  install -m 0644 "$TEMP_DIR/$DOC" "$DOC_DIR/$DOC"
done
if [ -e "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; fi

echo "Installed $TARGET_DIR"
if [ "$#" -gt 0 ]; then
  "$TARGET_DIR/bin/codex-chatgpt-web" setup "$@"
  exit 0
fi
echo "Next: $BIN_DIR/codex-chatgpt-web setup --browser-only --acknowledge-unofficial"
