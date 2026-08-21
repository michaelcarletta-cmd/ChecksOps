import { useEffect, useMemo, useState } from "react";
import { mortgageSupabase as supabase } from "@/integrations/supabase/mortgageClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Building2, Mail, Phone, Globe, MapPin, Search, User, Loader2, Plus, Pencil, Trash2,
} from "lucide-react";
import {
  MortgageCompanyEditorDialog,
  type MortgageCompanyRecord,
} from "@/components/checks/MortgageCompanyEditorDialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SectionCard } from "@/components/settings/SectionCard";

function formatAddress(c: MortgageCompanyRecord) {
  return [c.address_line_1, c.address_line_2, c.address_line_3, c.address_line_4, c.address_line_5]
    .filter((l) => l && l.trim())
    .join(", ");
}

export function MortgageOpsDirectory() {
  const [companies, setCompanies] = useState<MortgageCompanyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MortgageCompanyRecord | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<MortgageCompanyRecord | null>(null);

  const fetchCompanies = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("mortgage_companies")
      .select(
        "id, name, contact_name, phone, phone_extension, email, mortgage_site, address_line_1, address_line_2, address_line_3, address_line_4, address_line_5, is_active"
      )
      .eq("is_active", true)
      .order("name");
    if (error) {
      toast.error("Failed to load mortgage directory");
    } else {
      setCompanies((data || []) as MortgageCompanyRecord[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void fetchCompanies();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.contact_name?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q) ||
        formatAddress(c).toLowerCase().includes(q)
    );
  }, [companies, search]);

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (c: MortgageCompanyRecord) => { setEditing(c); setDialogOpen(true); };

  const confirmDeactivate = async () => {
    if (!deactivateTarget) return;
    const { error } = await supabase
      .from("mortgage_companies")
      .update({ is_active: false })
      .eq("id", deactivateTarget.id);
    if (error) {
      toast.error("Failed to remove company");
    } else {
      toast.success(`${deactivateTarget.name} removed from directory`);
      setDeactivateTarget(null);
      void fetchCompanies();
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Mortgage Directory"
        icon={<Building2 className="h-4 w-4 text-sky-400" />}
        accent="bg-sky-500"
        description="Phone numbers, emails, mailing addresses, and online claim check portals for mortgage servicers."
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Badge variant="secondary">{companies.length} companies</Badge>
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" /> Add Company
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by company, contact, phone, email, or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </SectionCard>


      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No mortgage companies match your search.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((c) => {
            const address = formatAddress(c);
            return (
              <Card key={c.id} className="overflow-hidden border-border/60 shadow-sm">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Building2 className="h-4 w-4 text-primary" />
                      {c.name}
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => openEdit(c)}
                        aria-label="Edit company"
                        title="Edit company"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeactivateTarget(c)}
                        aria-label="Remove company from directory"
                        title="Remove from directory"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {c.contact_name && (
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <span>{c.contact_name}</span>
                    </div>
                  )}
                  {c.phone && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <a href={`tel:${c.phone}`} className="hover:underline">
                        {c.phone}
                        {c.phone_extension ? ` ext. ${c.phone_extension}` : ""}
                      </a>
                    </div>
                  )}
                  {c.email && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <a href={`mailto:${c.email}`} className="hover:underline break-all">
                        {c.email}
                      </a>
                    </div>
                  )}
                  {c.mortgage_site ? (
                    <div className="flex items-start gap-2">
                      <Globe className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <div className="flex flex-col">
                        <span className="text-xs text-muted-foreground">Online claim check portal</span>
                        <a
                          href={c.mortgage_site.startsWith("http") ? c.mortgage_site : `https://${c.mortgage_site}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline break-all"
                        >
                          {c.mortgage_site}
                        </a>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Globe className="h-4 w-4" />
                      No online claim check portal — mail check to address above
                    </div>
                  )}
                  {address && (
                    <div className="flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {address}
                      </a>
                    </div>
                  )}
                  {!c.phone && !c.email && !address && (
                    <p className="text-xs text-muted-foreground italic">No contact details on file.</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <MortgageCompanyEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        company={editing}
        supabaseClient={supabase}
        onSaved={() => void fetchCompanies()}
      />

      <AlertDialog open={!!deactivateTarget} onOpenChange={(o) => !o && setDeactivateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {deactivateTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This hides the company from the directory. Existing loss drafts and mortgage requests
              tied to this company are not affected. You can re-add it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeactivate} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
