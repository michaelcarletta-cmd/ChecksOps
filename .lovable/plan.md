

## Persist Auto-Refresh Toggle State

The auto-refresh toggle currently uses local React state (`useState`), which resets when you navigate away. The fix is to persist it to `localStorage` so it remembers your choice per claim.

### Changes

**File: `src/components/claim-detail/DarwinAutoSummary.tsx`**

1. Initialize `autoRefresh` state from `localStorage` instead of defaulting to `false`:
   - Read from `localStorage` key like `darwin-auto-refresh-{claimId}`
   - Fall back to `false` if no saved value exists

2. Save to `localStorage` whenever the toggle changes:
   - Add a `useEffect` that writes the current `autoRefresh` value to `localStorage` whenever it changes

### Technical Details

```text
Current:  const [autoRefresh, setAutoRefresh] = useState(false);

Proposed: const [autoRefresh, setAutoRefresh] = useState(() => {
            const saved = localStorage.getItem(`darwin-auto-refresh-${claimId}`);
            return saved === "true";
          });

          useEffect(() => {
            localStorage.setItem(`darwin-auto-refresh-${claimId}`, String(autoRefresh));
          }, [autoRefresh, claimId]);
```

This is a small, self-contained change -- no database tables or backend work needed.

