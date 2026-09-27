# Production signature workflow — LOCKED / FROZEN

Controlled overlay of the staging-accepted signature workflow onto the
then-current live production baseline. Not a wholesale staging copy.

## Final accepted production pins

| Field | Value |
|---|---|
| Host | `https://checksops.com` |
| Entry | `/assets/index-BMBDIhiu.js` |
| Entry SHA256 | `6308df1089d59ef1bb0a6a1a2c58b2772a01b18f0d0279160d20b9b23730ac45` |
| CSS | `/assets/index-CP4SLJzh.css` |
| Index SHA256 | `d9e183e01851a7dd8624da1f7799073129cc0ca4e5934473016e65bcf3baacda` |
| index VersionId | `XHWR4PV16nnmR7RJ7q8JIqSBjxLzq7qx` |
| Last-Modified | `Sun, 27 Sep 2026 23:40:45 GMT` |
| CloudFront invalidation | `I38G4JC88LWXEMIN1AAQFZR2EC` |
| Lambda | `checksops-production-prep-api` |
| Lambda SHA before | `9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=` |
| Lambda SHA after | `gHoAYTlh/WLTAovN7/hfwuvmBNuMjKZaC+zMzBsAOSw=` |
| Live source SHA | `355e404b727f1ecad19da5f3ed55c94bf90298ad` |
| Overlay source SHA | `20b8177fafcb46adc9e1fe73f4ec7f01cbda95fd` |

## What was promoted

Existing production behavior plus accepted signature workflow plus the
completed-signature Resend guard. Financial/provider flags were not changed.
`aws_select_claims` was not changed.
