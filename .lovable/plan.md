

# Making Claims Control Board and Tasks Actually Useful

## Problem Summary
The control board shows every claim as "on track" with 0 days inactive because it uses `claims.updated_at` as its only activity signal — any minor database touch resets the clock. There are no auto-generated tasks, so the board only reflects manually created microtasks. The flat card list makes it hard to spot which claims actually need attention.

---

## Plan

### 1. Fix "Last Activity" to Use Real Activity Signals
Create a database view or query that computes true last activity per claim by checking the most recent timestamp across multiple tables:
- `claim_notes.created_at` (last note added)
- `claim_microtasks.created_at` (last task created)
- `tasks.created_at` (legacy tasks)
- `claim_photos.created_at` (last photo uploaded)
- `documents.created_at` (last document uploaded)
- `claims.status` change timestamp

Update `useClaimControlBoard.ts` to fetch this computed `last_real_activity_at` instead of relying on `claims.updated_at`. This single change will immediately make days-inactive, pressure scores, and follow-up statuses accurate.

### 2. Auto-Generate Microtasks from Claim State
Create a database function (triggered by cron or claim status changes) that auto-generates microtasks when certain conditions are met:
- **Carrier Review > 14 days** → "Follow up with carrier on pending review"
- **No notes in 10+ days on active claim** → "Add status update note"
- **Inspection scheduled but no photos** → "Upload inspection photos"
- **Estimate submitted, no carrier response 21+ days** → "Escalate: no carrier response"
- **Check received but not deposited 7+ days** → "Process received check"
- **Recoverable Depreciation pending 30+ days** → "Follow up on RD payment"

These auto-tasks get `task_type = 'auto'` so they're distinguishable from manual ones. They won't duplicate if one already exists for that claim + type.

### 3. Redesign Control Board Layout for Scannability
Replace the flat card list with a **grouped lane view**:
- **Needs Action Now** (escalation + overdue) — red accent, always visible at top
- **Due Soon** (due status) — amber accent
- **Waiting on Carrier** (carrier-waiting statuses) — neutral, collapsed count
- **On Track** — collapsed by default, just a count with expand option

Each group shows a count badge in the header. Claims within each group are sorted by pressure score. This lets you immediately see "12 claims need action, 8 are due soon" without scrolling through 200+ cards.

### 4. Add Quick-Action Buttons on Board Cards
Add inline action buttons directly on each claim card so you don't have to open the claim to take common actions:
- **Add Note** — opens a quick note composer inline
- **Snooze** — mark claim as "reviewed, check back in X days" (resets follow-up timer)
- **Mark Contacted** — logs a "contacted carrier" activity, resetting the inactivity clock

### 5. Daily Digest Summary at Top of Board
Add a compact summary bar showing:
- Claims needing action today (count)
- Claims with no activity in 14+ days
- Overdue microtasks across all claims
- Claims waiting on carrier response 20+ days

---

## Technical Details

**Database changes:**
- New migration: `CREATE OR REPLACE FUNCTION compute_claim_last_activity(claim_uuid UUID)` that queries across notes, photos, documents, tasks tables and returns the max timestamp
- New migration: `CREATE OR REPLACE FUNCTION auto_generate_claim_microtasks()` with duplicate-prevention logic (`ON CONFLICT DO NOTHING` on claim_id + task_type)
- Add a cron entry to run auto-generation every 2 hours (low-cost, no AI involved — pure SQL)

**Frontend changes:**
- `useClaimControlBoard.ts` — replace `c.updated_at` with a subquery or joined computed column for real activity
- `ClaimsControlBoard.tsx` — restructure from flat list to grouped lanes with collapsible sections
- `ClaimBoardCard.tsx` — add quick-action buttons (note, snooze, mark contacted)
- New `BoardSummaryBar.tsx` component for the daily digest strip

**Files affected:**
- `src/hooks/useClaimControlBoard.ts`
- `src/pages/ClaimsControlBoard.tsx`
- `src/components/control-board/ClaimBoardCard.tsx`
- `src/components/control-board/BoardSummaryBar.tsx` (new)
- `src/services/claimOperationsService.ts`
- 2 new database migrations

