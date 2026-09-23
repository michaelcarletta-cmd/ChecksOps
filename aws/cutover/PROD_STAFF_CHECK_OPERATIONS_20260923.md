# Production staff check operations — 2026-09-23

Frozen components were not reopened. SES, CheckAlt E14, and Moov were not touched.

## Identity

| Field | Value |
|---|---|
| Email | `mcarletta@freedomadj.com` |
| Auth | Existing Cognito EMAIL_OTP (`/prep/auth/passwordless/verify` 200) |
| `/prep/identity/me` | 200, `mappingStatus=active` |
| Application user | `7dbb3009-f059-4767-b5dc-1c5c72379330` |
| Roles | `admin` |
| Tenant | Freedom Adjustment `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a` (`freedom`), role `admin` |

`claims@` was not added. Tester was not used. No identity mapping or role changes.

## Safe check

`0000549229` / `64fca2df-c57a-4f13-b7c4-9dfe52e860e4`  
Tina Levine, USAA, `$1492.47`, stage `review`, status `needs_review`, claim `034882580`.  
Front and rear images present. Not deposited.

## Acceptance

| Step | Result |
|---|---|
| Checks page | `/freedom/checks` loaded; Review lane; check in Manual Review Queue |
| Review Check | Panel `Review Check #0000549229` |
| Images | Front and rear loaded through production AWS path |
| Claim | `034882580` linked; not relinked |
| Descriptive save | `property_address` allowlisted field; marker persisted after reload |
| Restore | Address restored to `5 Waltham Way, Jackson, NJ, 08527`; amount/status unchanged |
| Endorsement UI | Review routing + Deposit Packet payees/endorsements view rendered; Endorsing button not clicked |

## Not done

No deposit, CheckAlt, auto-advance flag change, ACH/RTP/wire, Moov, SES, customer email, new check upload, amount/routing/account edits.
