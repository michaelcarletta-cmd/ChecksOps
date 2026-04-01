import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";
import { format } from "date-fns";
import { DollarSign, Trash2, CreditCard, FileCheck } from "lucide-react";
import { QuickBooksPaymentDialog } from "@/components/QuickBooksPaymentDialog";
import { CheckbookPaymentDialog } from "@/components/CheckbookPaymentDialog";

interface ClaimPaymentsProps {
  claimId: string;
  isAdmin: boolean;
}

interface Payment {
  id: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  check_number: string | null;
  recipient_type: string;
  recipient_id: string | null;
  notes: string | null;
  direction: string | null;
}

interface Contractor {
  id: string;
  full_name: string | null;
  email: string;
}

interface Referrer {
  id: string;
  name: string;
  email: string | null;
}

export function ClaimPayments({ claimId, isAdmin }: ClaimPaymentsProps) {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [referrers, setReferrers] = useState<Referrer[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [qbPaymentOpen, setQbPaymentOpen] = useState(false);
  const [checkbookPaymentOpen, setCheckbookPaymentOpen] = useState(false);
  const [selectedRecipient, setSelectedRecipient] = useState<{ 
    name: string; 
    email?: string; 
    phone?: string;
    type: 'contractor' | 'client' | 'referrer';
  } | null>(null);
  const [formData, setFormData] = useState({
    payment_date: new Date().toISOString().split("T")[0],
    amount: "",
    payment_method: "check",
    check_number: "",
    recipient_type: "contractor",
    recipient_id: "",
    notes: "",
  });

  useEffect(() => {
    fetchPayments();
    fetchContractors();
    fetchReferrers();
  }, [claimId]);

  const fetchPayments = async () => {
    const start = performance.now();
    const { data, error } = await supabase
      .from("claim_payments")
      .select("id, payment_date, amount, payment_method, check_number, recipient_type, recipient_id, notes, direction")
      .eq("claim_id", claimId)
      .order("payment_date", { ascending: false });
    console.log(`[query] fetchClaimPayments: ${(performance.now() - start).toFixed(2)}ms`);

    if (error) {
      toast.error("Failed to fetch payments");
      return;
    }

    setPayments(data || []);
  };

  const fetchContractors = async () => {
    const { data: roleData } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "contractor");

    if (roleData && roleData.length > 0) {
      const contractorIds = roleData.map((r) => r.user_id);
      const { data: profileData } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", contractorIds);

      setContractors(profileData || []);
    }
  };

  const fetchReferrers = async () => {
    const { data } = await supabase
      .from("referrers")
      .select("id, name, email")
      .eq("is_active", true)
      .order("name");

    setReferrers(data || []);
  };

  const handleSave = async () => {
    if (!formData.amount || parseFloat(formData.amount) <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (formData.payment_method === "check" && !formData.check_number.trim()) {
      toast.error("Check number is required for check payments");
      return;
    }

    if (formData.recipient_type !== "client" && !formData.recipient_id) {
      toast.error("Please select a recipient");
      return;
    }

    const { error } = await supabase.from("claim_payments").insert([
      {
        claim_id: claimId,
        payment_date: formData.payment_date,
        amount: parseFloat(formData.amount),
        payment_method: formData.payment_method,
        check_number: formData.payment_method === "check" ? formData.check_number : null,
        recipient_type: formData.recipient_type,
        recipient_id: formData.recipient_type === "client" ? null : formData.recipient_id,
        notes: formData.notes || null,
        direction: 'released',
      },
    ]);

    if (error) {
      toast.error("Failed to record payment");
      return;
    }

    toast.success("Payment recorded");
    setDialogOpen(false);
    setFormData({
      payment_date: new Date().toISOString().split("T")[0],
      amount: "",
      payment_method: "check",
      check_number: "",
      recipient_type: "contractor",
      recipient_id: "",
      notes: "",
    });
    fetchPayments();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this payment record?")) return;

    const { error } = await supabase.from("claim_payments").delete().eq("id", id);

    if (error) {
      toast.error("Failed to delete payment");
      return;
    }

    toast.success("Payment deleted");
    fetchPayments();
  };

  const getRecipientName = (payment: Payment) => {
    if (payment.recipient_type === "client") {
      return "Client (Policyholder)";
    }
    if (payment.recipient_type === "contractor") {
      const contractor = contractors.find((c) => c.id === payment.recipient_id);
      return contractor ? contractor.full_name || contractor.email : "Unknown Contractor";
    }
    if (payment.recipient_type === "referrer") {
      const referrer = referrers.find((r) => r.id === payment.recipient_id);
      return referrer ? referrer.name : "Unknown Referrer";
    }
    return "Unknown";
  };

  const getPaymentMethodLabel = (method: string, checkNumber: string | null) => {
    if (method === "check") return `Check #${checkNumber || "N/A"}`;
    if (method === "direct_deposit") return "Direct Deposit";
    if (method === "ach") return "ACH";
    return method;
  };

  const releasedPayments = payments.filter(p => !p.direction || p.direction === 'released');
  const receivedPayments = payments.filter(p => p.direction === 'received');
  const totalReleased = releasedPayments.reduce((sum, payment) => sum + payment.amount, 0);
  const totalReceived = receivedPayments.reduce((sum, payment) => sum + payment.amount, 0);

  const handleQuickBooksPayment = (recipientType: 'contractor' | 'client' | 'referrer', recipientId?: string) => {
    let recipient: { name: string; email?: string; phone?: string; type: 'contractor' | 'client' | 'referrer' } = { 
      name: 'Client (Policyholder)', 
      type: 'client' 
    };
    
    if (recipientType === 'contractor' && recipientId) {
      const contractor = contractors.find(c => c.id === recipientId);
      if (contractor) {
        recipient = { 
          name: contractor.full_name || contractor.email, 
          email: contractor.email,
          type: 'contractor',
        };
      }
    } else if (recipientType === 'referrer' && recipientId) {
      const referrer = referrers.find(r => r.id === recipientId);
      if (referrer) {
        recipient = { 
          name: referrer.name,
          email: referrer.email || undefined,
          type: 'referrer',
        };
      }
    }
    
    setSelectedRecipient(recipient);
    setQbPaymentOpen(true);
  };

  const handleCheckbookPayment = (recipientType: 'contractor' | 'client' | 'referrer', recipientId?: string) => {
    let recipient: { name: string; email?: string; phone?: string; type: 'contractor' | 'client' | 'referrer' } = { 
      name: 'Client (Policyholder)', 
      type: 'client' 
    };
    
    if (recipientType === 'contractor' && recipientId) {
      const contractor = contractors.find(c => c.id === recipientId);
      if (contractor) {
        recipient = { 
          name: contractor.full_name || contractor.email, 
          email: contractor.email,
          type: 'contractor',
        };
      }
    } else if (recipientType === 'referrer' && recipientId) {
      const referrer = referrers.find(r => r.id === recipientId);
      if (referrer) {
        recipient = { 
          name: referrer.name,
          email: referrer.email || undefined,
          type: 'referrer',
        };
      }
    }
    
    setSelectedRecipient(recipient);
    setCheckbookPaymentOpen(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-primary" />
          Payments Released
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex justify-between items-center">
          <div>
            <p className="text-sm text-muted-foreground">Total Released</p>
            <p className="text-2xl font-bold text-primary">${totalReleased.toLocaleString()}</p>
          </div>
          {isAdmin && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button>Record Payment</Button>
              </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Record Payment</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Payment Date</Label>
                  <Input
                    type="date"
                    value={formData.payment_date}
                    onChange={(e) => setFormData({ ...formData, payment_date: e.target.value })}
                  />
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
                  <Label>Payment Method *</Label>
                  <Select
                    value={formData.payment_method}
                    onValueChange={(value) =>
                      setFormData({ ...formData, payment_method: value })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="check">Check</SelectItem>
                      <SelectItem value="direct_deposit">Direct Deposit</SelectItem>
                      <SelectItem value="ach">ACH</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.payment_method === "check" && (
                  <div>
                    <Label>Check Number *</Label>
                    <Input
                      placeholder="Enter check number"
                      value={formData.check_number}
                      onChange={(e) =>
                        setFormData({ ...formData, check_number: e.target.value })
                      }
                    />
                  </div>
                )}
                <div>
                  <Label>Recipient Type *</Label>
                  <Select
                    value={formData.recipient_type}
                    onValueChange={(value) =>
                      setFormData({ ...formData, recipient_type: value, recipient_id: "" })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="client">Client (Policyholder)</SelectItem>
                      <SelectItem value="contractor">Contractor</SelectItem>
                      <SelectItem value="referrer">Referrer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.recipient_type === "contractor" && (
                  <div>
                    <Label>Contractor *</Label>
                    <Select
                      value={formData.recipient_id}
                      onValueChange={(value) =>
                        setFormData({ ...formData, recipient_id: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select contractor" />
                      </SelectTrigger>
                      <SelectContent>
                        {contractors.map((contractor) => (
                          <SelectItem key={contractor.id} value={contractor.id}>
                            {contractor.full_name || contractor.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {formData.recipient_type === "referrer" && (
                  <div>
                    <Label>Referrer *</Label>
                    <Select
                      value={formData.recipient_id}
                      onValueChange={(value) =>
                        setFormData({ ...formData, recipient_id: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select referrer" />
                      </SelectTrigger>
                      <SelectContent>
                        {referrers.map((referrer) => (
                          <SelectItem key={referrer.id} value={referrer.id}>
                            {referrer.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div>
                  <Label>Notes</Label>
                  <Textarea
                    placeholder="Optional notes"
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  />
                </div>
                <Button onClick={handleSave} className="w-full">
                  Record Payment
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          )}
        </div>

        {isAdmin && (
          <div className="space-y-3">
            <p className="text-sm font-medium text-muted-foreground">Quick Payment Options</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <Select onValueChange={(value) => {
                if (value === 'client') {
                  handleQuickBooksPayment('client');
                } else if (value.startsWith('contractor-')) {
                  handleQuickBooksPayment('contractor', value.replace('contractor-', ''));
                } else if (value.startsWith('referrer-')) {
                  handleQuickBooksPayment('referrer', value.replace('referrer-', ''));
                }
              }}>
                <SelectTrigger>
                  <SelectValue placeholder={<span className="flex items-center gap-2"><CreditCard className="h-4 w-4" /> QuickBooks</span>} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client">Client (Policyholder)</SelectItem>
                  {contractors.map(c => (
                    <SelectItem key={c.id} value={`contractor-${c.id}`}>{c.full_name || c.email}</SelectItem>
                  ))}
                  {referrers.map(r => (
                    <SelectItem key={r.id} value={`referrer-${r.id}`}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select onValueChange={(value) => {
                if (value === 'client') {
                  handleCheckbookPayment('client');
                } else if (value.startsWith('contractor-')) {
                  handleCheckbookPayment('contractor', value.replace('contractor-', ''));
                } else if (value.startsWith('referrer-')) {
                  handleCheckbookPayment('referrer', value.replace('referrer-', ''));
                }
              }}>
                <SelectTrigger>
                  <SelectValue placeholder={<span className="flex items-center gap-2"><FileCheck className="h-4 w-4" /> Send Check</span>} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client">Client (Policyholder)</SelectItem>
                  {contractors.map(c => (
                    <SelectItem key={c.id} value={`contractor-${c.id}`}>{c.full_name || c.email}</SelectItem>
                  ))}
                  {referrers.map(r => (
                    <SelectItem key={r.id} value={`referrer-${r.id}`}>{r.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {releasedPayments.length === 0 ? (
          <p className="text-center text-muted-foreground py-4">No payments released</p>
        ) : (
          <div className="space-y-2">
            {releasedPayments.map((payment) => (
              <div
                key={payment.id}
                className="flex items-center justify-between p-3 border rounded-lg"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-primary">
                      ${payment.amount.toLocaleString()}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {getPaymentMethodLabel(payment.payment_method, payment.check_number)}
                    </span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    To: {getRecipientName(payment)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(payment.payment_date), "MMM dd, yyyy")}
                  </div>
                  {payment.notes && (
                    <div className="text-xs text-muted-foreground mt-1">{payment.notes}</div>
                  )}
                </div>
                {isAdmin && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleQuickBooksPayment(payment.recipient_type as 'contractor' | 'client' | 'referrer', payment.recipient_id || undefined)}
                      title="Pay via QuickBooks"
                    >
                      <CreditCard className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(payment.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Payments Received Section */}
        {receivedPayments.length > 0 && (
          <div className="mt-6 pt-6 border-t">
            <div className="flex justify-between items-center mb-4">
              <div>
                <p className="text-lg font-semibold text-green-600">Payments Received</p>
                <p className="text-sm text-muted-foreground">From workspace partners</p>
              </div>
              <p className="text-2xl font-bold text-green-600">${totalReceived.toLocaleString()}</p>
            </div>
            <div className="space-y-2">
              {receivedPayments.map((payment) => (
                <div
                  key={payment.id}
                  className="flex items-center justify-between p-3 border rounded-lg bg-green-50 dark:bg-green-950/20"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-green-600">
                        ${payment.amount.toLocaleString()}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {getPaymentMethodLabel(payment.payment_method, payment.check_number)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {format(new Date(payment.payment_date), "MMM dd, yyyy")}
                    </div>
                    {payment.notes && (
                      <div className="text-xs text-muted-foreground mt-1">{payment.notes}</div>
                    )}
                  </div>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(payment.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {selectedRecipient && (
          <>
            <QuickBooksPaymentDialog
              open={qbPaymentOpen}
              onOpenChange={setQbPaymentOpen}
              recipientName={selectedRecipient.name}
              recipientEmail={selectedRecipient.email}
              recipientPhone={selectedRecipient.phone}
              onSuccess={fetchPayments}
            />
            <CheckbookPaymentDialog
              open={checkbookPaymentOpen}
              onOpenChange={setCheckbookPaymentOpen}
              recipientName={selectedRecipient.name}
              recipientEmail={selectedRecipient.email}
              recipientType={selectedRecipient.type}
              claimId={claimId}
              onSuccess={fetchPayments}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}