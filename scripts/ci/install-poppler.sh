#!/usr/bin/env bash
# Installs poppler-utils (pdftoppm) for the signature placement tests in AWS Migration CI.
#
# GitHub's Ubuntu runners resolve packages through /etc/apt/apt-mirrors.txt (azure.archive.ubuntu.com
# first). On 2026-11-11 from about 14:12 UTC that name stopped resolving on the runners, and every run
# died here before any test ran. This keeps the same package and the same failure when nothing works,
# but tries the default mirror list three times, then each public Ubuntu mirror below in turn (one
# mirror per attempt, written as the runner's own mirror list). It never skips the install: if no
# mirror works the step fails, so the tests never run without the rasterizer.
set -uo pipefail

PKG=poppler-utils
FALLBACK_MIRRORS=(
  "http://archive.ubuntu.com/ubuntu/"
  "http://mirrors.edge.kernel.org/ubuntu/"
  "http://mirror.math.princeton.edu/pub/ubuntu/"
)
MIRROR_LIST="${APT_MIRROR_LIST:-/etc/apt/apt-mirrors.txt}"
APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30)

install() {
  sudo apt-get "${APT_OPTS[@]}" update && sudo apt-get "${APT_OPTS[@]}" install -y --no-install-recommends "$PKG"
}

if command -v pdftoppm >/dev/null 2>&1; then
  echo "$PKG already installed"
  exit 0
fi

for attempt in 1 2 3; do
  if install; then echo "$PKG installed from the default mirrors (attempt $attempt)"; exit 0; fi
  echo "::warning::$PKG install from the default mirrors failed (attempt $attempt)"
  sleep $((attempt * ${INSTALL_RETRY_SLEEP_SECONDS:-15}))
done

if [ -f "$MIRROR_LIST" ]; then
  for mirror in "${FALLBACK_MIRRORS[@]}"; do
    echo "$mirror" | sudo tee "$MIRROR_LIST" >/dev/null
    if install; then echo "$PKG installed from fallback mirror $mirror"; exit 0; fi
    echo "::warning::$PKG install from $mirror failed"
  done
fi

echo "::error::$PKG could not be installed from any mirror; the signature placement tests need it"
exit 1
