import { useEffect, useState } from "react";
import { supabase as defaultSupabase } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Globe } from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";

export interface MortgageCompanyRecord {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  phone_extension: string | null;
  email: string | null;
  mortgage_site: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  address_line_3: string | null;
  address_line_4: string | null;
  address_line_5: string | null;
  is_active?: boolean;
}

const empty = {
  name: "",
  contact_name: "",
  email: "",
  phone: "",
  phone_extension: "",
  mortgage_site: "",
  address_line_1: "",
  address_line_2: "",
  address_line_3: "",
  address_line_4: "",
  address_line_5: "",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing company to edit. If omitted, the dialog creates a new one. */
  company?: MortgageCompanyRecord | null;
  /** Pre-fill the name field when creating a new entry (e.g. from a loss draft). */
  initialName?: string;
  onSaved?: (saved: MortgageCompanyRecord) => void;
  /** Supabase client to use — defaults to the ChecksOps client. Pass mortgageSupabase from the Mortgage Ops portal. */
  supabaseClient?: SupabaseClient<any>;
}

export function MortgageCompanyEditorDialog({
  open,
  onOpenChange,
  company,
  initialName,
  onSaved,
}: Props) {
  const [form, setForm] = useState({ ...empty });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (company) {
      setForm({
        name: company.name,
        contact_name: company.contact_name || "",
        email: company.email || "",
        phone: company.phone || "",
        phone_extension: company.phone_extension || "",
        mortgage_site: company.mortgage_site || "",
        address_line_1: company.address_line_1 || "",
        address_line_2: company.address_line_2 || "",
        address_line_3: company.address_line_3 || "",
        address_line_4: company.address_line_4 || "",
        address_line_5: company.address_line_5 || "",
      });
    } else {
      setForm({ ...empty, name: initialName ?? "" });
    }
  }, [open, company, initialName]);

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Company name is required");
      return;
    }
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      contact_name: form.contact_name.trim() || null,
      phone: form.phone.trim() || null,
      phone_extension: form.phone_extension.trim() || null,
      email: form.email.trim() || null,
      mortgage_site: form.mortgage_site.trim() || null,
      address_line_1: form.address_line_1.trim() || null,
      address_line_2: form.address_line_2.trim() || null,
      address_line_3: form.address_line_3.trim() || null,
      address_line_4: form.address_line_4.trim() || null,
      address_line_5: form.address_line_5.trim() || null,
    };

    const { data, error } = company
      ? await supabase
          .from("mortgage_companies")
          .update(payload)
          .eq("id", company.id)
          .select()
          .single()
      : await supabase.from("mortgage_companies").insert([payload]).select().single();

    setSaving(false);
    if (error || !data) {
      toast.error(company ? "Failed to update company" : "Failed to add company");
      return;
    }
    toast.success(company ? "Company updated" : "Company added");
    onSaved?.(data as MortgageCompanyRecord);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{company ? "Edit Mortgage Company" : "Add Mortgage Company"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b pb-1">
              Company
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <Label>Company Name *</Label>
                <Input
                  value={form.name}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Mr. Cooper"
                />
              </div>
              <div>
                <Label>Contact Name</Label>
                <Input
                  value={form.contact_name}
                  maxLength={120}
                  onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                  placeholder="Loss draft dept rep"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.email}
                  maxLength={255}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="lossdraft@servicer.com"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Label>Phone</Label>
                  <Input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: formatPhoneNumber(e.target.value) })}
                    placeholder="123-456-7890"
                  />
                </div>
                <div>
                  <Label>Ext</Label>
                  <Input
                    value={form.phone_extension}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        phone_extension: e.target.value.replace(/\D/g, "").slice(0, 6),
                      })
                    }
                    placeholder="1234"
                  />
                </div>
              </div>
              <div className="md:col-span-2">
                <Label className="flex items-center gap-1.5">
                  <Globe className="h-3 w-3" /> Portal URL
                </Label>
                <Input
                  type="url"
                  value={form.mortgage_site}
                  maxLength={500}
                  onChange={(e) => setForm({ ...form, mortgage_site: e.target.value })}
                  placeholder="https://insurance.servicer.com"
                />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b pb-1">
              Address
            </h3>
            <div className="space-y-2">
              <Input
                value={form.address_line_1}
                maxLength={200}
                onChange={(e) => setForm({ ...form, address_line_1: e.target.value })}
                placeholder="Address line 1"
              />
              <Input
                value={form.address_line_2}
                maxLength={200}
                onChange={(e) => setForm({ ...form, address_line_2: e.target.value })}
                placeholder="Address line 2 (suite, attn, etc.)"
              />
              <Input
                value={form.address_line_3}
                maxLength={200}
                onChange={(e) => setForm({ ...form, address_line_3: e.target.value })}
                placeholder="City, State ZIP"
              />
              <Input
                value={form.address_line_4}
                maxLength={200}
                onChange={(e) => setForm({ ...form, address_line_4: e.target.value })}
                placeholder="Address line 4 (optional)"
              />
              <Input
                value={form.address_line_5}
                maxLength={200}
                onChange={(e) => setForm({ ...form, address_line_5: e.target.value })}
                placeholder="Address line 5 (optional)"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : company ? "Save Changes" : "Add Company"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
