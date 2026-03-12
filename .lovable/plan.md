

## Plan: Add "Select All" and Bulk Delete for Claim Photos

### What Changes

**File: `src/components/claim-detail/ClaimPhotos.tsx`**

1. **Add a "Select All" button** in the toolbar (next to the existing "Clear" button area, around line 624-636):
   - When clicked, selects all photos currently visible (filtered by active category)
   - Toggles to "Deselect All" when all are selected

2. **Add a "Delete Selected" button** that appears when photos are selected:
   - Shows confirmation dialog with count of photos to delete
   - On confirm, bulk-deletes selected photos from both storage and the `claim_photos` table
   - Shows progress feedback during deletion

### Toolbar Button Layout (when photos are selected)

```text
[Select All] [Delete Selected (N)] [Link Before/After] [Clear (N)] ...existing buttons...
```

### Technical Details

- **Select All** will use `filteredPhotos` (respects category filter) to select all visible photo IDs
- **Bulk delete** will iterate through selected photos, removing storage files and DB records, similar to existing `handleDelete` but batched
- An `AlertDialog` confirmation will prevent accidental deletion
- After deletion, clears selection and refreshes photos

