import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Crown, Star, Trash2, Search, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

type ProfessionalType = "contractor" | "public_adjuster" | "attorney";

interface ProfessionalForm {
  professional_type: ProfessionalType;
  name: string;
  company: string;
  email: string;
  phone: string;
  website: string;
  states_served: string[];
  specialties: string;
  description: string;
}

const EMPTY_FORM: ProfessionalForm = {
  professional_type: "contractor",
  name: "",
  company: "",
  email: "",
  phone: "",
  website: "",
  states_served: [],
  specialties: "",
  description: "",
};

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function ReferralProfessionalsManager() {
  const [filter, setFilter] = useState<ProfessionalType | "all">("all");
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<ProfessionalForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: professionals, isLoading } = useQuery({
    queryKey: ["admin-referral-professionals", filter, search],
    queryFn: async () => {
      let query = supabase
        .from("referral_professionals")
        .select("*")
        .order("is_premium", { ascending: false })
        .order("created_at", { ascending: false });

      if (filter !== "all") {
        query = query.eq("professional_type", filter);
      }
      if (search) {
        query = query.or(`name.ilike.%${search}%,company.ilike.%${search}%`);
      }

      const { data, error } = await query.limit(100);
      if (error) throw error;
      return data || [];
    },
  });

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("referral_professionals").insert({
        professional_type: form.professional_type,
        name: form.name.trim(),
        company: form.company.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        website: form.website.trim() || null,
        states_served: form.states_served,
        specialties: form.specialties.split(",").map(s => s.trim()).filter(Boolean),
        description: form.description.trim() || null,
      });
      if (error) throw error;
      toast({ title: "Professional added" });
      setForm(EMPTY_FORM);
      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin-referral-professionals"] });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this professional?")) return;
    await supabase.from("referral_professionals").update({ is_active: false }).eq("id", id);
    queryClient.invalidateQueries({ queryKey: ["admin-referral-professionals"] });
    toast({ title: "Professional removed" });
  };

  const handleSearchProfessionals = async (type: ProfessionalType, state: string) => {
    setSearching(true);
    try {
      const { data, error } = await supabase.functions.invoke("referral-engine", {
        body: { action: "search_local_professionals", professionalType: type, state },
      });
      if (error) throw error;
      toast({ title: `Found ${data?.stored || 0} professionals`, description: "They've been added to the database." });
      queryClient.invalidateQueries({ queryKey: ["admin-referral-professionals"] });
    } catch (err: any) {
      toast({ title: "Search failed", description: err.message, variant: "destructive" });
    } finally {
      setSearching(false);
    }
  };

  const handleStartCheckout = async (professionalId: string, professionalType: string) => {
    try {
      const { data, error } = await supabase.functions.invoke("referral-checkout", {
        body: { professionalId, professionalType },
      });
      if (error) throw error;
      if (data?.url) {
        window.open(data.url, "_blank");
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-lg font-semibold text-foreground">Referral Professionals</h3>
        <div className="flex items-center gap-2">
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add Professional</Button>
            </DialogTrigger>
            <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add Professional</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <Label>Type</Label>
                  <Select value={form.professional_type} onValueChange={(v) => setForm({ ...form, professional_type: v as ProfessionalType })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="contractor">Contractor</SelectItem>
                      <SelectItem value="public_adjuster">Public Adjuster</SelectItem>
                      <SelectItem value="attorney">Attorney</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Name *</Label>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div>
                  <Label>Company</Label>
                  <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div>
                  <Label>Phone</Label>
                  <Input
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: formatPhone(e.target.value) })}
                    placeholder="xxx-xxx-xxxx"
                  />
                </div>
                <div>
                  <Label>Website</Label>
                  <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://" />
                </div>
                <div>
                  <Label>States Served</Label>
                  <div className="flex flex-wrap gap-1 mt-1 max-h-24 overflow-y-auto border rounded p-2">
                    {US_STATES.map(s => (
                      <button
                        key={s}
                        type="button"
                        className={`px-2 py-0.5 text-xs rounded ${form.states_served.includes(s) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"}`}
                        onClick={() =>
                          setForm({
                            ...form,
                            states_served: form.states_served.includes(s)
                              ? form.states_served.filter(x => x !== s)
                              : [...form.states_served, s],
                          })
                        }
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label>Specialties (comma-separated)</Label>
                  <Input value={form.specialties} onChange={(e) => setForm({ ...form, specialties: e.target.value })} placeholder="Roofing, Water Damage, Storm" />
                </div>
                <div>
                  <Label>Description</Label>
                  <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} />
                </div>
                <Button onClick={handleSave} disabled={saving} className="w-full">
                  {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                  Add Professional
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <Select value={filter} onValueChange={(v) => setFilter(v as any)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="contractor">Contractors</SelectItem>
            <SelectItem value="public_adjuster">Public Adjusters</SelectItem>
            <SelectItem value="attorney">Attorneys</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="Search name or company..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={searching}
          onClick={() => handleSearchProfessionals(filter === "all" ? "contractor" : filter as ProfessionalType, "NJ")}
        >
          {searching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />}
          Auto-Search
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : (
        <div className="space-y-2">
          {(professionals || []).map((pro) => (
            <Card key={pro.id} className={`border ${pro.is_premium ? "border-primary/40" : "border-border"}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground">{pro.name}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {pro.professional_type === "public_adjuster" ? "Public Adjuster" : pro.professional_type === "attorney" ? "Attorney" : "Contractor"}
                      </Badge>
                      {pro.is_premium && (
                        <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px] gap-0.5">
                          <Crown className="h-2.5 w-2.5" /> Premium
                        </Badge>
                      )}
                      {pro.is_auto_discovered && (
                        <Badge variant="secondary" className="text-[10px]">Auto-discovered</Badge>
                      )}
                    </div>
                    {pro.company && <p className="text-xs text-muted-foreground">{pro.company}</p>}
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                      {pro.email && <span>{pro.email}</span>}
                      {pro.phone && <span>{pro.phone}</span>}
                      {pro.states_served?.length > 0 && <span>States: {pro.states_served.join(", ")}</span>}
                    </div>
                    {pro.rating > 0 && (
                      <div className="flex items-center gap-1 mt-1">
                        <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
                        <span className="text-xs">{Number(pro.rating).toFixed(1)}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {!pro.is_premium && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => handleStartCheckout(pro.id, pro.professional_type)}
                      >
                        <Crown className="h-3 w-3 mr-1" /> Upgrade
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 text-destructive" onClick={() => handleDelete(pro.id)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {(professionals || []).length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">No professionals found. Add one or use Auto-Search.</p>
          )}
        </div>
      )}
    </div>
  );
}
