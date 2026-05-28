import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Building2, Phone, Mail, User, Globe, Hash, MapPin,
  Pencil, Save, X, ExternalLink, Printer, Plus, Link2,
} from "lucide-react";
import {
  MortgageCompanyEditorDialog,
  type MortgageCompanyRecord,
} from "@/components/checks/MortgageCompanyEditorDialog";
import { queryKeys } from "@/lib/queryKeys";

interface Props {
  lossDraftId: string;
  servicerName: string;
  onUpdated?: () => void;
}

interface DraftRow {
  mortgage_company_id: string | null;
  loan_number: string | null;
  lender_website_url: string | null;
  /* Legacy fallback fields — only shown when no directory link exists yet */
  loss_draft_contact: string | null;
  loss_draft_phone: string | null;
  loss_draft_email: string | null;
  loss_draft_fax: string | null;
}

const DRAFT_FIELDS =
  "mortgage_company_id, loan_number, lender_website_url, loss_draft_contact, loss_draft_phone, loss_draft_email, loss_draft_fax";

const STALE_MS = 5 * 60 * 1000;

export function MortgageContactCard({ lossDraftId, servicerName, onUpdated }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false);
  const [loanForm, setLoanForm] = useState({ loan_number: "", lender_website_url: "" });

  // Loss-draft row (link + claim-specific fields)
  // NOTE: This query intentionally uses its OWN cache key — not
  // queryKeys.lossDraft.detail — because it selects a narrower set of
  // columns. Sharing the key with useLossDraftDetail would clobber the
  // parent panel's `draft` cache (e.g. mortgage_servicer would disappear
  // after any action that invalidates the detail key).
  const { data: draft } = useQuery({
    queryKey: ["loss-draft-mortgage-contact", lossDraftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_tracking")
        .select(DRAFT_FIELDS)
        .eq("id", lossDraftId)
        .single();
      if (error) throw error;
      return data as DraftRow;
    },
    staleTime: STALE_MS,
  });


  // Linked directory entry
  const { data: company } = useQuery({
    queryKey: queryKeys.mortgageCompany.detail(draft?.mortgage_company_id ?? ""),
    queryFn: async () => {
      if (!draft?.mortgage_company_id) return null;
      const { data } = await supabase
        .from("mortgage_companies")
        .select(
          "id, name, contact_name, phone, phone_extension, email, mortgage_site, address_line_1, address_line_2, address_line_3, address_line_4, address_line_5"
        )
        .eq("id", draft.mortgage_company_id)
        .maybeSingle();
      return (data as MortgageCompanyRecord | null) ?? null;
    },
    enabled: !!draft?.mortgage_company_id,
    staleTime: STALE_MS,
  });

  // Suggested directory match (when no link yet) — fuzzy by lowered name
  const { data: suggestion } = useQuery({
    queryKey: queryKeys.mortgageCompany.suggestionForName(servicerName ?? ""),
    queryFn: async () => {
      if (!servicerName?.trim()) return null;
      const { data } = await supabase
        .from("mortgage_companies")
        .select("id, name")
        .eq("is_active", true)
        .ilike("name", `%${servicerName.trim()}%`)
        .limit(1)
        .maybeSingle();
      return data as { id: string; name: string } | null;
    },
    enabled: !!servicerName && !draft?.mortgage_company_id,
    staleTime: STALE_MS,
  });

  useEffect(() => {
    if (draft) {
      setLoanForm({
        loan_number: draft.loan_number ?? "",
        lender_website_url: draft.lender_website_url ?? "",
      });
    }
  }, [draft]);

  const linkCompany = async (companyId: string) => {
    const { error } = await supabase
      .from("loss_draft_tracking")
      .update({ mortgage_company_id: companyId })
      .eq("id", lossDraftId);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Linked to directory" });
    qc.invalidateQueries({ queryKey: ["loss-draft-mortgage-contact", lossDraftId] });
    qc.invalidateQueries({ queryKey: queryKeys.lossDraft.detail(lossDraftId) });

    onUpdated?.();
  };

  const saveLoanInfo = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("loss_draft_tracking")
        .update({
          loan_number: loanForm.loan_number.trim() || null,
          lender_website_url: loanForm.lender_website_url.trim() || null,
        })
        .eq("id", lossDraftId);
      if (error) throw error;
      toast({ title: "Saved" });
      setEditing(false);
      qc.invalidateQueries({ queryKey: queryKeys.lossDraft.detail(lossDraftId) });
      onUpdated?.();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // Address from directory only
  const addressLines = company
    ? [
        company.address_line_1,
        company.address_line_2,
        company.address_line_3,
        company.address_line_4,
        company.address_line_5,
      ].filter((l): l is string => !!l && l.trim().length > 0)
    : [];

  // Display values: prefer directory; fall back to legacy per-draft fields if not yet linked
  const display = {
    contact: company?.contact_name ?? draft?.loss_draft_contact ?? null,
    phone:
      (company?.phone
        ? company.phone + (company.phone_extension ? ` x${company.phone_extension}` : "")
        : null) ?? draft?.loss_draft_phone ?? null,
    email: company?.email ?? draft?.loss_draft_email ?? null,
    fax: draft?.loss_draft_fax ?? null,
    portal: loanForm.lender_website_url || company?.mortgage_site || null,
  };

  return (
    <div className="border rounded-lg p-3 space-y-3 bg-card">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5 min-w-0">
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{company?.name || "Mortgage Contact"}</span>
        </p>
        <div className="flex items-center gap-1 shrink-0">
          {company ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setCompanyDialogOpen(true)}
              title="Edit directory entry"
            >
              <Pencil className="h-3 w-3 mr-1" /> Edit Company
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setCompanyDialogOpen(true)}
              title="Add to directory"
            >
              <Plus className="h-3 w-3 mr-1" /> Add to Directory
            </Button>
          )}
        </div>
      </div>

      {/* Suggested link banner */}
      {!company && suggestion && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-primary/10 border border-primary/20 p-2 text-xs">
          <span className="flex items-center gap-1.5 text-primary truncate">
            <Link2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Match found: {suggestion.name}</span>
          </span>
          <Button size="sm" className="h-6 px-2 text-xs" onClick={() => linkCompany(suggestion.id)}>
            Link
          </Button>
        </div>
      )}

      {/* Contact rows (read-only — sourced from directory) */}
      <div className="space-y-1.5 text-xs">
        <Row icon={<User className="h-3.5 w-3.5" />} label="Contact" value={display.contact} />
        <Row
          icon={<Phone className="h-3.5 w-3.5" />}
          label="Phone"
          value={display.phone}
          href={display.phone ? `tel:${display.phone.replace(/[^\d+]/g, "")}` : undefined}
        />
        <Row
          icon={<Mail className="h-3.5 w-3.5" />}
          label="Email"
          value={display.email}
          href={display.email ? `mailto:${display.email}` : undefined}
        />
        {display.fax && (
          <Row icon={<Printer className="h-3.5 w-3.5" />} label="Fax" value={display.fax} />
        )}

        {addressLines.length > 0 && (
          <div className="pt-1.5 border-t mt-1.5">
            <div className="flex items-start gap-1.5 text-muted-foreground">
              <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <p className="text-[10px] uppercase tracking-wide">Address</p>
                {addressLines.map((l, i) => (
                  <p key={i} className="text-xs text-foreground">
                    {l}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Per-claim fields: loan # + portal URL */}
      <div className="border-t pt-2 space-y-1.5 text-xs">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Claim-Specific</p>
          {!editing ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-2.5 w-2.5 mr-0.5" /> Edit
            </Button>
          ) : (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => {
                  setEditing(false);
                  setLoanForm({
                    loan_number: draft?.loan_number ?? "",
                    lender_website_url: draft?.lender_website_url ?? "",
                  });
                }}
                disabled={saving}
              >
                <X className="h-2.5 w-2.5" />
              </Button>
              <Button
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={saveLoanInfo}
                disabled={saving}
              >
                <Save className="h-2.5 w-2.5 mr-0.5" />
                {saving ? "…" : "Save"}
              </Button>
            </div>
          )}
        </div>

        {!editing ? (
          <>
            <Row icon={<Hash className="h-3.5 w-3.5" />} label="Loan #" value={loanForm.loan_number} />
            <Row
              icon={<Globe className="h-3.5 w-3.5" />}
              label="Portal"
              value={display.portal}
              href={display.portal || undefined}
              external
            />
          </>
        ) : (
          <div className="space-y-2">
            <div>
              <Label className="text-[10px] text-muted-foreground">Loan #</Label>
              <Input
                value={loanForm.loan_number}
                onChange={(e) => setLoanForm({ ...loanForm, loan_number: e.target.value })}
                placeholder="0000000000"
                className="h-7 text-xs"
                maxLength={64}
              />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">Portal URL (override)</Label>
              <Input
                value={loanForm.lender_website_url}
                onChange={(e) =>
                  setLoanForm({ ...loanForm, lender_website_url: e.target.value })
                }
                placeholder={company?.mortgage_site || "https://..."}
                className="h-7 text-xs"
                maxLength={500}
              />
            </div>
          </div>
        )}
      </div>

      {!company && !suggestion && servicerName && (
        <p className="text-[10px] text-muted-foreground italic">
          No directory entry for "{servicerName}". Add one to share contact details across all
          claims.
        </p>
      )}

      <MortgageCompanyEditorDialog
        open={companyDialogOpen}
        onOpenChange={setCompanyDialogOpen}
        company={company ?? null}
        initialName={!company ? servicerName : undefined}
        onSaved={async (saved) => {
          if (!company) {
            // New entry — link it to this draft
            await linkCompany(saved.id);
          }
          qc.invalidateQueries({ queryKey: queryKeys.mortgageCompany.detail(saved.id) });
          qc.invalidateQueries({ queryKey: queryKeys.mortgageCompany.suggestionForName(servicerName) });
        }}
      />
    </div>
  );
}

function Row({
  icon,
  label,
  value,
  href,
  external,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null | undefined;
  href?: string;
  external?: boolean;
}) {
  const display = value && value.trim().length > 0 ? value : null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground shrink-0">{icon}</span>
      <span className="text-muted-foreground w-14 shrink-0">{label}</span>
      {display ? (
        href ? (
          <a
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            className="text-foreground hover:underline truncate flex items-center gap-1"
          >
            <span className="truncate">{display}</span>
            {external && <ExternalLink className="h-3 w-3 shrink-0" />}
          </a>
        ) : (
          <span className="text-foreground truncate">{display}</span>
        )
      ) : (
        <span className="text-muted-foreground italic">—</span>
      )}
    </div>
  );
}
