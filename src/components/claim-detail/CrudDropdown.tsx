import { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { Plus, Pencil, Trash2, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface CrudDropdownItem {
  id: string;
  label: string;
  sublabel?: string;
}

interface CrudDropdownProps {
  table: string;
  labelField: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  emptyText: string;
  dialogTitle: string;
  /** For payment_methods: render custom add form */
  renderAddForm?: (props: {
    onSave: (fields: Record<string, string>) => Promise<void>;
    onCancel: () => void;
    saving: boolean;
  }) => React.ReactNode;
  /** Transform raw DB row to display item */
  transformRow?: (row: any) => CrudDropdownItem;
  /** Build insert payload from name input */
  buildInsert?: (name: string, userId: string) => Record<string, any>;
  /** Build insert from custom form fields */
  buildCustomInsert?: (fields: Record<string, string>, userId: string) => Record<string, any>;
  /** Validate name input; return error string or null */
  validateName?: (name: string, existing: CrudDropdownItem[]) => string | null;
}

export const CrudDropdown = ({
  table,
  labelField,
  value,
  onValueChange,
  placeholder,
  emptyText,
  dialogTitle,
  renderAddForm,
  transformRow,
  buildInsert,
  buildCustomInsert,
  validateName,
}: CrudDropdownProps) => {
  const [items, setItems] = useState<CrudDropdownItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editItem, setEditItem] = useState<CrudDropdownItem | null>(null);
  const [name, setName] = useState("");
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const fetchItems = async () => {
    setLoading(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;
      const { data, error } = await (supabase.from(table as any) as any)
        .select("*")
        .eq("created_by", userData.user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const transform = transformRow || ((row: any) => ({ id: row.id, label: row[labelField] }));
      setItems((data || []).map(transform));
    } catch {
      toast.error(`Failed to load ${dialogTitle.toLowerCase()}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchItems(); }, []);

  const defaultValidate = (n: string, existing: CrudDropdownItem[]): string | null => {
    if (!n.trim()) return "Name is required";
    if (existing.some(i => i.label.toLowerCase() === n.trim().toLowerCase())) return "Already exists";
    return null;
  };

  const handleAdd = async () => {
    const validate = validateName || defaultValidate;
    const err = validate(name, items);
    if (err) { toast.error(err); return; }
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not authenticated");
      const payload = buildInsert
        ? buildInsert(name.trim(), userData.user.id)
        : { [labelField]: name.trim(), created_by: userData.user.id };
      const { error } = await (supabase.from(table as any) as any).insert(payload);
      if (error) throw error;
      toast.success(`Added "${name.trim()}"`);
      setName("");
      setAddOpen(false);
      await fetchItems();
    } catch (e: any) {
      toast.error(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleCustomAdd = async (fields: Record<string, string>) => {
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) throw new Error("Not authenticated");
      const payload = buildCustomInsert
        ? buildCustomInsert(fields, userData.user.id)
        : { ...fields, created_by: userData.user.id };
      const { error } = await (supabase.from(table as any) as any).insert(payload);
      if (error) throw error;
      toast.success("Added successfully");
      setAddOpen(false);
      await fetchItems();
    } catch (e: any) {
      toast.error(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!editItem) return;
    if (!editName.trim()) { toast.error("Name is required"); return; }
    const dup = items.find(i => i.id !== editItem.id && i.label.toLowerCase() === editName.trim().toLowerCase());
    if (dup) { toast.error("Already exists"); return; }
    setSaving(true);
    try {
      const { error } = await (supabase.from(table as any) as any)
        .update({ [labelField]: editName.trim() })
        .eq("id", editItem.id);
      if (error) throw error;
      toast.success("Updated");
      setEditOpen(false);
      setEditItem(null);
      await fetchItems();
    } catch {
      toast.error("Failed to update");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await (supabase.from(table as any) as any).delete().eq("id", id);
      if (error) throw error;
      toast.success("Deleted");
      if (value === id) onValueChange("");
      setDeleteConfirm(null);
      await fetchItems();
    } catch {
      toast.error("Failed to delete");
    }
  };

  if (loading) return <Skeleton className="h-10 w-full" />;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Select value={value} onValueChange={onValueChange}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {items.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">{emptyText}</div>
            )}
            {items.map(item => (
              <div key={item.id} className="group flex items-center">
                <SelectItem value={item.id} className="flex-1">
                  <span className="flex items-center gap-1.5">
                    {value === item.id && <Check className="h-3 w-3 text-primary" />}
                    {item.label}
                    {item.sublabel && <span className="text-muted-foreground text-xs">({item.sublabel})</span>}
                  </span>
                </SelectItem>
                <div className="hidden group-hover:flex items-center gap-0.5 pr-2">
                  <button
                    type="button"
                    className="p-0.5 rounded hover:bg-accent transition-colors duration-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditItem(item);
                      setEditName(item.label);
                      setEditOpen(true);
                    }}
                  >
                    <Pencil className="h-3 w-3 text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    className="p-0.5 rounded hover:bg-destructive/10 transition-colors duration-200"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirm(item.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </button>
                </div>
              </div>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="icon" variant="outline" className="h-10 w-10 shrink-0" onClick={() => { setName(""); setAddOpen(true); }}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {/* Add Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add {dialogTitle}</DialogTitle></DialogHeader>
          {renderAddForm ? (
            renderAddForm({ onSave: handleCustomAdd, onCancel: () => setAddOpen(false), saving })
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder={`Enter ${dialogTitle.toLowerCase()} name`} autoFocus onKeyDown={e => e.key === "Enter" && handleAdd()} />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
                <Button onClick={handleAdd} disabled={saving || !name.trim()}>
                  {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Save
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Edit {dialogTitle}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={editName} onChange={e => setEditName(e.target.value)} autoFocus onKeyDown={e => e.key === "Enter" && handleEdit()} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button onClick={handleEdit} disabled={saving || !editName.trim()}>
                {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Delete {dialogTitle}?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This cannot be undone.</p>
          <div className="flex gap-2 justify-end pt-2">
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>Delete</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};
