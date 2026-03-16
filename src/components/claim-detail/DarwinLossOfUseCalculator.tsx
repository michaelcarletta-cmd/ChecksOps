import { useState, useEffect, useMemo } from "react";
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
import { Home, Plus, DollarSign, Receipt, Upload, CheckCircle, CreditCard, Edit, Trash2, X, Wallet, Save } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { format } from "date-fns";
import { ReceiptUploadDialog } from "./ReceiptUploadDialog";
import { LossOfUseExportButton } from "./LossOfUseExportButton";

export interface LossOfUseExpense {
  id: string;
  expense_category: string;
  expense_date: string;
  vendor_name: string | null;
  description: string;
  amount: number;
  receipt_file_path: string | null;
  receipt_file_name: string | null;
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
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
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

  // Derive available months
  const availableMonths = useMemo(() => {
    const months = new Map<string, string>();
    expenses.forEach((e) => {
      const d = new Date(e.expense_date);
      const key = String(d.getMonth());
      if (!months.has(key)) {
        months.set(key, d.toLocaleString("en-US", { month: "long" }));
      }
    });
    return Array.from(months.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [expenses]);

  // Derive used categories
  const usedCategories = useMemo(() => {
    const cats = new Set<string>();
    expenses.forEach((e) => cats.add(e.expense_category));
    return EXPENSE_CATEGORIES.filter((c) => cats.has(c.value));
  }, [expenses]);

  // Filter expenses
  const filteredExpenses = useMemo(() => {
    let result = expenses;
    if (selectedMonth) {
      result = result.filter((e) => {
        const d = new Date(e.expense_date);
        const key = String(d.getMonth());
        return key === selectedMonth;
      });
    }
    if (selectedCategory) {
      result = result.filter((e) => e.expense_category === selectedCategory);
    }
    return result;
  }, [expenses, selectedMonth, selectedCategory]);

  const handleAddExpense = async () => {
    if (!formData.expense_category || !formData.expense_date || !formData.amount) {
      toast.error("Please fill in required fields");
      return;
    }

    // Duplicate detection: same category + date + amount
    const amt = parseFloat(formData.amount);
    const duplicate = expenses.find(
      (e) =>
        e.expense_category === formData.expense_category &&
        e.expense_date === formData.expense_date &&
        Math.abs(e.amount - amt) < 0.01
    );
    if (duplicate) {
      const vendorHint = duplicate.vendor_name ? ` at ${duplicate.vendor_name}` : "";
      const confirmed = window.confirm(
        `Possible duplicate: A ${formData.expense_category} expense of $${amt.toFixed(2)} on ${formData.expense_date}${vendorHint} already exists.\n\nDo you still want to add this expense?`
      );
      if (!confirmed) return;
      toast.warning("Duplicate expense added — please verify");
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
      .update({ is_submitted_to_insurer: true, submitted_date: format(new Date(), "yyyy-MM-dd") })
      .eq("id", id);
    if (error) toast.error("Failed to update");
    else { toast.success("Marked as submitted"); fetchExpenses(); }
  };

  const markAsReimbursed = async (id: string, amount: number) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .update({ is_reimbursed: true, reimbursed_amount: amount, reimbursed_date: format(new Date(), "yyyy-MM-dd") })
      .eq("id", id);
    if (error) toast.error("Failed to update");
    else { toast.success("Marked as reimbursed"); fetchExpenses(); }
  };

  const markAsPaid = async (id: string) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .update({ is_paid: true, paid_date: format(new Date(), "yyyy-MM-dd") } as any)
      .eq("id", id);
    if (error) toast.error("Failed to update");
    else { toast.success("Marked as paid"); fetchExpenses(); }
  };

  const markAsUnpaid = async (id: string) => {
    const { error } = await supabase
      .from("claim_loss_of_use_expenses")
      .update({ is_paid: false, paid_date: null } as any)
      .eq("id", id);
    if (error) toast.error("Failed to update");
    else { toast.success("Marked as unpaid"); fetchExpenses(); }
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
    if (error) { toast.error("Failed to update expense"); console.error(error); }
    else { toast.success("Expense updated"); fetchExpenses(); }
  };

  const handleDeleteExpense = async (id: string) => {
    const { error } = await supabase.from("claim_loss_of_use_expenses").delete().eq("id", id);
    if (error) { toast.error("Failed to delete expense"); console.error(error); }
    else { toast.success("Expense deleted"); fetchExpenses(); }
  };

  // Calculate totals from filtered
  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
  const totalSubmitted = filteredExpenses.filter(e => e.is_submitted_to_insurer).reduce((sum, e) => sum + e.amount, 0);
  const totalReimbursed = filteredExpenses.filter(e => e.is_reimbursed).reduce((sum, e) => sum + (e.reimbursed_amount || 0), 0);
  const totalPending = totalSubmitted - totalReimbursed;
  const totalPaid = filteredExpenses.filter(e => (e as any).is_paid).reduce((sum, e) => sum + e.amount, 0);
  const totalUnpaid = totalExpenses - totalPaid;

  const paidExpenses = filteredExpenses.filter(e => (e as any).is_paid);
  const unpaidExpenses = filteredExpenses.filter(e => !(e as any).is_paid);

  const categoryTotals = filteredExpenses.reduce((acc, e) => {
    acc[e.expense_category] = (acc[e.expense_category] || 0) + e.amount;
    return acc;
  }, {} as Record<string, number>);

  const activeFilters = (selectedMonth ? 1 : 0) + (selectedCategory ? 1 : 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Home className="h-5 w-5 text-green-600" />
              Loss of Use (Coverage D) Tracker
            </CardTitle>
            <CardDescription>Track Additional Living Expenses for PA/NJ claims</CardDescription>
          </div>
          <div className="flex gap-2">
            <LossOfUseExportButton expenses={filteredExpenses} claimNumber={claim?.claim_number} />
            <ReceiptUploadDialog claimId={claimId} onExpensesAdded={fetchExpenses} existingExpenses={expenses} />
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="h-4 w-4 mr-1" /> Add Expense</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Add ALE Expense</DialogTitle></DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Category *</Label>
                    <Select value={formData.expense_category} onValueChange={(v) => setFormData({ ...formData, expense_category: v })}>
                      <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                      <SelectContent>
                        {EXPENSE_CATEGORIES.map((cat) => (
                          <SelectItem key={cat.value} value={cat.value}>{cat.icon} {cat.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Date *</Label>
                      <Input type="date" value={formData.expense_date} onChange={(e) => setFormData({ ...formData, expense_date: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label>Amount *</Label>
                      <Input type="number" step="0.01" placeholder="0.00" value={formData.amount} onChange={(e) => setFormData({ ...formData, amount: e.target.value })} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Vendor Name</Label>
                    <Input placeholder="e.g., Marriott, Shell Gas" value={formData.vendor_name} onChange={(e) => setFormData({ ...formData, vendor_name: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Description</Label>
                    <Input placeholder="Brief description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Notes</Label>
                    <Textarea placeholder="Additional notes..." value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} />
                  </div>
                  <Button onClick={handleAddExpense} className="w-full">Add Expense</Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Month & Category Filters */}
        {expenses.length > 0 && (
          <div className="mb-4 space-y-2">
            {/* Month filter */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground">Month:</span>
              <Button
                size="sm"
                variant={selectedMonth === null ? "default" : "outline"}
                className="text-xs h-7"
                onClick={() => setSelectedMonth(null)}
              >
                All
              </Button>
              {availableMonths.map(([key, label]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={selectedMonth === key ? "default" : "outline"}
                  className="text-xs h-7"
                  onClick={() => setSelectedMonth(selectedMonth === key ? null : key)}
                >
                  {label}
                </Button>
              ))}
            </div>
            {/* Category filter */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground">Category:</span>
              <Button
                size="sm"
                variant={selectedCategory === null ? "default" : "outline"}
                className="text-xs h-7"
                onClick={() => setSelectedCategory(null)}
              >
                All
              </Button>
              {usedCategories.map((cat) => (
                <Button
                  key={cat.value}
                  size="sm"
                  variant={selectedCategory === cat.value ? "default" : "outline"}
                  className="text-xs h-7"
                  onClick={() => setSelectedCategory(selectedCategory === cat.value ? null : cat.value)}
                >
                  {cat.icon} {cat.label}
                </Button>
              ))}
            </div>
            {activeFilters > 0 && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  Showing {filteredExpenses.length} of {expenses.length} expenses
                </Badge>
                <Button size="sm" variant="ghost" className="text-xs h-6 px-2" onClick={() => { setSelectedMonth(null); setSelectedCategory(null); }}>
                  <X className="h-3 w-3 mr-1" /> Clear filters
                </Button>
              </div>
            )}
          </div>
        )}

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
                  <Badge
                    key={cat}
                    variant="secondary"
                    className="text-sm cursor-pointer"
                    onClick={() => setSelectedCategory(selectedCategory === cat ? null : cat)}
                  >
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
        ) : filteredExpenses.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Receipt className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>{activeFilters > 0 ? "No expenses match the current filters" : "No expenses tracked yet"}</p>
            <p className="text-sm">Add ALE expenses to track reimbursements</p>
          </div>
        ) : (
          <Tabs defaultValue="not_paid" className="w-full">
            <TabsList className="mb-4">
              <TabsTrigger value="not_paid">Not Paid ({unpaidExpenses.length})</TabsTrigger>
              <TabsTrigger value="paid">Paid ({paidExpenses.length})</TabsTrigger>
              <TabsTrigger value="all">All ({filteredExpenses.length})</TabsTrigger>
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
                <ExpenseTable expenses={paidExpenses} categories={EXPENSE_CATEGORIES} markAsSubmitted={markAsSubmitted} markAsReimbursed={markAsReimbursed} markAsPaid={markAsPaid} markAsUnpaid={markAsUnpaid} onEdit={handleEditExpense} onDelete={handleDeleteExpense} />
              )}
            </TabsContent>
            <TabsContent value="all">
              <ExpenseTable expenses={filteredExpenses} categories={EXPENSE_CATEGORIES} markAsSubmitted={markAsSubmitted} markAsReimbursed={markAsReimbursed} markAsPaid={markAsPaid} markAsUnpaid={markAsUnpaid} onEdit={handleEditExpense} onDelete={handleDeleteExpense} />
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
};

/* Extracted table to keep things clean */
function ExpenseTable({ expenses, categories, markAsSubmitted, markAsReimbursed, markAsPaid, markAsUnpaid, onEdit, onDelete }: {
  expenses: LossOfUseExpense[];
  categories: typeof EXPENSE_CATEGORIES;
  markAsSubmitted: (id: string) => void;
  markAsReimbursed: (id: string, amount: number) => void;
  markAsPaid: (id: string) => void;
  markAsUnpaid: (id: string) => void;
  onEdit: (expense: LossOfUseExpense, data: any) => void;
  onDelete: (id: string) => void;
}) {
  const [editingExpense, setEditingExpense] = useState<LossOfUseExpense | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editData, setEditData] = useState({
    expense_category: "",
    expense_date: "",
    vendor_name: "",
    description: "",
    amount: "",
    notes: "",
  });

  const openEdit = (expense: LossOfUseExpense) => {
    setEditData({
      expense_category: expense.expense_category,
      expense_date: expense.expense_date,
      vendor_name: expense.vendor_name || "",
      description: expense.description,
      amount: String(expense.amount),
      notes: expense.notes || "",
    });
    setEditingExpense(expense);
  };

  return (
    <>
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Document</TableHead>
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
                  <TableCell>
                    {expense.receipt_file_name ? (
                      <span className="text-xs text-muted-foreground truncate max-w-[150px] block" title={expense.receipt_file_name}>
                        📄 {expense.receipt_file_name}
                      </span>
                    ) : expense.receipt_file_path ? (
                      <span className="text-xs text-muted-foreground truncate max-w-[150px] block" title={expense.receipt_file_path.split('/').pop() || 'Attached'}>
                        📄 {expense.receipt_file_path.split('/').pop() || 'Attached'}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground opacity-50">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">${expense.amount.toLocaleString()}</TableCell>
                  <TableCell>
                    {isPaid ? (
                      <Badge className="bg-green-100 text-green-800 cursor-pointer" onClick={() => markAsUnpaid(expense.id)}>
                        <CheckCircle className="h-3 w-3 mr-1" /> Paid {paidDate ? format(new Date(paidDate), "M/d") : ""}
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="cursor-pointer opacity-80" onClick={() => markAsPaid(expense.id)}>Not Paid</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {expense.is_reimbursed ? (
                      <Badge className="bg-emerald-100 text-emerald-800"><CheckCircle className="h-3 w-3 mr-1" /> Reimbursed</Badge>
                    ) : expense.is_submitted_to_insurer ? (
                      <Badge className="bg-blue-100 text-blue-800">Submitted</Badge>
                    ) : (
                      <Badge variant="secondary">Not Submitted</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(expense)} title="Edit expense"><Edit className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteId(expense.id)} title="Delete expense" className="text-destructive hover:text-destructive"><Trash2 className="h-4 w-4" /></Button>
                      {!isPaid && <Button variant="ghost" size="sm" onClick={() => markAsPaid(expense.id)} title="Mark as paid"><CreditCard className="h-4 w-4" /></Button>}
                      {!expense.is_submitted_to_insurer && <Button variant="ghost" size="sm" onClick={() => markAsSubmitted(expense.id)} title="Mark as submitted"><Upload className="h-4 w-4" /></Button>}
                      {expense.is_submitted_to_insurer && !expense.is_reimbursed && <Button variant="ghost" size="sm" onClick={() => markAsReimbursed(expense.id, expense.amount)} title="Mark as reimbursed"><DollarSign className="h-4 w-4" /></Button>}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editingExpense} onOpenChange={(open) => !open && setEditingExpense(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit ALE Expense</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Category *</Label>
              <Select value={editData.expense_category} onValueChange={(v) => setEditData({ ...editData, expense_category: v })}>
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {categories.map((cat) => (<SelectItem key={cat.value} value={cat.value}>{cat.icon} {cat.label}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Date *</Label>
                <Input type="date" value={editData.expense_date} onChange={(e) => setEditData({ ...editData, expense_date: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Amount *</Label>
                <Input type="number" step="0.01" value={editData.amount} onChange={(e) => setEditData({ ...editData, amount: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Vendor Name</Label>
              <Input value={editData.vendor_name} onChange={(e) => setEditData({ ...editData, vendor_name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input value={editData.description} onChange={(e) => setEditData({ ...editData, description: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea value={editData.notes} onChange={(e) => setEditData({ ...editData, notes: e.target.value })} />
            </div>
            <Button onClick={() => { if (editingExpense) { onEdit(editingExpense, editData); setEditingExpense(null); } }} className="w-full">Save Changes</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Expense</AlertDialogTitle>
            <AlertDialogDescription>Are you sure you want to delete this ALE expense? This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (deleteId) { onDelete(deleteId); setDeleteId(null); } }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
