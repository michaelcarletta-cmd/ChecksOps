# Dependency vulnerability triage, 2026-11-06 (row V-1; risk R11)

**Prepared:** 2026-11-06 by Claude from `npm audit --package-lock-only` on every lockfile at main
`87723e8a`. The session's GitHub token cannot read Dependabot alerts (403 "Resource not accessible
by integration"), so the audit read the same lockfiles Dependabot scans.
**Matches GitHub's count:** 13 open alerts (2 high, 7 moderate, 4 low), as GitHub reported on push
the same day.
**Reviewer:** Michael Carletta, CEO, signs off below.

## Where they are

| Lockfile | What it builds | Alerts |
|---|---|---|
| `aws/functions/api/package-lock.json` | **The production API** (Lambda `checksops-production-prep-api`) | **0** |
| `aws/identity/oneshot/`, `aws/rls/oneshot/` | One-shot database tools | 0 |
| `package-lock.json` / `bun.lock` (root) | The website (SPA) and its build tools | 11 |
| `mobile/package-lock.json` | The mobile app's build tooling (Capacitor CLI) | 2 |

The server that holds the data and moves money has no known vulnerable dependency.

## Each alert

"Reaches users" means the vulnerable code is in the JavaScript a user's browser runs. Build and
lint tools run only on a developer machine or in CI, and their output is the compiled site.

| # | Package | Advisory | Severity | Pulled in by | Reaches users? | Decision |
|---|---|---|---|---|---|---|
| 1 | `xlsx` 0.18.5 (SheetJS) | GHSA-4r6h-8v6p-xvw6 prototype pollution when reading a crafted file | High | Direct: Settings → Import (`src/components/settings/ImportSettings.tsx`) and the deposited-checks export (`src/lib/depositedChecksExport.ts`) | **Yes**, in the signed-in user's own browser, when they import a spreadsheet they chose. No server impact. | **Fix.** No fixed version exists on npm. Either replace it with `exceljs` (already a dependency) or install SheetJS 0.20.3 from its own CDN. The CDN is blocked from this session's network, so `exceljs` is the practical route. A website change, through the guarded upload. |
| 2 | `xlsx` | GHSA-5pgg-2g8v-p4x9 ReDoS | High | Same | Yes, same path (can only freeze the user's own tab) | Same fix as #1 |
| 3 | `fflate` 0.8.2 | GHSA-px8p-9vwx-vf98 infinite loop on a malformed ZIP in `unzipSync` | Moderate | `jspdf` (PDF export) | No: jspdf compresses; it never unzips untrusted input | **Fix** (patch 0.8.3, no API change) with the next lockfile refresh |
| 4 | `uuid` 8.3.2 | GHSA-w5hq-g745-h8pq bounds check in v3/v5/v6 with a caller buffer | Moderate | `exceljs` | No: exceljs calls `v4()` without a buffer | **Accept** until exceljs moves past uuid 8; recheck monthly |
| 5 | `uuid` (mobile) | Same advisory | Moderate | `@capacitor/cli` → `xcode` (build tool) | No | **Fix:** `@capacitor/cli` 8.6.0 (minor) |
| 6 | `glob` 10.x | GHSA-3g3m-2fjr-6pw4 | Moderate | `workbox-build` (vite-plugin-pwa), `sucrase` (build) | No | **Accept** (build only); clears with the vite-plugin-pwa upgrade |
| 7 | `minimatch` | GHSA-g3hv-75wg-m249 ReDoS | Moderate | `eslint`, `typescript-eslint` (lint) | No | **Accept** (dev only); clears with the next ESLint major upgrade |
| 8 | `postcss-selector-parser` 6.0.10 | GHSA-rj75-hqrm-r3gf | Moderate | `@tailwindcss/typography` (CSS build) | No | **Accept** (build only) |
| 9 | `yaml` 2.6.0 | GHSA-48c2-rrv3-qjmp stack overflow on deep nesting | Moderate | `vite`, `postcss-load-config` (build config) | No | **Fix** (patch 2.8.3) with the next lockfile refresh |
| 10 | `@babel/core` | GHSA-4x5r-pxfx-6jf8 file read via sourceMappingURL | Low | Build | No | **Fix** (patch) with the next lockfile refresh |
| 11 | `@tootallnate/once` | GHSA-vpq2-c234-7xj6 | Low | Test tooling (jsdom) | No | **Fix** (patch) with the next lockfile refresh |
| 12 | `deepmerge` | GHSA-gcqx-w48m-w2h4 prototype pollution | Low | `workbox-build` (build) | No | **Accept** (build only) |
| 13 | `postcss-selector-parser` | GHSA-w9m9-85wc-3x92 | Low | `@tailwindcss/typography` (build) | No | **Accept** (build only) |

## Result

- **2 alerts reach users** (#1–2, `xlsx`, high). Impact is limited to the signed-in user's own
  browser tab while importing a file they chose. Risk R11 stays **medium**. Fix target: 2026-11-30.
- **5 alerts can be fixed without a breaking change** (#3, #5, #9, #10, #11): a lockfile refresh.
- **6 are build or dev tools only** (#4, #6, #7, #8, #12, #13): accepted, recheck monthly with V-1.

## Follow-ups

1. Replace `xlsx` with `exceljs` in the two files above, with tests; ship through staging, then the
   guarded production website upload. Closes #1–2.
2. Refresh the lockfiles (`bun.lock` and `package-lock.json`) for the patch fixes, plus
   `mobile/package-lock.json` for `@capacitor/cli` 8.6.0. Closes #3, #5, #9, #10, #11.
3. Give the session's GitHub integration Dependabot read access, or export the alert list each
   month, so the V-1 record can cite GitHub's own list.

Reviewed by: ______________________ (Michael Carletta, CEO)  Date: __________
