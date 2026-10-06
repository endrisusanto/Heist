#!/usr/bin/env bash
# ponytail: Automated Release Pipeline for Heist Fleet
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ./release.sh [patch|minor|major] [commit message]

Examples:
  ./release.sh
  ./release.sh patch "Fix device bridge auto-reconnect"
  ./release.sh minor "Add dynamic preflight diagnostics"

Environment Variables:
  REMOTE   Git remote name (default: origin)
  BRANCH   Git target branch (default: main)
  REPO_URL Repository URL (default: https://github.com/endrisusanto/Heist)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

BUMP="${1:-patch}"
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "ERROR: bump must be one of: patch, minor, major" >&2
  usage >&2
  exit 1
fi

COMMIT_MESSAGE="${2:-chore(release): bump version and publish artifacts}"
REMOTE="${REMOTE:-origin}"
PREFIX="v"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

CURRENT_BRANCH="$(git branch --show-current || true)"
BRANCH="${BRANCH:-${CURRENT_BRANCH:-main}}"

echo "=================================================="
echo " Heist Fleet Release Pipeline"
echo " Remote : $REMOTE"
echo " Branch : $BRANCH"
echo " Bump   : $BUMP"
echo "=================================================="

git fetch "$REMOTE" --tags --prune >/dev/null 2>&1 || true

LOCAL_TAGS="$(git tag --list "${PREFIX}[0-9]*.[0-9]*.[0-9]*" || true)"
REMOTE_TAGS="$(git ls-remote --tags --refs "$REMOTE" "${PREFIX}[0-9]*.[0-9]*.[0-9]*" 2>/dev/null \
  | awk '{print $2}' \
  | sed 's#refs/tags/##' || true)"

LATEST_TAG="$(printf '%s\n%s\n' "$LOCAL_TAGS" "$REMOTE_TAGS" \
  | sed '/^$/d' \
  | sort -V \
  | tail -n 1 || true)"

if [[ -z "$LATEST_TAG" ]]; then
  LATEST_TAG="${PREFIX}0.1.0"
fi

VERSION="${LATEST_TAG#"$PREFIX"}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

case "$BUMP" in
  major)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  minor)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  patch)
    PATCH=$((PATCH + 1))
    ;;
esac

NEXT_VERSION="${MAJOR}.${MINOR}.${PATCH}"
NEXT_TAG="${PREFIX}${NEXT_VERSION}"

echo "[Release] Current Version : $LATEST_TAG"
echo "[Release] Next Version    : $NEXT_TAG"

# Update Cargo.toml, package.json, and tauri.conf.json
sed -i -E "0,/version = \"[0-9]+\.[0-9]+\.[0-9]+\"/s/version = \"[0-9]+\.[0-9]+\.[0-9]+\"/version = \"${NEXT_VERSION}\"/" bridge/Cargo.toml
sed -i -E "0,/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"${NEXT_VERSION}\"/" package.json
sed -i -E "0,/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"${NEXT_VERSION}\"/" bridge/tauri.conf.json

# Build .deb locally
chmod +x ./build-deb.sh
./build-deb.sh

# Stage all files
git add -A

# Commit if there are changes
if git diff --cached --quiet; then
  echo "[Release] No uncommitted changes, tagging current HEAD."
else
  git commit -m "chore(release): $NEXT_TAG - $COMMIT_MESSAGE"
fi

# Create annotated tag
git tag -a "$NEXT_TAG" -m "Heist Release $NEXT_TAG"

echo "[Release] Pushing $BRANCH to $REMOTE..."
git push "$REMOTE" "HEAD:$BRANCH" || true

echo "[Release] Pushing tag $NEXT_TAG to trigger GitHub Actions build..."
git push "$REMOTE" "$NEXT_TAG" || true

echo "=================================================="
echo " Release $NEXT_TAG Dispatched Successfully!"
echo " Repository: https://github.com/endrisusanto/Heist/releases/tag/$NEXT_TAG"
echo "=================================================="
