#!/bin/bash
# build-qa.sh — local-only QA build of Cipher (Skyfall)
#
# Usage:
#   cd ~/Documents/007\ Technologies/Skyfall
#   ./scripts/build-qa.sh
#
# Why this exists:
#   Cipher reads CUSTOMER_ID from config.json at runtime. When you build a
#   binary for a real customer (config.json has CUSTOMER_ID=soprema-davis,
#   say) and then install/run that binary on YOUR machine to QA it, every
#   telemetry event fires tagged as that customer. Real example:
#   April 30, what looked like Davis's first v1.3 launch in admin was
#   actually Reed's QA on his own MacBook — the matching hardware
#   fingerprint and platform=darwin (Davis is on Windows) gave it away.
#
#   This script prevents that by:
#   1. Backing up your existing config.json (timestamped, in scripts/.bak/)
#   2. Swapping CUSTOMER_ID in config.json to "dev-reed"
#   3. Running electron-builder LOCALLY (no --publish flag)
#   4. Restoring the original config.json — even if the build fails or
#      you Ctrl-C out partway through (trap on EXIT)
#
#   Result: a local Cipher binary in dist/ tagged as dev-reed, safe to
#   install on your machine. config.json on disk ends up exactly as it was.
#
# What this does NOT do:
#   - Doesn't push to GitHub Releases. QA binaries should never enter the
#     auto-update stream.
#   - Doesn't bump the version. Use the same version as production.
#   - Doesn't change the bundled Anthropic API key, R2 keys, or telemetry
#     endpoint — those are environmental config, not customer-specific.
#     Telemetry will still fire to the real /api/telemetry endpoint, just
#     tagged dev-reed instead of the customer ID.

set -e

# ── Colors ───────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
fail()  { echo -e "${RED}✗${NC} $1"; exit 1; }

# Find the Skyfall directory regardless of where the script is invoked from
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$PROJECT_ROOT"

CONFIG="$PROJECT_ROOT/config.json"
BAK_DIR="$PROJECT_ROOT/scripts/.bak"
BAK_FILE="$BAK_DIR/config.json.$(date +%Y%m%d-%H%M%S)"

if [ ! -f "$CONFIG" ]; then
  fail "config.json not found at $CONFIG. Are you in the Skyfall project directory?"
fi

# ── Backup + restore via trap ────────────────────────────────────────────
mkdir -p "$BAK_DIR"
cp "$CONFIG" "$BAK_FILE"
ok "Backed up config.json → $BAK_FILE"

# Trap restores the original config.json on ANY exit (success, failure,
# Ctrl-C). Without this, an interrupted build leaves config.json with
# CUSTOMER_ID=dev-reed, and your next production ship would silently
# tag as dev-reed — defeating the entire point of this script.
restore_config() {
  if [ -f "$BAK_FILE" ]; then
    cp "$BAK_FILE" "$CONFIG"
    ok "Restored config.json from backup"
  fi
}
trap restore_config EXIT

# ── Swap CUSTOMER_ID to dev-reed ─────────────────────────────────────────
# Use python to do the JSON edit so we don't depend on jq being installed.
python3 -c "
import json, sys
with open('$CONFIG') as f:
    cfg = json.load(f)
original = cfg.get('CUSTOMER_ID', '(unset)')
cfg['CUSTOMER_ID'] = 'dev-reed'
with open('$CONFIG', 'w') as f:
    json.dump(cfg, f, indent=2)
print(f'CUSTOMER_ID: {original} → dev-reed')
"
ok "config.json customer_id swapped to dev-reed"

# ── Build (no publish) ───────────────────────────────────────────────────
echo ""
echo "Building locally (no GitHub publish)..."
echo ""

# -m for mac arm64. Drop -w for now — most QA happens on the dev machine,
# Windows QA is rare and slower (Wine). Add --win to the flags below if
# you need a Windows QA binary.
npx electron-builder -m --arm64

ok "Build complete — artifacts in dist/"
ls -lh dist/*.dmg dist/*.zip 2>/dev/null | grep -v "blockmap" || true

# ── Done banner (config.json restored automatically by trap) ─────────────
echo ""
echo "╔═══════════════════════════════════════════════════════════════"
echo "║ CIPHER QA BUILD COMPLETE"
echo "║"
echo "║ Customer ID baked in: dev-reed"
echo "║ Telemetry will tag events as dev-reed in admin — safe for QA."
echo "║"
echo "║ Install one of the dist/ artifacts to test. Production config.json"
echo "║ has been restored on disk."
echo "╚═══════════════════════════════════════════════════════════════"
