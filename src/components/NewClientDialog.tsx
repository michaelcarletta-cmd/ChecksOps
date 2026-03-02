import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generateClientPassword } from "@/lib/generateClientPassword";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { CredentialsDialog } from "@/components/CredentialsDialog";
import { formatPhoneNumber } from "@/lib/utils";

interface NewClientDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onClientCreated: () => void;
}

export const NewClientDialog = ({
  isOpen,
  onClose,
  onClientCreated,
}: NewClientDialogProps) => {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    street: "",
    city: "",
    state: "",
    zipCode: "",
  });
  const [isSaving, setIsSaving] = useState(false);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    try {
      let tempPassword: string | null = null;

      // Create user account if email is provided
      if (formData.email) {
        tempPassword = generateClientPassword(formData.name || "Client");
        
        // Use edge function to create user without auto-login
        const { data: funcData, error: funcError } = await supabase.functions.invoke(
          "create-portal-user",
          {
            body: {
              email: formData.email,
              password: tempPassword,
              fullName: formData.name,
              role: "client",
              phone: formData.phone || undefined,
            },
          }
        );

        if (funcError) throw funcError;
        if (funcData?.error) throw new Error(funcData.error);
      }

      // Create client record
      const { error } = await supabase.from("clients").insert({
        name: formData.name,
        email: formData.email || null,
        phone: formData.phone || null,
        street: formData.street || null,
        city: formData.city || null,
        state: formData.state || null,
        zip_code: formData.zipCode || null,
      });

      if (error) throw error;

      onClientCreated();
      onClose();
      setFormData({ name: "", email: "", phone: "", street: "", city: "", state: "", zipCode: "" });
      
      if (tempPassword && formData.email) {
        setCredentials({ email: formData.email, password: tempPassword });
      } else {
        toast.success("Client created (no portal access - email required)");
      }
    } catch (error) {
      console.error("Error creating client:", error);
      toast.error("Failed to create client");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Client</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => handleChange("name", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => handleChange("email", e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => handleChange("phone", formatPhoneNumber(e.target.value))}
                  placeholder="123-456-7890"
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="street">Street</Label>
                <Input
                  id="street"
                  value={formData.street}
                  onChange={(e) => handleChange("street", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="city">City</Label>
                <Input
                  id="city"
                  value={formData.city}
                  onChange={(e) => handleChange("city", e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="state">State</Label>
                <Input
                  id="state"
                  value={formData.state}
                  onChange={(e) => handleChange("state", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zip">ZIP Code</Label>
                <Input
                  id="zip"
                  value={formData.zipCode}
                  onChange={(e) => handleChange("zipCode", e.target.value)}
                />
              </div>
            </div>

            <div className="flex gap-3 justify-end">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? "Creating..." : "Create Client"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {credentials && (
        <CredentialsDialog
          isOpen={!!credentials}
          onClose={() => setCredentials(null)}
          email={credentials.email}
          password={credentials.password}
          userType="Client"
        />
      )}
    </>
  );
};
