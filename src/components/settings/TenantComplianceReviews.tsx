import { CalendarClock, CheckCircle2, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ComplianceReviewType =
  | "Access Review"
  | "User & Permission Review"
  | "Financial Access Review"
  | "Agreement Review"
  | "Security Review"
  | "Other";

export type ComplianceReviewStatus = "Completed" | "Due Soon" | "Overdue" | "Pending";

export interface TenantComplianceReview {
  id: string;
  type: ComplianceReviewType;
  status: ComplianceReviewStatus;
  lastCompletedAt?: string;
  completedBy?: string;
  nextDueAt?: string;
  notes?: string;
}

interface TenantComplianceReviewsProps {
  reviews?: TenantComplianceReview[];
}

const statusClass: Record<ComplianceReviewStatus, string> = {
  Completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "Due Soon": "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  Overdue: "border-destructive/30 bg-destructive/10 text-destructive",
  Pending: "border-border bg-muted text-muted-foreground",
};

const formatDate = (value?: string) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
};

export function TenantComplianceReviews({ reviews = [] }: TenantComplianceReviewsProps) {
  const overdue = reviews.filter((review) => review.status === "Overdue").length;
  const dueSoon = reviews.filter((review) => review.status === "Due Soon").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4" />
          Compliance Reviews
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Reviews Tracked</p>
            <p className="mt-1 text-xl font-semibold">{reviews.length}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Due Soon</p>
            <p className="mt-1 text-xl font-semibold">{dueSoon}</p>
          </div>
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Overdue</p>
            <p className="mt-1 text-xl font-semibold">{overdue}</p>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="text-sm font-medium">Periodic tenant review record</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Track access, user permissions, financial authority, agreements, and security reviews with the last completion, reviewer, next due date, and notes. Review history should be preserved by the backend.
              </p>
            </div>
          </div>
        </div>

        {reviews.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm font-medium">No AWS compliance reviews connected yet.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Ready for scheduled review records without changing current tenant data or permissions.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Review Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last Completed</th>
                  <th className="px-3 py-2">Completed By</th>
                  <th className="px-3 py-2">Next Due</th>
                  <th className="px-3 py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {reviews.map((review) => (
                  <tr key={review.id}>
                    <td className="px-3 py-3 font-medium">{review.type}</td>
                    <td className="px-3 py-3"><Badge variant="outline" className={statusClass[review.status]}>{review.status}</Badge></td>
                    <td className="px-3 py-3 text-xs">{formatDate(review.lastCompletedAt)}</td>
                    <td className="px-3 py-3">{review.completedBy || "—"}</td>
                    <td className="px-3 py-3 text-xs">{formatDate(review.nextDueAt)}</td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">{review.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          <History className="mt-0.5 h-4 w-4 shrink-0" />
          Completion actions, next-review scheduling, reminders, and historical versions will be backed by AWS APIs. This interface does not alter authorization or compliance records by itself.
        </div>
      </CardContent>
    </Card>
  );
}
