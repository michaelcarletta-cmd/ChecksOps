# End-to-end AWS staging results (Tranche 5)

Synthetic Freedom check walked from intake through READY FOR PROVIDER EXECUTION.

This document is completed after live validation (`scripts/aws-workflow-tranche5-validate.mjs`) and financial before/after capture.

Expected path:

1. `POST /workflow/checks` → `uploaded` / `review`
2. Upload front image to `checks/{id}/` (T3 S3)
3. Descriptive edit + payee + note
4. `start_review` → `needs_review`
5. `start_endorsing` → `endorsements_in_progress` / `endorsing`
6. `return_to_review`
7. Mortgage monitoring + handling-request metadata
8. `route_loss_draft` → internal `loss_draft_tracking`
9. Loss-draft notes
10. `mark_ready_for_deposit` → **STOP**
11. CheckAlt / deposited denied
12. C1C isolation + unauthenticated 401 + spoof ignored
13. Cleanup DELETE
14. Financial aggregates return to baseline
