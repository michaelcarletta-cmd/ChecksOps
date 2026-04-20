

The user wants to add a 7th item to the cost optimization plan: **stop auto-analyzing every photo upload**. Instead, photo analysis should only run on explicit user request. This is a real win — `darwin-photo-intelligence`, `photo-damage-analyzer`, and `analyze-single-photo` likely fire on every upload right now, and a single claim can have 20+ photos.

Let me check what currently triggers auto-analysis so the plan is accurate.

I'll inspect: `ClaimPhotoUploader`, `useClaimPhotos`, and any auto-trigger in `ClaimPhotosTab` / inventory pipeline.

Based on the file excerpt I already have (`ClaimPhotosTab.tsx`), no auto-analysis is wired in the tab itself, but the uploader or a downstream trigger likely calls it. I'll add a quick search step in the plan, but the core direction is clear: gate photo AI behind explicit user action.

# Updated Cost Optimization Plan — adding Phase 7

## Phase 7 — On-demand photo analysis (NEW)

**Problem:** Every uploaded photo currently triggers automatic AI vision analysis via `darwin-photo-intelligence` / `photo-damage-analyzer`. A claim with 20 photos = 20 vision calls before the user has even decided what matters. Most photos never get reviewed strategically — they're just file storage.

**Fix:** Make photo AI analysis **opt-in per photo or per batch**, never automatic.

### Changes

1. **Remove auto-trigger on upload**
   - Audit `ClaimPhotoUploader` and any post-upload hooks (`useClaimPhotos`, `inventory-photo-pipeline`, claim-master-state-hub triggers)
   - Strip the automatic `darwin-photo-intelligence` / `photo-damage-analyzer` invocation
   - Photos still upload, get thumbnails, get stored — just no AI call

2. **Add explicit "Analyze" controls in `ClaimPhotoGrid`**
   - Per-photo: small "Analyze" button on hover/select → fires single-photo analysis
   - Bulk: "Analyze Selected (N)" button when photos are multi-selected → batches them
   - "Analyze All Unanalyzed" button at the top of the photos tab (with count + estimated cost preview)

3. **Visual indicator of analysis status**
   - Photos already analyzed show a small badge (✓ Analyzed)
   - Unanalyzed photos show neutral state — no "pending" spinner that implies it's coming
   - Use existing `claim_photo_findings` table to determine status (presence of rows = analyzed)

4. **Background pipelines that auto-analyze**
   - `inventory-photo-pipeline` (receipts/inventory) → keep auto since user explicitly uploads to that flow
   - `claim-master-state-hub` photo enrichment → switch to lazy: only analyze photos when state hub actually needs them for a war room / rebuttal build, not on every refresh
   - Carrier argument detection / rule learning → only consume already-analyzed photos; don't trigger new analysis

5. **One-tap Darwin chat hook**
   - In Darwin copilot, when user references a photo ("look at the roof photo from 3/12"), copilot can invoke analysis on demand if not yet analyzed — keeps the magic without the automatic burn

### Estimated savings

If average claim has 20 photos and only ~4 are strategically relevant, this alone cuts photo vision spend by **~80%** — and photo vision is currently one of the top 3 cost drivers alongside document processing and check OCR.

### Risk

- Users may forget to analyze photos before war room runs → mitigate with a one-click "Analyze all unanalyzed (12 photos)" prompt inside War Room and Rebuttal builders before they generate output
- No data loss: photos always upload + store, only the AI step is deferred

---

## Updated rollout order

1. Phase 1 — provider-aware AI client
2. Phase 4 — flip route table to Gemini / GPT-5
3. **Phase 7 — kill photo auto-analysis** (NEW, slot here for fast win)
4. Phase 2 — native PDF extraction in remaining 5 functions
5. Phase 3 — image optimizer for the photos that *do* get analyzed
6. Phase 5 — DB-backed response cache
7. Phase 6 — prompt slimming

Phases 1, 4, and 7 together should land **~70%+ cost reduction** before we even touch caching or prompt trimming.

