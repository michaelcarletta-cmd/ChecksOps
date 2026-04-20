

## Fix: GPT-5 `max_tokens` → `max_completion_tokens`

**Root cause.** After Phase 4 routing, Copilot calls `openai/gpt-5*` models via the Lovable AI Gateway. GPT-5 (and newer reasoning models) reject the legacy `max_tokens` parameter and require `max_completion_tokens`. Our centralized `openaiClient.ts` unconditionally sends `max_tokens` → gateway returns 400 → user sees the toast.

This is a one-file fix in the shared AI client. Every edge function (Copilot, war room, rebuttal, vision, tools) benefits automatically.

### What I'll change

**File:** `supabase/functions/_shared/ai/openaiClient.ts`

Add a tiny helper that picks the right token-limit key based on the target model, then use it in all three body builders:

```text
Model pattern                              → Key
─────────────────────────────────────────────────────────────
openai/gpt-5*        (Lovable gateway)     → max_completion_tokens
openai/gpt-5.2       (Lovable gateway)     → max_completion_tokens
openai/o1* / o3*     (if ever used)        → max_completion_tokens
google/*             (Lovable gateway)     → max_tokens   (accepted)
gpt-4o / gpt-4o-mini (direct OpenAI fbck)  → max_tokens   (accepted)
```

Apply in three places:
1. `callOpenAI` (line ~170) — text chat body
2. `callVision` (line ~217) — vision body
3. `callWithTools` (line ~261) — tool-call body
4. `executeChat` fallback branch (line ~115) — when we fall back from `openai/gpt-5*` to `gpt-4o`, strip `max_completion_tokens` and re-add as `max_tokens` so the legacy OpenAI endpoint accepts it.

### Helper sketch

```ts
function tokenLimitKey(model: string): "max_tokens" | "max_completion_tokens" {
  if (/^openai\/(gpt-5|o[13])/i.test(model)) return "max_completion_tokens";
  return "max_tokens";
}

function withTokenLimit(body: Record<string, unknown>, model: string, limit: number) {
  body[tokenLimitKey(model)] = limit;
  return body;
}
```

In the fallback branch, rewrite the body before calling OpenAI directly:
```ts
const fbBody = { ...body };
delete fbBody.max_completion_tokens;
fbBody.max_tokens = opts.maxTokens ?? 2000; // legacy key for gpt-4o
```

### Also sweep

Two other call sites pass the raw `max_tokens` field in ad-hoc payloads — quick audit while I'm in there:

- `supabase/functions/claims-ai-assistant/index.ts` lines 6342, 6421 — uses `google/gemini-2.5-flash`, so `max_tokens` stays correct. No change.
- `supabase/functions/darwin-ai-analysis/index.ts` line 10560 — payload is then forwarded into the shared helpers via `maxTokens` (lines 10658/10678), which will pick up the fix automatically. No change needed.
- `supabase/functions/photo-damage-analyzer/index.ts` line 241 — same story, forwards into `callVision`/`callWithTools`. Fix propagates.
- `supabase/functions/_shared/ai/pdfVisionOcr.ts` line 114 — uses `gpt-4o-mini` direct, `max_tokens` is correct there. No change.

So only **one file** actually needs editing.

### Deploy

Redeploy the functions that re-bundle the shared module:
`darwin-copilot`, `darwin-ai-analysis`, `darwin-photo-intelligence`, `photo-damage-analyzer`, `analyze-single-photo`, `darwin-process-document`, `darwin-estimate-import`, `claims-ai-assistant`.

### Verification

After deploy, reproduce in Copilot with a normal chat message. Then tail edge logs for `darwin-copilot` — should return `choices[0].message.content` cleanly, no 400.

### Risk

Low. The only behavioral change is the JSON key name for the token cap, gated by the model prefix. Gemini and legacy OpenAI paths are untouched.

