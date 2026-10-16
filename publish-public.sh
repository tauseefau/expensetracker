#!/usr/bin/env bash
#
# Publish scrubbed expense-tracker source to the PUBLIC repo (expensetracker).
# Reads canonical (raw) source from ../expense-tracker, scrubs personal data,
# syncs into THIS repo, commits and pushes to origin (github.com:tauseefau/expensetracker).
#
# The private repo (exptrack) keeps the raw source; this repo is the scrubbed
# public mirror. Run after every commit you want public.
#
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../expense-tracker" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"

# --- 1. Copy tracked source (respecting .gitignore: no .env, node_modules, dist, storage) ---
# Use git ls-files from the canonical repo so only *tracked* files come over.
cd "$SRC"
mapfile -t FILES < <(git ls-files)
cd "$HERE"

# Clear previous contents (keep .git + this script).
find . -mindepth 1 -maxdepth 1 ! -name '.git' ! -name 'publish-public.sh' -exec rm -rf {} +

# Copy tracked files preserving structure.
for f in "${FILES[@]}"; do
  mkdir -p "$(dirname "$f")"
  cp "$SRC/$f" "$f"
done

# --- 2. Scrub personal data ---
# 2a. Absolute server path in systemd unit -> generic placeholder.
if [ -f infra/expense-tracker.service ]; then
  sed -i 's#/home/ubuntu/git-repos/expense-tracker/backend#/opt/expense-tracker/backend#g' infra/expense-tracker.service
fi

# 2b. Real personal email hardcoded as default recipient -> neutral placeholder.
sed -i 's/Tauseefau@live\.com/you@example.com/g' \
  backend/src/config/index.ts \
  backend/src/services/email.ts 2>/dev/null || true

# 2c. Scrub any surviving absolute /home/ubuntu paths anywhere.
find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' -o -name '*.sql' -o -name '*.service' -o -name '*.include' -o -name '*.md' \) \
  -exec sed -i 's#/home/ubuntu#/opt/app#g' {} + 2>/dev/null || true

# --- 3. Add a note about this being the scrubbed public mirror ---
cat > PUBLIC-MIRROR.md <<'EOF'
# Public mirror (scrubbed)

This is the **scrubbed public mirror** of the expense-tracker project.
Deploy-specific and personal details are replaced with placeholders:

- Server paths: `/home/ubuntu/...` → `/opt/app/...`
- Personal contact email hardcoded as default → `you@example.com`

The authoritative repository (with real deployment config) is private and is
not published here. See the LICENSE for usage terms.
EOF

# --- 4. Commit + push ---
git add -A
git status --short | sed -n '1,15p'
if git diff --cached --quiet; then
  echo "[publish] nothing changed to sync"
else
  git commit -m "sync from canonical @ $(cd "$SRC" && git rev-parse --short HEAD): scrub personal data for public mirror"
fi
git push -u origin main 2>&1 | tail -5
echo "[publish] done -> https://github.com/tauseefau/expensetracker"