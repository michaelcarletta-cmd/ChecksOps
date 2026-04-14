

# Fix Task Status Sync — Overdue Badge Persistence

## Problem
After completing or editing a task, the overdue badge/styling can persist because:
1. The `NotificationsBar` independently fetches tasks and doesn't refetch when tasks change elsewhere
2. No visual sync indicator tells the user data is refreshing
3. The `isPastDue` calculation in `ExecutionTaskCard` uses `Date.now()` at render time but the task object may be stale until the realtime channel fires

## Changes

### 1. `src/hooks/useExecutionQueue.ts` — Add sync status flag
- Add a `synced` state that briefly flips to `true` after a successful refetch, then resets after 2 seconds
- Expose `synced` from the hook so the UI can show a brief confirmation indicator

### 2. `src/components/execution/ExecutionQueuePanel.tsx` — Sync indicator + skeleton
- Accept `synced` prop from the hook
- When `refetching` is true, show a subtle skeleton overlay or loading pulse on the card area
- When `synced` flips true, show a small green checkmark with a 2-second fade-out near the "Execution Queue" title
- After `handleAction` succeeds, the existing `onRefetch()` call already triggers a hard refetch — no change needed there

### 3. `src/components/NotificationsBar.tsx` — Subscribe to task changes
- The realtime subscription is already present but uses its own independent query
- After any realtime event fires and `fetchTasks()` completes, the overdue list should auto-clear — verify this path works
- Add `console.error` logging if the fetched data still contains a task with `status = 'completed'` (indicates stale read)

### 4. `src/components/execution/ExecutionTaskCard.tsx` — Guard against stale overdue display
- Current line 63: `const isPastDue = !!(task.due_date && new Date(task.due_date).getTime() < Date.now() && task.status !== 'completed');`
- This is correct but the card can render before the refetch completes — the `refetching` opacity already handles this visually. No code change needed here.

### 5. `src/services/taskExecutionService.ts` — Add error logging on stale returns
- In `completeTask()`: after the update, re-select the task and `console.error` if status is not `completed`
- In `handleSave` (TaskDetailDrawer): after update, log if the returned data still has old `due_date`

### 6. `src/pages/Tasks.tsx` — Wire synced state
- Destructure `synced` from `useExecutionQueue()` and pass to `ExecutionQueuePanel`

## Files to modify
1. `src/hooks/useExecutionQueue.ts` — add `synced` state with auto-reset timer
2. `src/components/execution/ExecutionQueuePanel.tsx` — sync checkmark indicator + skeleton during refetch
3. `src/components/NotificationsBar.tsx` — stale-data console.error guard
4. `src/services/taskExecutionService.ts` — post-mutation verification logging
5. `src/pages/Tasks.tsx` — pass `synced` prop through

