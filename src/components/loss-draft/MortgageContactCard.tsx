import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Building2, Phone, Mail, User, Globe, Hash, MapPin,
  Pencil, Save, X, ExternalLink, Printer,
} from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";

interface Props {
  lossDraftId: string;
  servicerName: string;
  onUpdated?: () => void;
}

interface ContactFields {
  loss_draft_contact: string | null;
  loss_draft_phone: string | null;
  loss_draft_email: string | null;
  loss_draft_fax: string | null;
  loan_number: string | null;
  lender_website_url: string | null;
}

interface CompanyInfo {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  phone_extension: string | null;
  email: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  address_line_3: string | null;
  address_line_4: string | null;
  address_line_5: string | null;
}

const empty: ContactFields = {
  loss_draft_contact: "",
  loss_draft_phone: "",
  loss_draft_email: "",
  loss_draft_fax: "",
  loan_number: "",
  lender_website_url: "",
};

export function MortgageContactCard({ lossDraftId, servicerName, onUpdated }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ContactFields>(empty);

  // Loss-draft level contact (claim-specific)
  const { data: draftContact } = useQuery({
    queryKey: ["loss-draft-contact", lossDraftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loss_draft_tracking")
        .select(
          "loss_draft_contact, loss_draft_phone, loss_draft_email, loss_draft_fax, loan_number, lender_website_url"
        )
        .eq("id", lossDraftId)
        .single();
      if (error) throw error;
      return data as ContactFields;
    },
  });

  // Mortgage company directory entry (shared address book)
  const { data: company } = useQuery({
    queryKey: ["mortgage-company-by-name", servicerName],
    queryFn: async () => {
      if (!servicerName) return null;
      const { data } = await supabase
        .from("mortgage_companies")
        .select(
          "id, name, contact_name, phone, phone_extension, email, address_line_1, address_line_2, address_line_3, address_line_4, address_line_5"
        )
        .ilike("name", servicerName.trim())
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      return (data as CompanyInfo | null) ?? null;
    },
    enabled: !!servicerName,
  });

  useEffect(() => {
    if (draftContact) {
      setForm({
        loss_draft_contact: draftContact.loss_draft_contact ?? "",
        loss_draft_phone: draftContact.loss_draft_phone ?? "",
        loss_draft_email: draftContact.loss_draft_email ?? "",
        loss_draft_fax: draftContact.loss_draft_fax ?? "",
        loan_number: draftContact.loan_number ?? "",
        lender_website_url: draftContact.lender_website_url ?? "",
      });
    }
  }, [draftContact]);

  const startEdit = () => setEditing(true);
  const cancelEdit = () => {
    if (draftContact) {
      setForm({
        loss_draft_contact: draftContact.loss_draft_contact ?? "",
        loss_draft_phone: draftContact.loss_draft_phone ?? "",
        loss_draft_email: draftContact.loss_draft_email ?? "",
        loss_draft_fax: draftContact.loss_draft_fax ?? "",
        loan_number: draftContact.loan_number ?? "",
        lender_website_url: draftContact.lender_website_url ?? "",
      });
    }
    setEditing(false);
  };

  const pullFromDirectory = () => {
    if (!company) return;
    setForm((f) => ({
      ...f,
      loss_draft_contact: f.loss_draft_contact || company.contact_name || "",
      loss_draft_phone:
        f.loss_draft_phone ||
        (company.phone
          ? company.phone + (company.phone_extension ? ` x${company.phone_extension}` : "")
          : ""),
      loss_draft_email: f.loss_draft_email || company.email || "",
    }));
    toast({ title: "Pulled from directory", description: company.name });
  };

  const save = async () => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("loss_draft_tracking")
        .update({
          loss_draft_contact: form.loss_draft_contact?.trim() || null,
          loss_draft_phone: form.loss_draft_phone?.trim() || null,
          loss_draft_email: form.loss_draft_email?.trim() || null,
          loss_draft_fax: form.loss_draft_fax?.trim() || null,
          loan_number: form.loan_number?.trim() || null,
          lender_website_url: form.lender_website_url?.trim() || null,
        })
        .eq("id", lossDraftId);
      if (error) throw error;
      toast({ title: "Contact info saved" });
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["loss-draft-contact", lossDraftId] });
      onUpdated?.();
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const addressLines = company
    ? [
        company.address_line_1,
        company.address_line_2,
        company.address_line_3,
        company.address_line_4,
        company.address_line_5,
      ].filter((l): l is string => !!l && l.trim().length > 0)
    : [];

  return (
    <div className="border rounded-lg p-3 space-y-3 bg-card">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5" />
          Mortgage Contact
        </p>
        {!editing ? (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={startEdit}>
            <Pencil className="h-3 w-3 mr-1" /> Edit
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            {company && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={pullFromDirectory}
                title={`Use details from ${company.name}`}
              >
                Use Directory
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={cancelEdit}
              disabled={saving}
            >
              <X className="h-3 w-3" />
            </Button>
            <Button size="sm" className="h-6 px-2 text-xs" onClick={save} disabled={saving}>
              <Save className="h-3 w-3 mr-1" />
              {saving ? "Saving..." : "Save"}
            </Button>
          </div>
        )}
      </div>

      {!editing ? (
        <div className="space-y-1.5 text-xs">
          <Row
            icon={<User className="h-3.5 w-3.5" />}
            label="Contact"
            value={form.loss_draft_contact}
          />
          <Row
            icon={<Phone className="h-3.5 w-3.5" />}
            label="Phone"
            value={form.loss_draft_phone}
            href={form.loss_draft_phone ? `tel:${form.loss_draft_phone.replace(/[^\d+]/g, "")}` : undefined}
          />
          <Row
            icon={<Mail className="h-3.5 w-3.5" />}
            label="Email"
            value={form.loss_draft_email}
            href={form.loss_draft_email ? `mailto:${form.loss_draft_email}` : undefined}
          />
          <Row
            icon={<Printer className="h-3.5 w-3.5" />}
            label="Fax"
            value={form.loss_draft_fax}
          />
          <Row icon={<Hash className="h-3.5 w-3.5" />} label="Loan #" value={form.loan_number} />
          <Row
            icon={<Globe className="h-3.5 w-3.5" />}
            label="Portal"
            value={form.lender_website_url}
            href={form.lender_website_url || undefined}
            external
          />

          {addressLines.length > 0 && (
            <div className="pt-1.5 border-t mt-1.5">
              <div className="flex items-start gap-1.5 text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div className="space-y-0.5">
                  <p className="text-[10px] uppercase tracking-wide">Address (from directory)</p>
                  {addressLines.map((l, i) => (
                    <p key={i} className="text-xs text-foreground">
                      {l}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!company && servicerName && (
            <p className="text-[10px] text-muted-foreground italic pt-1">
              No directory entry for "{servicerName}". Add one in Networking → Mortgage Companies
              to keep address & contact details on file.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Field label="Contact Name">
            <Input
              value={form.loss_draft_contact ?? ""}
              onChange={(e) => setForm({ ...form, loss_draft_contact: e.target.value })}
              placeholder="Loss draft dept rep"
              className="h-8 text-xs"
              maxLength={120}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone">
              <Input
                value={form.loss_draft_phone ?? ""}
                onChange={(e) =>
                  setForm({ ...form, loss_draft_phone: formatPhoneNumber(e.target.value) })
                }
                placeholder="123-456-7890"
                className="h-8 text-xs"
                maxLength={32}
              />
            </Field>
            <Field label="Fax">
              <Input
                value={form.loss_draft_fax ?? ""}
                onChange={(e) =>
                  setForm({ ...form, loss_draft_fax: formatPhoneNumber(e.target.value) })
                }
                placeholder="123-456-7890"
                className="h-8 text-xs"
                maxLength={32}
              />
            </Field>
          </div>
          <Field label="Email">
            <Input
              type="email"
              value={form.loss_draft_email ?? ""}
              onChange={(e) => setForm({ ...form, loss_draft_email: e.target.value })}
              placeholder="lossdraft@servicer.com"
              className="h-8 text-xs"
              maxLength={255}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Loan #">
              <Input
                value={form.loan_number ?? ""}
                onChange={(e) => setForm({ ...form, loan_number: e.target.value })}
                placeholder="0000000000"
                className="h-8 text-xs"
                maxLength={64}
              />
            </Field>
            <Field label="Portal URL">
              <Input
                value={form.lender_website_url ?? ""}
                onChange={(e) => setForm({ ...form, lender_website_url: e.target.value })}
                placeholder="https://..."
                className="h-8 text-xs"
                maxLength={500}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      {children}
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
