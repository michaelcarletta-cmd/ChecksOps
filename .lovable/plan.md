

# Plan: Merge Second Brain into Copilot + Mobile Copilot Access

## Problem
1. **Copilot is invisible on mobile** — the right drawer uses `hidden xl:block`, so screens under 1280px never see it
2. **Second Brain is dead code** — imported but never rendered in DarwinTab
3. **No proactive nudges** — `claim_warnings_log` is only populated during manual War Room runs

## Solution (3 parts)

### Part 1: Mobile Copilot Access
On mobile/tablet (below XL), add a **full-screen slide-up sheet** for Copilot triggered by the existing "Show Assistant Panel" button:
- Use a `Sheet` component (already in your UI library) that slides up from the bottom
- Contains the same `DarwinCopilotPanel` with Copilot + Dismantler tabs
- The button already exists — just change its behavior on mobile to open the sheet instead of toggling a hidden column
- No new icons or components needed

### Part 2: Proactive Warning Generator
Create edge function `darwin-proactive-warnings` that runs on the existing 5-minute cron:
- **Stale claims**: no activity in 7/14/21 days
- **Deadline warnings**: state-specific carrier response windows
- **Missing documentation**: claims without estimates, photos, or inspection reports  
- **Payment gaps**: approved amounts with no check logged
- Pure database queries, no AI calls. Deduplicates against existing warnings.

**DB migration**: add `source` column to `claim_warnings_log` (`proactive` | `strategic_intelligence` | `manual`)

### Part 3: Merge Nudges into Copilot + Brain Icon
- **Copilot banner**: Query `claim_warnings_log` for current claim, show dismissible alert banner above chat messages in `DarwinCopilotPanel`
- **Brain icon (ClaimsAIAssistant)**: Keep it on claims page. Add a badge count of active warnings. Clicking a warning pre-fills Copilot context and opens the mobile sheet (or scrolls to panel on desktop)
- **Cleanup**: Remove dead `DarwinSecondBrain` lazy import from DarwinTab

## Files

| Action | File |
|--------|------|
| Edit | `src/components/claim-detail/DarwinTab.tsx` — wrap Copilot in Sheet on mobile, remove SecondBrain import |
| Edit | `src/components/claim-detail/DarwinCopilotPanel.tsx` — add nudge banner above messages |