#!/usr/bin/env bash
# Installs the browser Exhibit drives. Used by the GitHub Action and by this repository's own tests.
#
# `playwright install --with-deps` also installs system packages with apt on every run. GitHub's
# runner images already have the libraries Chromium needs, so that step only added a dependency on
# the Ubuntu package mirrors: when they could not be reached (2026-11-11), every run failed before
# it started. Now the browser is installed first, and apt is asked only if the browser cannot start.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --filter @exhibit/core exec playwright install chromium

if pnpm --filter @exhibit/core exec node scripts/check-browser.mjs; then
  echo "Chromium starts on this machine; no system packages needed."
else
  echo "Installing the system packages Chromium needs…"
  pnpm --filter @exhibit/core exec playwright install-deps chromium
  pnpm --filter @exhibit/core exec node scripts/check-browser.mjs
fi
