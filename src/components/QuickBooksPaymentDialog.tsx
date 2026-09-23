import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { supabase } from "@/integrations/aws/client";
import { Loader2, AlertCircle } from "lucide-react";

interface QuickBooksPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientName: string;
  recipientEmail?: string;
  recipientPhone?: string;
  defaultAmount?: number;
  onSuccess?: () => void;
}

interface BankAccount {
  Id: string;
  Name: string;
}

const QUICKBOOKS_STORAGE_KEY = 'quickbooks_connection';

export function QuickBooksPaymentDialog({
  open,
  onOpenChange,
  recipientName,
  recipientEmail,
  recipientPhone,
  defaultAmount,
  onSuccess,
}: QuickBooksPaymentDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [formData, setFormData] = useState({
    amount: defaultAmount?.toString() || "",
    bankAccountId: "",
    notes: "",
  });

  const getConnection = () => {
    const stored = localStorage.getItem(QUICKBOOKS_STORAGE_KEY);
    if (!stored) return null;
    return JSON.parse(stored);
  };

  const isConnected = () => {
    const conn = getConnection();
    return conn && conn.expiresAt > Date.now();
  };

  useEffect(() => {
    if (open && isConnected()) {
      fetchBankAccounts();
    }
  }, [open]);

  useEffect(() => {
    if (defaultAmount) {
      setFormData(prev => ({ ...prev, amount: defaultAmount.toString() }));
    }
  }, [defaultAmount]);

  const fetchBankAccounts = async () => {
    const conn = getConnection();
    if (!conn) return;

    setLoadingAccounts(true);
    try {
      const { data, error } = await supabase.functions.invoke('quickbooks-payment', {
        body: {
          action: 'get-accounts',
          accessToken: conn.accessToken,
          realmId: conn.realmId,
          isSandbox: true, // Using sandbox for testing
        },
      });

      if (error) throw error;
      setBankAccounts(data.accounts || []);
      if (data.accounts?.length > 0) {
        setFormData(prev => ({ ...prev, bankAccountId: data.accounts[0].Id }));
      }
    } catch (err) {
      console.error('Failed to fetch bank accounts:', err);
      toast.error('Failed to load bank accounts');
    } finally {
      setLoadingAccounts(false);
    }
  };

  const handleSubmit = async () => {
    if (!formData.amount || parseFloat(formData.amount) <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    if (!formData.bankAccountId) {
      toast.error('Please select a bank account');
      return;
    }

    const conn = getConnection();
    if (!conn) {
      toast.error('QuickBooks not connected');
      return;
    }

    setIsLoading(true);
    try {
      // First, search for or create the vendor
      let vendorId: string;

      const { data: searchData } = await supabase.functions.invoke('quickbooks-payment', {
        body: {
          action: 'search-vendor',
          accessToken: conn.accessToken,
          realmId: conn.realmId,
          isSandbox: true,
          vendorData: { name: recipientName },
        },
      });

      if (searchData?.vendors?.length > 0) {
        vendorId = searchData.vendors[0].Id;
      } else {
        // Create vendor
        const { data: createData, error: createError } = await supabase.functions.invoke('quickbooks-payment', {
          body: {
            action: 'create-vendor',
            accessToken: conn.accessToken,
            realmId: conn.realmId,
            isSandbox: true,
            vendorData: {
              name: recipientName,
              email: recipientEmail,
              phone: recipientPhone,
            },
          },
        });

        if (createError) throw createError;
        vendorId = createData.vendor.Id;
      }

      // Create the check payment
      const { data, error } = await supabase.functions.invoke('quickbooks-payment', {
        body: {
          action: 'create-check',
          accessToken: conn.accessToken,
          realmId: conn.realmId,
          isSandbox: true,
          paymentData: {
            vendorId,
            amount: parseFloat(formData.amount),
            bankAccountId: formData.bankAccountId,
            notes: formData.notes,
          },
        },
      });

      if (error) throw error;

      toast.success('Payment created in QuickBooks');
      onOpenChange(false);
      onSuccess?.();
      
      // Reset form
      setFormData({
        amount: "",
        bankAccountId: bankAccounts[0]?.Id || "",
        notes: "",
      });
    } catch (err: any) {
      console.error('Payment error:', err);
      toast.error(err.message || 'Failed to create payment');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isConnected()) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>QuickBooks Not Connected</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center gap-4 py-6">
            <AlertCircle className="h-12 w-12 text-yellow-500" />
            <p className="text-center text-muted-foreground">
              Please connect your QuickBooks account in Settings → Integrations 
              to send payments.
            </p>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pay via QuickBooks</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Recipient</Label>
            <Input value={recipientName} disabled className="bg-muted" />
          </div>

          <div>
            <Label>Amount *</Label>
            <Input
              type="number"
              step="0.01"
              placeholder="0.00"
              value={formData.amount}
              onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
            />
          </div>

          <div>
            <Label>Bank Account *</Label>
            {loadingAccounts ? (
              <div className="flex items-center gap-2 p-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Loading accounts...</span>
              </div>
            ) : (
              <Select
                value={formData.bankAccountId}
                onValueChange={(value) => setFormData({ ...formData, bankAccountId: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select bank account" />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((account) => (
                    <SelectItem key={account.Id} value={account.Id}>
                      {account.Name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea
              placeholder="Optional payment notes"
              value={formData.notes}
              onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
            />
          </div>

          <div className="flex gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} className="flex-1">
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isLoading} className="flex-1">
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing...
                </>
              ) : (
                'Send Payment'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
