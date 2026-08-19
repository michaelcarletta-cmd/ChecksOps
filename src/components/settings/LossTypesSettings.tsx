import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { Plus, Trash2, Pencil, Check, X, FolderKanban } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "./SectionCard";
import { SettingsHero } from "./SettingsHero";

interface LossType {
  id: string;
  name: string;
  is_active: boolean;
}

interface LossTypesSettingsProps {
  embedded?: boolean;
}

export function LossTypesSettings({ embedded = false }: LossTypesSettingsProps) {
  const [lossTypes, setLossTypes] = useState<LossType[]>([]);
  const [newTypeName, setNewTypeName] = useState("");
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    fetchLossTypes();
  }, []);

  const fetchLossTypes = async () => {
    try {
      const { data, error } = await supabase
        .from("loss_types")
        .select("*")
        .order("name");

      if (error) throw error;
      setLossTypes(data || []);
    } catch (error: any) {
      console.error("Error fetching loss types:", error);
      toast({
        title: "Error",
        description: "Failed to load loss types",
        variant: "destructive",
      });
    }
  };

  const handleAdd = async () => {
    if (!newTypeName.trim()) return;

    setLoading(true);
    try {
      const { error } = await supabase
        .from("loss_types")
        .insert({ name: newTypeName.trim() });

      if (error) throw error;

      toast({
        title: "Success",
        description: "Loss type added",
      });

      setNewTypeName("");
      fetchLossTypes();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to add loss type",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      const { error } = await supabase
        .from("loss_types")
        .update({ is_active: isActive })
        .eq("id", id);

      if (error) throw error;

      setLossTypes(lossTypes.map(t => t.id === id ? { ...t, is_active: isActive } : t));
      
      toast({
        title: "Success",
        description: `Loss type ${isActive ? "activated" : "deactivated"}`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to update loss type",
        variant: "destructive",
      });
    }
  };

  const handleStartEdit = (type: LossType) => {
    setEditingId(type.id);
    setEditingName(type.name);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditingName("");
  };

  const handleSaveEdit = async (id: string) => {
    if (!editingName.trim()) return;

    try {
      const { error } = await supabase
        .from("loss_types")
        .update({ name: editingName.trim() })
        .eq("id", id);

      if (error) throw error;

      setLossTypes(lossTypes.map(t => t.id === id ? { ...t, name: editingName.trim() } : t));
      setEditingId(null);
      setEditingName("");
      
      toast({
        title: "Success",
        description: "Loss type updated",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to update loss type",
        variant: "destructive",
      });
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this loss type?")) return;

    try {
      const { error } = await supabase
        .from("loss_types")
        .delete()
        .eq("id", id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Loss type deleted",
      });

      fetchLossTypes();
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to delete loss type",
        variant: "destructive",
      });
    }
  };

  const content = (
    <div className="space-y-4">
      {/* Add new loss type */}
      <div className="flex gap-3">
        <div className="flex-1">
          <Label htmlFor="newType" className="sr-only">Loss Type Name</Label>
          <Input
            id="newType"
            value={newTypeName}
            onChange={(e) => setNewTypeName(e.target.value)}
            placeholder="Enter loss type name"
            onKeyPress={(e) => e.key === "Enter" && handleAdd()}
          />
        </div>
        <Button onClick={handleAdd} disabled={loading || !newTypeName.trim()}>
          <Plus className="h-4 w-4 mr-2" />
          Add
        </Button>
      </div>

      {/* Existing loss types */}
      <div className="space-y-2">
        <Label className="text-sm text-muted-foreground">Existing Loss Types ({lossTypes.length})</Label>
        <div className="space-y-2">
          {lossTypes.map((type) => (
            <div
              key={type.id}
              className="flex items-center justify-between p-3 border border-border rounded-lg"
            >
              {editingId === type.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <Input
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    className="h-9"
                    autoFocus
                    onKeyPress={(e) => e.key === "Enter" && handleSaveEdit(type.id)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleSaveEdit(type.id)}
                    className="text-green-600 hover:text-green-700"
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleCancelEdit}
                    className="text-muted-foreground"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <span className="text-foreground font-medium">{type.name}</span>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`active-${type.id}`} className="text-sm">Active</Label>
                      <Switch
                        id={`active-${type.id}`}
                        checked={type.is_active}
                        onCheckedChange={(checked) => handleToggleActive(type.id, checked)}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleStartEdit(type)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(type.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className="space-y-6">
      <SettingsHero
        title="Loss Types"
        description="Define the types of property damage and losses your claims handle."
        badge="Classification"
        icon={<FolderKanban className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Manage Loss Types"
        icon={<FolderKanban className="h-4 w-4 text-violet-500" />}
        accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
        description="Add and manage the categories of losses available for assignment to claims."
      >
        <div className="space-y-6 pt-4">
          <div className="flex gap-3">
            <div className="flex-1">
              <Label htmlFor="newType">Loss Type Name</Label>
              <Input
                id="newType"
                value={newTypeName}
                onChange={(e) => setNewTypeName(e.target.value)}
                placeholder="Enter loss type name"
                onKeyPress={(e) => e.key === "Enter" && handleAdd()}
              />
            </div>
            <Button onClick={handleAdd} disabled={loading || !newTypeName.trim()} className="mt-auto">
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </div>

          <div className="space-y-3">
            <Label className="text-sm font-medium">Existing Loss Types ({lossTypes.length})</Label>
            <div className="grid gap-2">
              {lossTypes.map((type) => (
                <div
                  key={type.id}
                  className="flex items-center justify-between p-3 border border-border rounded-lg bg-muted/20"
                >
                  {editingId === type.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <Input
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        className="h-9"
                        autoFocus
                        onKeyPress={(e) => e.key === "Enter" && handleSaveEdit(type.id)}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleSaveEdit(type.id)}
                        className="text-green-600 hover:text-green-700"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleCancelEdit}
                        className="text-muted-foreground"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <>
                      <span className="text-foreground font-medium">{type.name}</span>
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2">
                          <Label htmlFor={`active-${type.id}`} className="text-sm cursor-pointer">Active</Label>
                          <Switch
                            id={`active-${type.id}`}
                            checked={type.is_active}
                            onCheckedChange={(checked) => handleToggleActive(type.id, checked)}
                          />
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleStartEdit(type)}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(type.id)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
