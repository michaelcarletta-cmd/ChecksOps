import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Edit2, Save, X, BookOpen, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface CounterArgument {
  id: string;
  denial_category: string;
  denial_reason: string;
  denial_keywords: string[];
  rebuttal_template: string;
  legal_citations: string | null;
  success_rate: number | null;
  usage_count: number;
  is_active: boolean;
}

export const CounterArgumentsSettings = () => {
  const [counterArguments, setCounterArguments] = useState<CounterArgument[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  
  // Form state
  const [formData, setFormData] = useState({
    denial_category: "",
    denial_reason: "",
    denial_keywords: "",
    rebuttal_template: "",
    legal_citations: ""
  });

  const { toast } = useToast();

  const fetchCounterArguments = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('counter_arguments')
      .select('*')
      .order('denial_category');

    if (error) {
      console.error("Error fetching counter arguments:", error);
      toast({
        title: "Error",
        description: "Failed to load counter arguments",
        variant: "destructive"
      });
    } else {
      setCounterArguments(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchCounterArguments();
  }, []);

  const handleSubmit = async () => {
    if (!formData.denial_category || !formData.denial_reason || !formData.rebuttal_template) {
      toast({
        title: "Missing fields",
        description: "Please fill in all required fields",
        variant: "destructive"
      });
      return;
    }

    const keywords = formData.denial_keywords
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0);

    const payload = {
      denial_category: formData.denial_category,
      denial_reason: formData.denial_reason,
      denial_keywords: keywords,
      rebuttal_template: formData.rebuttal_template,
      legal_citations: formData.legal_citations || null
    };

    if (editingId) {
      const { error } = await supabase
        .from('counter_arguments')
        .update(payload)
        .eq('id', editingId);

      if (error) {
        toast({
          title: "Error",
          description: "Failed to update counter argument",
          variant: "destructive"
        });
      } else {
        toast({ title: "Updated", description: "Counter argument updated successfully" });
        setEditingId(null);
      }
    } else {
      const { error } = await supabase
        .from('counter_arguments')
        .insert(payload);

      if (error) {
        toast({
          title: "Error",
          description: "Failed to create counter argument",
          variant: "destructive"
        });
      } else {
        toast({ title: "Created", description: "Counter argument added successfully" });
      }
    }

    setFormData({
      denial_category: "",
      denial_reason: "",
      denial_keywords: "",
      rebuttal_template: "",
      legal_citations: ""
    });
    setDialogOpen(false);
    fetchCounterArguments();
  };

  const handleEdit = (arg: CounterArgument) => {
    setEditingId(arg.id);
    setFormData({
      denial_category: arg.denial_category,
      denial_reason: arg.denial_reason,
      denial_keywords: arg.denial_keywords.join(', '),
      rebuttal_template: arg.rebuttal_template,
      legal_citations: arg.legal_citations || ""
    });
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteId) return;

    const { error } = await supabase
      .from('counter_arguments')
      .delete()
      .eq('id', deleteId);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to delete counter argument",
        variant: "destructive"
      });
    } else {
      toast({ title: "Deleted", description: "Counter argument removed" });
      fetchCounterArguments();
    }
    setDeleteId(null);
  };

  const filteredArguments = counterArguments.filter(arg =>
    arg.denial_category.toLowerCase().includes(searchQuery.toLowerCase()) ||
    arg.denial_reason.toLowerCase().includes(searchQuery.toLowerCase()) ||
    arg.denial_keywords.some(k => k.includes(searchQuery.toLowerCase()))
  );

  const groupedArguments = filteredArguments.reduce((acc, arg) => {
    if (!acc[arg.denial_category]) {
      acc[arg.denial_category] = [];
    }
    acc[arg.denial_category].push(arg);
    return acc;
  }, {} as Record<string, CounterArgument[]>);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              Counter-Argument Library
            </CardTitle>
            <CardDescription>
              Manage proven rebuttals for common denial reasons. Darwin uses these when generating responses.
            </CardDescription>
          </div>
          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) {
              setEditingId(null);
              setFormData({
                denial_category: "",
                denial_reason: "",
                denial_keywords: "",
                rebuttal_template: "",
                legal_citations: ""
              });
            }
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Counter-Argument
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingId ? "Edit" : "Add"} Counter-Argument</DialogTitle>
                <DialogDescription>
                  Create a rebuttal template for a common denial reason
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Category *</label>
                    <Input
                      value={formData.denial_category}
                      onChange={(e) => setFormData({ ...formData, denial_category: e.target.value })}
                      placeholder="e.g., Pre-existing Condition"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Denial Reason *</label>
                    <Input
                      value={formData.denial_reason}
                      onChange={(e) => setFormData({ ...formData, denial_reason: e.target.value })}
                      placeholder="e.g., Damage existed prior to claim"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Keywords (comma-separated)</label>
                  <Input
                    value={formData.denial_keywords}
                    onChange={(e) => setFormData({ ...formData, denial_keywords: e.target.value })}
                    placeholder="pre-existing, prior damage, wear and tear"
                  />
                  <p className="text-xs text-muted-foreground">
                    Darwin uses these keywords to automatically match this rebuttal to denial letters
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Rebuttal Template *</label>
                  <Textarea
                    value={formData.rebuttal_template}
                    onChange={(e) => setFormData({ ...formData, rebuttal_template: e.target.value })}
                    placeholder="Enter the rebuttal template. Use placeholders like [DAMAGE_TYPE], [DATE_OF_LOSS], [SPECIFIC_OBSERVATIONS] that Darwin will fill in."
                    className="min-h-[200px]"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Legal Citations</label>
                  <Input
                    value={formData.legal_citations}
                    onChange={(e) => setFormData({ ...formData, legal_citations: e.target.value })}
                    placeholder="e.g., N.J.S.A. 17:29B-4 / 40 P.S. § 1171.5"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSubmit}>
                    <Save className="h-4 w-4 mr-2" />
                    {editingId ? "Update" : "Save"}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search counter-arguments..."
            className="pl-9"
          />
        </div>

        {/* Counter Arguments List */}
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : Object.keys(groupedArguments).length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No counter-arguments found. Add your first one to help Darwin generate better rebuttals.
          </div>
        ) : (
          <ScrollArea className="h-[500px]">
            <div className="space-y-6">
              {Object.entries(groupedArguments).map(([category, args]) => (
                <div key={category} className="space-y-2">
                  <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">
                    {category}
                  </h3>
                  {args.map((arg) => (
                    <div key={arg.id} className="p-4 border rounded-md space-y-2">
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="font-medium">{arg.denial_reason}</h4>
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {arg.denial_keywords.slice(0, 4).map((keyword, i) => (
                              <Badge key={i} variant="secondary" className="text-xs">
                                {keyword}
                              </Badge>
                            ))}
                            {arg.denial_keywords.length > 4 && (
                              <Badge variant="outline" className="text-xs">
                                +{arg.denial_keywords.length - 4} more
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="sm" onClick={() => handleEdit(arg)}>
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            onClick={() => setDeleteId(arg.id)}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-3">
                        {arg.rebuttal_template}
                      </p>
                      {arg.legal_citations && (
                        <p className="text-xs text-blue-600">
                          Citations: {arg.legal_citations}
                        </p>
                      )}
                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>Used {arg.usage_count} times</span>
                        {arg.success_rate && <span>{arg.success_rate}% success rate</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        {/* Delete Confirmation */}
        <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Counter-Argument?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone. Darwin will no longer use this rebuttal template.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
};
