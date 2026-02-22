# Why Your Fixes May Not Be Live: Two Deployment Paths

The app has **two separate deployment targets**. Pushing to Git only updates one of them.

## 1. Frontend (Lovable)

- **What:** React app (Darwin tab, command bar UI, Generated Assets scroll, etc.).
- **How it gets updated:** Lovable builds from your Git branch (e.g. `main`) and deploys the built site.
- **If it’s not updating:** In Lovable, confirm the project is connected to the right repo and branch, that builds run on push, and that the latest build succeeded. The scroll fix in Generated Assets and any UI changes only appear after a successful Lovable deploy.

## 2. Supabase Edge Functions (Backend)

- **What:** `darwin-command`, `draft-client-update`, `claims-ai-assistant`, etc. These run on Supabase, not in the browser.
- **How they get updated:** **Pushing to Git does NOT deploy Edge Functions.** You must deploy them to your Supabase project.
- **If you only push to Git:** The code in the repo is new, but the **live** `darwin-command` (and other functions) are still the old deployed version. So you still get “I didn’t recognize that command” and the old client-email behavior until you deploy.

## Deploying Edge Functions (required for Darwin command bar fixes)

From the project root, with [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in:

```bash
# Deploy the Darwin command and draft-client-update functions (and their shared code)
npx supabase functions deploy darwin-command
npx supabase functions deploy draft-client-update
```

Or deploy all functions:

```bash
npx supabase functions deploy
```

After a successful deploy, the **live** Darwin command bar will use the new intent patterns, financial answers, and client-email drafting.

## Quick checklist

| Fix | Where it lives | What must happen for it to be live |
|-----|----------------|------------------------------------|
| “What has been paid” / financial Q&A | Edge Function `darwin-command` + `_shared` | Deploy: `npx supabase functions deploy darwin-command` |
| Client email = drafted update (not literal) | Edge Functions `darwin-command` + `draft-client-update` | Deploy both (see above). Ensure `OPENAI_API_KEY` is set in Supabase Dashboard → Project Settings → Edge Functions → Secrets. |
| Generated Assets scroll | Frontend `DarwinGeneratedAssets.tsx` | Push to Git and ensure Lovable builds and deploys from that branch. |

## Verifying

1. **Functions:** After deploying, run a command in the Darwin tab (e.g. “what has been paid”) and confirm the response is the new behavior.
2. **Frontend:** Hard refresh or clear cache; open a generated asset and confirm the content area scrolls.
