

# Darwin Backfill: Catch Up on 934 Claims

## The Problem

Darwin's escalation engine currently only evaluates claims when you manually open them. Out of 934 claims (929 PA/NJ), only **1 claim** has regulatory deadlines populated, **zero** have carrier deadlines, and **zero** escalation actions exist. Darwin is blind to 933 claims.

## What We'll Build

A **one-click batch backfill** edge function + UI trigger that processes all existing claims in bulk:

1. **Generate regulatory deadlines** for every claim that doesn't have them
2. **Auto-mark overdue deadlines** based on today's date vs. deadline date
3. **Evaluate escalation rules** against every open claim and surface a summary
4. **Add a `state_code` column** to the claims table so state detection is reliable and doesn't need to be re-parsed every time

---

## Step 1: Add `state_code` Column to Claims

Add a `state_code` (text, nullable) column to the `claims` table. This gives Darwin a structured field instead of re-parsing addresses constantly.

The backfill function will populate this for all 934 claims using the robust regex-based state detection (word boundaries + ZIP patterns) already built in Phase 4.

## Step 2: Edge Function — `darwin-backfill-claims`

A new edge function that runs as a batch job (called manually via UI button or via cron). Secured with `x-cron-secret`.

**Processing logic (per claim):**

```text
For each claim without deadlines:
  1. Detect state from policyholder_address (regex)
  2. Write state_code to claims table
  3. Generate 4 regulatory deadlines:
     - Acknowledgment (10 days from filed)
     - Investigation (30 days from filed)
     - Written Response (PA: 45 days, NJ: 40 days)
     - Statute of Limitations (PA: 2yr, NJ: 6yr from loss date)
  4. Auto-set status:
     - If deadline_date < today --> "overdue"
     - If deadline_date >= today --> "pending"
```

**Batching strategy:**
- Process 50 claims per invocation to avoid edge function timeouts
- Return cursor (last processed claim ID) so it can be called repeatedly
- Frontend shows progress: "Processed 150 / 934 claims..."

## Step 3: Frontend — Backfill Controls in Darwin Operations Center

Add a "Darwin Catch-Up" card to the existing Darwin Operations page (`src/pages/DarwinOperations.tsx` or the Settings page) with:

- **"Run Backfill" button** -- kicks off the batch process
- **Progress bar** -- shows claims processed / total
- **Auto-continues** -- after each batch of 50 completes, automatically calls the next batch until done
- **Summary on completion**: "934 claims processed. 412 overdue deadlines detected. 230 open claims with active escalation triggers."

## Step 4: Deadline Status Auto-Update

As part of the backfill, deadlines created in the past that have already lapsed get marked `overdue` immediately. This means when you open any claim after the backfill, the Escalation Engine will already have the data it needs to fire rules like "missed acknowledgment deadline" or "no coverage determination after 30 days."

---

## Technical Details

### New Files
- `supabase/functions/darwin-backfill-claims/index.ts` -- batch processing edge function

### Modified Files
- `supabase/migrations/[timestamp]_add_state_code_to_claims.sql` -- adds `state_code` column
- `src/pages/DarwinOperations.tsx` -- add backfill UI controls
- `supabase/config.toml` -- register new function with `verify_jwt = false`

### State Detection (reused from Phase 4)
```text
Priority order:
  1. ZIP-code pattern: /\b(PA|NJ)\s+\d{5}\b/
  2. Word-boundary abbreviation: /(^|[\s,])PA([\s,]|$)/i
  3. Full name: /pennsylvania/i or /new jersey/i
  4. Fallback: null (skip claim)
```

### Batch Processing Flow
```text
Frontend clicks "Run Backfill"
       |
       v
Calls darwin-backfill-claims with { cursor: null }
       |
       v
Function processes 50 claims:
  - Detect state, write state_code
  - Insert 4 deadlines per claim (skip if already exist)
  - Mark past deadlines as overdue
       |
       v
Returns { processed: 50, remaining: 884, cursor: "last-id" }
       |
       v
Frontend auto-calls next batch with { cursor: "last-id" }
       |
       v
Repeats until remaining = 0
       |
       v
Shows summary: deadlines created, overdue count, claims by state
```

### Safety
- Idempotent: skips claims that already have deadlines (checks `claim_deadlines` before inserting)
- Uses service role key (cron-secured, not user-facing)
- Does NOT modify any claim statuses or existing data -- only adds missing deadlines and state_code

