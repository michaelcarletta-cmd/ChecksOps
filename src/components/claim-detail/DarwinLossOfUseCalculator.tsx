import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { Home, Plus, DollarSign, Receipt, Upload, CheckCircle, CreditCard, Edit, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { format } from "date-fns";
import { ReceiptUploadDialog } from "./ReceiptUploadDialog";
interface LossOfUseExpense {
  id: string;
  expense_category: string;
  expense_date: string;
  vendor_name: string | null;
  description: string;
  amount: number;
  receipt_file_path: string | null;
  is_submitted_to_insurer: boolean;
  submitted_date: string | null;
  is_reimbursed: boolean;
  reimbursed_amount: number | null;
  notes: string | null;
  is_paid: boolean;
  paid_date: string | null;
}

interface DarwinLossOfUseCalculatorProps {
  claimId: string;
  claim: any;
}

const EXPENSE_CATEGORIES = [
  { value: "lodging", label: "Lodging (Hotel/Rental)", icon: "🏨" },
  { value: "meals", label: "Meals & Food", icon: "🍽️" },
  { value: "storage", label: "Storage", icon: "📦" },
  { value: "transportation", label: "Transportation/Gas", icon: "🚗" },
  { value: "laundry", label: "Laundry", icon: "🧺" },
  { value: "pet_boarding", label: "Pet Boarding", icon: "🐕" },
  { value: "other", label: "Other ALE", icon: "📋" },
];

export const DarwinLossOfUseCalculator = ({ claimId, claim }: DarwinLossOfUseCalculatorProps) => {
  const [expenses, setExpenses] = useState<LossOfUseExpense[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    expense_category: "",
    expense_date: format(new Date(), "yyyy-MM-dd"),
    vendor_name: "",
    description: "",
    amount: "",
    notes: "",
  });

  const fetchExpenses = async () => {
    const { data, error } = await supabase
      .from("claim_loss_of_use_expenses")
      .select("*")
      .eq("claim_id", claimId)
      .order("expense_date", { ascending: false });

    if (error) {
      console.error("Error fetching expenses:", error);
    } else {
      setExpenses(data || []);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchExpenses();
  }, [claimId]);

  const handleAddExpense = async () => {
    if (!formData.expense_category || !formData.expense_date || !formData.amount) {
      toast.error("Please fill in required fields");
      return;
    }

    const { data: userData } = await supabase.auth.getUser();

    const { error } = await supabase.from("claim_loss_of_use_expenses").insert({
      claim_id: claimId,
      expense_category: formData.expense_category,
      expense_date: formData.expense_date,
      vendor_name: formData.vendor_name || null,
      description: formData.description || EXPENSE_CATEGORIES.find(c => c.value === formData.expense_category)?.label || formData.expense_category,
      amount: parseFloat(formData.amount),
      notes: formData.notes || null,
      created_by: userData.user?.id,
    });

    if (error) {
      toast.error("Failed to add expense");
      console.error(error);
    } else {
      toast.success("Expense added");
      setDialogOpen(false);
      setFormData({
        expense_category: "",
        expense_date: format(new Date(), "yyyy-MM-dd"),
        vendor_name: "",
        description: "",
        amount: "",
        notes: "",
      });
      fetchExpenses();
    }
  };

  const markAsSubmitted = async (id: string) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .update({
        is_submitted_to_insurer: true,
        submitted_date: format(new Date(), "yyyy-MM-dd"),
      })
      .eq("id", id);

    if (error) {
      toast.error("Failed to update");
    } else {
      toast.success("Marked as submitted");
      fetchExpenses();
    }
  };

  const markAsReimbursed = async (id: string, amount: number) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .update({
        is_reimbursed: true,
        reimbursed_amount: amount,
        reimbursed_date: format(new Date(), "yyyy-MM-dd"),
      })
      .eq("id", id);

    if (error) {
      toast.error("Failed to update");
    } else {
      toast.success("Marked as reimbursed");
      fetchExpenses();
    }
  };

  const markAsPaid = async (id: string) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .update({
        is_paid: true,
        paid_date: format(new Date(), "yyyy-MM-dd"),
      } as any)
      .eq("id", id);

    if (error) {
      toast.error("Failed to update");
    } else {
      toast.success("Marked as paid");
      fetchExpenses();
    }
  };

  const markAsUnpaid = async (id: string) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .update({
        is_paid: false,
        paid_date: null,
      } as any)
      .eq("id", id);

    if (error) {
      toast.error("Failed to update");
    } else {
      toast.success("Marked as unpaid");
      fetchExpenses();
    }
  };

  const handleEditExpense = async (expense: LossOfUseExpense, updatedData: typeof formData) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .update({
        expense_category: updatedData.expense_category,
        expense_date: updatedData.expense_date,
        vendor_name: updatedData.vendor_name || null,
        description: updatedData.description || EXPENSE_CATEGORIES.find(c => c.value === updatedData.expense_category)?.label || updatedData.expense_category,
        amount: parseFloat(updatedData.amount),
        notes: updatedData.notes || null,
      })
      .eq("id", expense.id);

    if (error) {
      toast.error("Failed to update expense");
      console.error(error);
    } else {
      toast.success("Expense updated");
      fetchExpenses();
    }
  };

  const handleDeleteExpense = async (id: string) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .delete()
      .eq("id", id);

    if (error) {
      toast.error("Failed to delete expense");
      console.error(error);
    } else {
      toast.success("Expense deleted");
      fetchExpenses();
    }
  };

  // Calculate totals
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const totalSubmitted = expenses.filter(e => e.is_submitted_to_insurer).reduce((sum, e) => sum + e.amount, 0);
  const totalReimbursed = expenses.filter(e => e.is_reimbursed).reduce((sum, e) => sum + (e.reimbursed_amount || 0), 0);
  const totalPending = totalSubmitted - totalReimbursed;
  const totalUnsubmitted = totalExpenses - totalSubmitted;
  const totalPaid = expenses.filter(e => (e as any).is_paid).reduce((sum, e) => sum + e.amount, 0);
  const totalUnpaid = totalExpenses - totalPaid;

  const paidExpenses = expenses.filter(e => (e as any).is_paid);
  const unpaidExpenses = expenses.filter(e => !(e as any).is_paid);

  // Group by category for summary
  const categoryTotals = expenses.reduce((acc, e) => {
    acc[e.expense_category] = (acc[e.expense_category] || 0) + e.amount;
    return acc;
  }, {} as Record<string, number>);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Home className="h-5 w-5 text-green-600" />
              Loss of Use (Coverage D) Tracker
            </CardTitle>
            <CardDescription>
              Track Additional Living Expenses for PA/NJ claims
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <ReceiptUploadDialog claimId={claimId} onExpensesAdded={fetchExpenses} />
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="h-4 w-4 mr-1" /> Add Expense
                </Button>
              </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add ALE Expense</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Category *</Label>
                  <Select
                    value={formData.expense_category}
                    onValueChange={(v) => setFormData({ ...formData, expense_category: v })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPENSE_CATEGORIES.map((cat) => (
                        <SelectItem key={cat.value} value={cat.value}>
                          {cat.icon} {cat.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Date *</Label>
                    <Input
                      type="date"
                      value={formData.expense_date}
                      onChange={(e) => setFormData({ ...formData, expense_date: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Amount *</Label>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      value={formData.amount}
                      onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Vendor Name</Label>
                  <Input
                    placeholder="e.g., Marriott, Shell Gas"
                    value={formData.vendor_name}
                    onChange={(e) => setFormData({ ...formData, vendor_name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Input
                    placeholder="Brief description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Notes</Label>
                  <Textarea
                    placeholder="Additional notes..."
                    value={formData.notes}
                    onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  />
                </div>
                <Button onClick={handleAddExpense} className="w-full">
                  Add Expense
                </Button>
              </div>
            </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <div className="bg-muted/50 rounded-lg p-4 text-center">
            <p className="text-sm text-muted-foreground">Total Expenses</p>
            <p className="text-2xl font-bold">${totalExpenses.toLocaleString()}</p>
          </div>
          <div className="bg-green-50 dark:bg-green-950/30 rounded-lg p-4 text-center">
            <p className="text-sm text-green-700 dark:text-green-400">Paid</p>
            <p className="text-2xl font-bold text-green-700 dark:text-green-400">${totalPaid.toLocaleString()}</p>
          </div>
          <div className="bg-red-50 dark:bg-red-950/30 rounded-lg p-4 text-center">
            <p className="text-sm text-red-700 dark:text-red-400">Not Paid</p>
            <p className="text-2xl font-bold text-red-700 dark:text-red-400">${totalUnpaid.toLocaleString()}</p>
          </div>
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-4 text-center">
            <p className="text-sm text-blue-700 dark:text-blue-400">Pending Reimb.</p>
            <p className="text-2xl font-bold text-blue-700 dark:text-blue-400">${totalPending.toLocaleString()}</p>
          </div>
          <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-lg p-4 text-center">
            <p className="text-sm text-emerald-700 dark:text-emerald-400">Reimbursed</p>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">${totalReimbursed.toLocaleString()}</p>
          </div>
        </div>

        {/* Category Breakdown */}
        {Object.keys(categoryTotals).length > 0 && (
          <div className="mb-6">
            <h4 className="font-medium mb-2">By Category</h4>
            <div className="flex flex-wrap gap-2">
              {Object.entries(categoryTotals).map(([cat, total]) => {
                const catInfo = EXPENSE_CATEGORIES.find(c => c.value === cat);
                return (
                  <Badge key={cat} variant="secondary" className="text-sm">
                    {catInfo?.icon} {catInfo?.label}: ${total.toLocaleString()}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
          </div>
        ) : expenses.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Receipt className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>No expenses tracked yet</p>
            <p className="text-sm">Add ALE expenses to track reimbursements</p>
          </div>
        ) : (
          <Tabs defaultValue="not_paid" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="not_paid">
                Not Paid ({unpaidExpenses.length})
              </TabsTrigger>
              <TabsTrigger value="paid">
                Paid ({paidExpenses.length})
              </TabsTrigger>
              <TabsTrigger value="all">
                All ({expenses.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="not_paid">
              {unpaidExpenses.length === 0 ? (
                <p className="text-center py-4 text-muted-foreground text-sm">All expenses are paid!</p>
              ) : (
                <ExpenseTable expenses={unpaidExpenses} categories={EXPENSE_CATEGORIES} markAsSubmitted={markAsSubmitted} markAsReimbursed={markAsReimbursed} markAsPaid={markAsPaid} markAsUnpaid={markAsUnpaid} onEdit={handleEditExpense} onDelete={handleDeleteExpense} />
              )}
            </TabsContent>
            <TabsContent value="paid">
              {paidExpenses.length === 0 ? (
                <p className="text-center py-4 text-muted-foreground text-sm">No paid expenses yet</p>
              ) : (
                <ExpenseTable expenses={paidExpenses} categories={EXPENSE_CATEGORIES} markAsSubmitted={markAsSubmitted} markAsReimbursed={markAsReimbursed} markAsPaid={markAsPaid} markAsUnpaid={markAsUnpaid} />
              )}
            </TabsContent>
            <TabsContent value="all">
              <ExpenseTable expenses={expenses} categories={EXPENSE_CATEGORIES} markAsSubmitted={markAsSubmitted} markAsReimbursed={markAsReimbursed} markAsPaid={markAsPaid} markAsUnpaid={markAsUnpaid} />
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
};

/* Extracted table to keep things clean */
function ExpenseTable({ expenses, categories, markAsSubmitted, markAsReimbursed, markAsPaid, markAsUnpaid }: {
  expenses: LossOfUseExpense[];
  categories: typeof EXPENSE_CATEGORIES;
  markAsSubmitted: (id: string) => void;
  markAsReimbursed: (id: string, amount: number) => void;
  markAsPaid: (id: string) => void;
  markAsUnpaid: (id: string) => void;
}) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Paid</TableHead>
            <TableHead>Insurer Status</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {expenses.map((expense) => {
            const catInfo = categories.find(c => c.value === expense.expense_category);
            const isPaid = (expense as any).is_paid;
            const paidDate = (expense as any).paid_date;
            return (
              <TableRow key={expense.id}>
                <TableCell>{format(new Date(expense.expense_date), "MMM d")}</TableCell>
                <TableCell>
                  <span>{catInfo?.icon}</span> {catInfo?.label || expense.expense_category}
                </TableCell>
                <TableCell>
                  {expense.vendor_name && <span className="font-medium">{expense.vendor_name}: </span>}
                  {expense.description}
                </TableCell>
                <TableCell className="text-right font-medium">
                  ${expense.amount.toLocaleString()}
                </TableCell>
                <TableCell>
                  {isPaid ? (
                    <Badge className="bg-green-100 text-green-800 cursor-pointer" onClick={() => markAsUnpaid(expense.id)}>
                      <CheckCircle className="h-3 w-3 mr-1" /> Paid {paidDate ? format(new Date(paidDate), "M/d") : ""}
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="cursor-pointer opacity-80" onClick={() => markAsPaid(expense.id)}>
                      Not Paid
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {expense.is_reimbursed ? (
                    <Badge className="bg-emerald-100 text-emerald-800">
                      <CheckCircle className="h-3 w-3 mr-1" /> Reimbursed
                    </Badge>
                  ) : expense.is_submitted_to_insurer ? (
                    <Badge className="bg-blue-100 text-blue-800">Submitted</Badge>
                  ) : (
                    <Badge variant="secondary">Not Submitted</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {!isPaid && (
                      <Button variant="ghost" size="sm" onClick={() => markAsPaid(expense.id)} title="Mark as paid">
                        <CreditCard className="h-4 w-4" />
                      </Button>
                    )}
                    {!expense.is_submitted_to_insurer && (
                      <Button variant="ghost" size="sm" onClick={() => markAsSubmitted(expense.id)} title="Mark as submitted">
                        <Upload className="h-4 w-4" />
                      </Button>
                    )}
                    {expense.is_submitted_to_insurer && !expense.is_reimbursed && (
                      <Button variant="ghost" size="sm" onClick={() => markAsReimbursed(expense.id, expense.amount)} title="Mark as reimbursed">
                        <DollarSign className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}