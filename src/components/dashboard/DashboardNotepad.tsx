import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StickyNote, Save, Loader2, Plus, X } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useDebounce } from "@/hooks/useDebounce";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const DashboardNotepad = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<string[]>([]);
  const [newItem, setNewItem] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debouncedItems = useDebounce(items, 1000);

  const { data: note, isLoading } = useQuery({
    queryKey: ["user-note"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return null;

      const { data, error } = await supabase
        .from("user_notes")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (note?.content !== undefined) {
      try {
        const parsed = JSON.parse(note.content);
        if (Array.isArray(parsed)) {
          setItems(parsed);
        } else {
          // Convert old plain text to bullet points
          const lines = note.content.split('\n').filter((line: string) => line.trim());
          setItems(lines);
        }
      } catch {
        // If not JSON, split by newlines
        const lines = note.content.split('\n').filter((line: string) => line.trim());
        setItems(lines);
      }
      // Mark as loaded after setting initial items
      hasLoadedRef.current = true;
    }
  }, [note?.content]);

  const saveMutation = useMutation({
    mutationFn: async (newItems: string[]) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      const content = JSON.stringify(newItems);

      if (note) {
        const { error } = await supabase
          .from("user_notes")
          .update({ content })
          .eq("id", note.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("user_notes")
          .insert({ user_id: user.id, content });
        if (error) throw error;
      }
    },
    onMutate: () => {
      setIsSaving(true);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-note"] });
      setIsSaving(false);
    },
    onError: (error) => {
      toast({
        title: "Error saving note",
        description: error.message,
        variant: "destructive",
      });
      setIsSaving(false);
    },
  });

  // Track if initial load has happened to prevent overwriting on mount
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    // Don't save if we haven't loaded initial data yet
    if (!hasLoadedRef.current) return;
    
    const currentContent = note?.content;
    let existingItems: string[] = [];
    try {
      const parsed = JSON.parse(currentContent || "[]");
      existingItems = Array.isArray(parsed) ? parsed : [];
    } catch {
      existingItems = currentContent?.split('\n').filter((l: string) => l.trim()) || [];
    }
    
    if (JSON.stringify(debouncedItems) !== JSON.stringify(existingItems)) {
      saveMutation.mutate(debouncedItems);
    }
  }, [debouncedItems]);

  const handleAddItem = () => {
    if (newItem.trim()) {
      setItems([...items, newItem.trim()]);
      setNewItem("");
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddItem();
    }
  };

  const handleRemoveItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <StickyNote className="h-5 w-5" />
            Quick Notes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-32 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StickyNote className="h-5 w-5" />
            Quick Notes
          </div>
          {isSaving && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving...
            </div>
          )}
          {!isSaving && items.length > 0 && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Save className="h-3 w-3" />
              Saved
            </div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            placeholder="Add a note..."
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1"
          />
          <Button size="icon" variant="outline" onClick={handleAddItem}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        
        <ul className="space-y-2 max-h-[200px] overflow-y-auto">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No notes yet. Add one above!
            </p>
          ) : (
            items.map((item, index) => (
              <li
                key={index}
                className="flex items-start gap-2 p-2 rounded-md bg-muted/50 group"
              >
                <span className="text-primary mt-0.5">•</span>
                <span className="flex-1 text-sm">{item}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemoveItem(index)}
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-4 w-4" />
                </Button>
              </li>
            ))
          )}
        </ul>
      </CardContent>
    </Card>
  );
};
