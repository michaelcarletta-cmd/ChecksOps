#!/usr/bin/env bash
# Installs poppler-utils (pdftoppm) for the signature placement tests in AWS Migration CI.
#
# GitHub's Ubuntu runners resolve packages through /etc/apt/apt-mirrors.txt (azure.archive.ubuntu.com
# first). On 2026-11-11 from about 14:12 UTC that name stopped resolving on the runners, and every run
# died here before any test ran. Each apt attempt against a name that does not resolve spends minutes
# in DNS timeouts (a 20-minute job ran out after two), so every mirror's host is checked first with
# getent, which fails fast: the default mirror list is tried (twice) only while its first host
# resolves, then each public Ubuntu mirror below whose host resolves, written as the runner's own
# mirror list. The same package; it never skips the install: if no mirror works the step fails, so
# the tests never run without the rasterizer.
set -uo pipefail

PKG=poppler-utils
FALLBACK_MIRRORS=(
  "http://archive.ubuntu.com/ubuntu/"
  "http://mirrors.edge.kernel.org/ubuntu/"
  "http://mirror.math.princeton.edu/pub/ubuntu/"
)
MIRROR_LIST="${APT_MIRROR_LIST:-/etc/apt/apt-mirrors.txt}"
APT_OPTS=(-o Acquire::Retries=2 -o Acquire::http::Timeout=20)

install() {
  sudo apt-get "${APT_OPTS[@]}" update && sudo apt-get "${APT_OPTS[@]}" install -y --no-install-recommends "$PKG"
}
host_of() { local url="$1"; url="${url#*://}"; echo "${url%%/*}"; }
resolves() { getent hosts "$1" >/dev/null 2>&1; }

if command -v pdftoppm >/dev/null 2>&1; then
  echo "$PKG already installed"
  exit 0
fi

default_host=""
if [ -f "$MIRROR_LIST" ]; then
  default_host="$(host_of "$(grep -m1 -E '^[a-z]+://' "$MIRROR_LIST" || true)")"
fi
if [ -z "$default_host" ] || resolves "$default_host"; then
  for attempt in 1 2; do
    if install; then echo "$PKG installed from the default mirrors (attempt $attempt)"; exit 0; fi
    echo "::warning::$PKG install from the default mirrors failed (attempt $attempt)"
    sleep $((attempt * ${INSTALL_RETRY_SLEEP_SECONDS:-15}))
  done
else
  echo "::warning::default mirror host $default_host does not resolve; skipping to the fallback mirrors"
fi

if [ -f "$MIRROR_LIST" ]; then
  for mirror in "${FALLBACK_MIRRORS[@]}"; do
    host="$(host_of "$mirror")"
    if ! resolves "$host"; then echo "::warning::fallback mirror host $host does not resolve"; continue; fi
    echo "$mirror" | sudo tee "$MIRROR_LIST" >/dev/null
    if install; then echo "$PKG installed from fallback mirror $mirror"; exit 0; fi
    echo "::warning::$PKG install from $mirror failed"
  done
fi

echo "::error::$PKG could not be installed from any mirror; the signature placement tests need it"
exit 1
