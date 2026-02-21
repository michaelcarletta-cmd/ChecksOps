
## Implement Client Messaging in Darwin Command Bar

### Problem
The `darwin-command` edge function (used by the web UI command bar) stubs out `send_client_sms` and `send_client_email` with "coming soon." The full draft-and-confirm-send pipeline only exists in `telnyx-inbound-sms` (the SMS channel). This means web users cannot text or email clients from the command bar.

### Verified So Far (Live Proof)

| Test | Status | Evidence |
|------|--------|----------|
| Task: "call client Monday 10am" | PASS | tasks row `35191d2e` created, claim_id linked, status=pending, due=2026-02-22 |
| "Text client: We're scheduled..." intent parse | PASS | Intent correctly parsed as `send_client_sms` |
| "Email client: carrier approved..." intent parse | PASS | Intent correctly parsed as `send_client_email` |
| SMS/Email actual send via command bar | BLOCKED | darwin-command returns "coming soon" stub |
| SMS/Email send via Telnyx inbound | Code complete | Full draft/SEND/EDIT/CANCEL flow wired in telnyx-inbound-sms |

### What Needs to Change

#### 1. Replace the stub in `darwin-command` with real send logic

**File**: `supabase/functions/darwin-command/index.ts` (lines 110-121)

Replace the "coming soon" response with:

- **For `send_client_sms`**: Look up claim contacts (policyholder_phone from claims table), send via Telnyx (`send-sms` edge function), insert into `sms_messages`, return confirmation.
- **For `send_client_email`**: Look up claim contacts (policyholder_email from claims table), call `send-email` edge function (Resend), which already inserts into `emails` table, return confirmation.

Both paths will:
- Extract message body from command text (strip prefixes like "text client:", "email client:")
- Query claim for recipient info
- Send immediately (no draft-confirm flow for web -- that's an SMS-specific UX)
- Log to `claim_updates` as a communication record
- Return `{ intent, result, messageId }` to the frontend

#### 2. Parse message body from command text

Reuse the same prefix-stripping logic from `telnyx-inbound-sms`:

```text
"Text client: We're scheduled Tuesday at 9am"
  -> strip "Text client:" -> "We're scheduled Tuesday at 9am"

"Email client: carrier approved estimate"
  -> strip "Email client:" -> "carrier approved estimate"
```

#### 3. Handle missing contact info gracefully

If the claim has no phone (for SMS) or no email (for email), return a clear error:
```json
{ "intent": "send_client_sms", "error": "No phone number found on this claim." }
```

### Technical Details

**SMS send path** (darwin-command):
1. Query `claims` for `policyholder_phone`, `policyholder_name`
2. Call `send-sms` edge function with `{ claimId, toNumber, messageBody }`
3. `send-sms` handles Telnyx API + `sms_messages` insert
4. Insert `claim_updates` row (type: `communication_log`)
5. Return success with message ID

**Email send path** (darwin-command):
1. Query `claims` for `policyholder_email`, `policyholder_name`
2. Call `send-email` edge function with `{ to, subject: "Claim Update", body, claimId }`
3. `send-email` handles Resend API + `emails` insert
4. Insert `claim_updates` row (type: `communication_log`)
5. Return success with message ID

### Files Modified
- `supabase/functions/darwin-command/index.ts` -- replace stub with real send logic
- Redeploy `darwin-command`

### Verification After Deploy
- Curl `darwin-command` with "Text client: test message" + claimId -> confirm `sms_messages` row created
- Curl `darwin-command` with "Email client: test update" + claimId -> confirm `emails` row created
- Confirm `claim_updates` logged for both
- Confirm darwin-command invocation count increases
