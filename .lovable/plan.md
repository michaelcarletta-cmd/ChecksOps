

# Phase 1 Extension: Task Creation + Client Updates via SMS

## Overview

Add three new Darwin SMS commands that let staff create tasks and send client updates (SMS/email) directly from text messages, with a draft-and-confirm safety flow.

---

## A. New SMS Intents

| Intent | Example triggers | Behavior |
|---|---|---|
| `create_task` | "Task: call adjuster tomorrow", "Remind me Friday to submit supplement" | Creates task on active claim, replies with confirmation |
| `send_client_sms` | "Text client: We're scheduled Tuesday at 9am" | Drafts SMS to policyholder, waits for SEND confirmation |
| `send_client_email` | "Email client update: carrier approved the estimate" | Drafts email to policyholder, waits for SEND confirmation |

---

## B. Safety and Approval Flow

**Two modes** controlled by an org-level setting (`sms_command_mode` on the org or a new `darwin_sms_settings` table):

1. **Draft mode** (default): Darwin generates a preview and waits for `SEND` confirmation
2. **Auto-send mode**: Admin-only; sends immediately but still logs everything

**Confirmation flow (draft mode):**

```text
User:  "Text client: We're scheduled Tuesday at 9am"
Darwin: "Draft ready to send to Jane Doe (+1...1234):
         'We're scheduled Tuesday at 9am'
         Reply SEND to send, EDIT <new text> to modify, or CANCEL."
User:  "SEND"
Darwin: "Sent to Jane Doe."
```

**Multi-recipient disambiguation:**
If a claim has multiple contact numbers/emails, Darwin asks:
```text
"Multiple contacts found:
 1. Jane Doe (Policyholder) +1...1234
 2. John Smith (Adjuster) +1...5678
 Reply 1 or 2 to select."
```

**Pending drafts** are stored in `sms_conversation_state` as a JSON column (`pending_action`), which holds the draft details until the user replies SEND/EDIT/CANCEL or it expires with the conversation (2 hours).

---

## C. Data Model Changes

### 1. Extend `darwin_sms_activity` (migration)

Add columns to track action metadata:
- `action_type TEXT` -- values: `task_create`, `client_sms`, `client_email`, `command`, `system`
- `result_id TEXT` -- ID of created task / sent SMS record / email record
- `needs_approval BOOLEAN DEFAULT false`
- `approved_at TIMESTAMPTZ`
- `approved_by UUID`

### 2. Extend `sms_conversation_state` (migration)

Add a column to hold pending draft actions:
- `pending_action JSONB` -- stores `{ type, claimId, to, body, subject, recipientName, recipientIndex }`

### 3. Create `darwin_sms_settings` table (migration)

```text
id           UUID PK
org_id       UUID UNIQUE (references org via org_members pattern)
send_mode    TEXT DEFAULT 'draft'  -- 'draft' | 'auto_send'
auto_send_roles TEXT[] DEFAULT '{admin}'
created_at   TIMESTAMPTZ
updated_at   TIMESTAMPTZ
```

With RLS: org admins can read/write their own org's settings.

### 4. Existing tables used (no changes needed)

- `tasks` -- already has `claim_id`, `title`, `description`, `due_date`, `created_by`, `status`, `priority`
- `sms_messages` -- existing outbound SMS log
- `emails` -- existing outbound email log
- `claims` -- has `policyholder_name`, `policyholder_phone`, `policyholder_email`

---

## D. Intent Parser Updates

### `_shared/darwin-command-contracts.ts`

Add new intents and update patterns:

```text
Intents to add:  "send_client_sms" | "send_client_email"

New patterns:
  send_client_sms:  /text\s+client|send\s+sms|sms\s+(client|update)/i
  send_client_email: /email\s+client|send\s+email\s+(client|update)|email\s+update/i
  create_task:  (existing) expand to match "task:", "remind me", "add task", "create task for"
```

Also update the existing `send_email` intent to specifically mean "send client email" for SMS context routing.

---

## E. Edge Function Changes

### `telnyx-inbound-sms/index.ts` -- Major additions

1. **SEND / EDIT / CANCEL handlers** (top of command routing, before intent parsing):
   - Check `convState.pending_action` first
   - If user replies `SEND` -- execute the pending action (send SMS via Telnyx / send email via `send-email` function / no-op for tasks)
   - If user replies `EDIT <text>` -- update the draft body and re-display
   - If user replies `CANCEL` -- clear `pending_action`, reply "Cancelled"
   - If user replies a number (1, 2, 3) and `pending_action` has `recipientIndex: 'pending'` -- resolve recipient

2. **`create_task` handler**:
   - Parse title from message body (strip "Task:", "Remind me", etc.)
   - Parse due date using simple NLP: "tomorrow", "Friday", "next Monday", specific dates
   - Insert into `tasks` table with `claim_id`, `created_by`, `status: 'pending'`
   - Reply immediately (no draft needed for tasks): "Task created: 'Call adjuster' due 2/22. Visible in CRM."
   - Log to `darwin_sms_activity` with `action_type: 'task_create'`, `result_id: <task.id>`

3. **`send_client_sms` handler**:
   - Extract message body (strip "Text client:", "Send SMS:", etc.)
   - Look up claim's `policyholder_phone` and `policyholder_name`
   - If multiple contacts (policyholder + adjuster phone), ask disambiguation
   - Check org's `send_mode`:
     - Draft mode: store in `pending_action`, reply with preview
     - Auto-send: send immediately via `sendReply()`, log to `sms_messages`
   - On SEND confirmation: send via Telnyx, insert into `sms_messages`, log to `darwin_sms_activity`

4. **`send_client_email` handler**:
   - Extract subject/body (strip "Email client:", "Send email:", etc.)
   - Look up claim's `policyholder_email` and `policyholder_name`
   - Draft mode: store in `pending_action`, reply with preview
   - On SEND: call existing `send-email` edge function with `{ to, subject, body, claimId }`
   - Log to `darwin_sms_activity` with `action_type: 'client_email'`

5. **Helper: `parseTaskFromSMS(text)`**:
   - Strips intent prefix
   - Extracts due date keywords (tomorrow, next Monday, Friday, MM/DD)
   - Returns `{ title, dueDate }`

6. **Helper: `getClaimContacts(supabase, claimId)`**:
   - Returns array of `{ name, phone, email, role }` from claim fields + `claim_adjusters`
   - Used for recipient resolution and disambiguation

### `darwin-command/index.ts` -- Minor update

Handle `create_task` and `send_email` intents that currently return "not yet implemented":
- For `create_task`: create the task directly (for non-SMS callers like the web UI command bar)
- For `send_email`: route to `send-email` function

### `_shared/darwin-command-contracts.ts`

- Add `send_client_sms` and `send_client_email` to `DarwinIntent` type
- Add corresponding regex patterns
- Update `HELP` text in `telnyx-inbound-sms` to list new commands

---

## F. Permission and Scoping Rules

- All claim lookups remain org-scoped (existing `getUserOrgClaims` pattern)
- Client SMS/email can only go to contacts attached to the claim (policyholder phone/email, adjusters on the claim)
- `send_mode: 'auto_send'` requires the user to have an `admin` role (checked via `has_role` function)
- Tasks are created with `created_by = userId` and scoped to the active claim

---

## G. UI Updates (Minimal)

### `DarwinSMSActivityLog.tsx`
- Display new `action_type` values with appropriate icons (task icon, email icon, SMS icon)
- Show `needs_approval` / `approved_at` status badges

### `PhoneVerificationSettings.tsx` or new section
- Add a toggle for "Auto-send mode" (admin only) under Darwin SMS settings

### `HELP` command response
- Update to include: "Task: <description>", "Text client: <message>", "Email client: <message>"

---

## H. File Change Summary

| File | Action |
|---|---|
| `supabase/migrations/[new].sql` | Add columns to `darwin_sms_activity`, `sms_conversation_state`; create `darwin_sms_settings` |
| `supabase/functions/_shared/darwin-command-contracts.ts` | Add `send_client_sms`, `send_client_email` intents + patterns |
| `supabase/functions/telnyx-inbound-sms/index.ts` | Add SEND/EDIT/CANCEL flow, task creation, client SMS/email handlers |
| `supabase/functions/darwin-command/index.ts` | Handle `create_task` + `send_email` intents for web callers |
| `src/components/inbox/DarwinSMSActivityLog.tsx` | Display action_type, approval badges |
| `src/components/settings/PhoneVerificationSettings.tsx` | Add auto-send toggle for admins |

---

## I. Acceptance Tests

After implementation, these should work from a verified phone:

1. `Task: call adjuster tomorrow 10am` -- task created, visible in CRM claim tasks
2. `Text client: We're scheduled Tuesday at 9am` -- draft shown, reply SEND, SMS sent + logged in `sms_messages`
3. `Email client update: carrier approved estimate` -- draft shown, reply SEND, email sent via Resend + logged in `emails`
4. All activity visible in Inbox Darwin SMS tab and Claim Detail Darwin tab
5. Draft mode enforced by default; CANCEL clears pending action

