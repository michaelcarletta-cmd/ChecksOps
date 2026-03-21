import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Eye } from "lucide-react";
import { Link } from "react-router-dom";

type ClaimStatus = "new" | "in_progress" | "under_review" | "approved" | "rejected";

interface Claim {
  id: string;
  claimNumber: string;
  clientName: string;
  propertyAddress: string;
  claimAmount: string;
  status: ClaimStatus;
  dateSubmitted: string;
}

const mockClaims: Claim[] = [
  {
    id: "1",
    claimNumber: "CLM-2024-001",
    clientName: "John Smith",
    propertyAddress: "123 Main St, Springfield",
    claimAmount: "$45,000",
    status: "approved",
    dateSubmitted: "2024-01-15",
  },
  {
    id: "2",
    claimNumber: "CLM-2024-002",
    clientName: "Sarah Johnson",
    propertyAddress: "456 Oak Ave, Riverside",
    claimAmount: "$32,500",
    status: "under_review",
    dateSubmitted: "2024-01-18",
  },
  {
    id: "3",
    claimNumber: "CLM-2024-003",
    clientName: "Michael Brown",
    propertyAddress: "789 Pine Rd, Lakewood",
    claimAmount: "$67,800",
    status: "in_progress",
    dateSubmitted: "2024-01-20",
  },
  {
    id: "4",
    claimNumber: "CLM-2024-004",
    clientName: "Emily Davis",
    propertyAddress: "321 Elm St, Hillside",
    claimAmount: "$28,900",
    status: "new",
    dateSubmitted: "2024-01-22",
  },
  {
    id: "5",
    claimNumber: "CLM-2024-005",
    clientName: "David Wilson",
    propertyAddress: "654 Maple Dr, Fairview",
    claimAmount: "$51,200",
    status: "rejected",
    dateSubmitted: "2024-01-12",
  },
];

const getStatusVariant = (status: ClaimStatus) => {
  const variants: Record<ClaimStatus, "default" | "secondary" | "destructive" | "outline"> = {
    new: "outline",
    in_progress: "default",
    under_review: "secondary",
    approved: "default",
    rejected: "destructive",
  };
  return variants[status];
};

const getStatusLabel = (status: ClaimStatus) => {
  const labels: Record<ClaimStatus, string> = {
    new: "New",
    in_progress: "In Progress",
    under_review: "Under Review",
    approved: "Approved",
    rejected: "Rejected",
  };
  return labels[status];
};

const getStatusClassName = (status: ClaimStatus) => {
  const classes: Record<ClaimStatus, string> = {
    new: "bg-accent/20 text-accent-foreground border border-accent/30",
    in_progress: "bg-primary/10 text-primary border border-primary/20",
    under_review: "bg-amber-500/10 text-amber-600 border border-amber-500/20",
    approved: "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20",
    rejected: "bg-destructive/10 text-destructive border border-destructive/20",
  };
  return classes[status];
};

export const ClaimsTable = () => {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Claim #</TableHead>
            <TableHead>Client Name</TableHead>
            <TableHead>Property Address</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Date Submitted</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {mockClaims.map((claim) => (
            <TableRow key={claim.id} className="hover:bg-muted/50 transition-colors">
              <TableCell className="font-medium">{claim.claimNumber}</TableCell>
              <TableCell>{claim.clientName}</TableCell>
              <TableCell className="max-w-[200px] truncate">{claim.propertyAddress}</TableCell>
              <TableCell className="font-semibold">{claim.claimAmount}</TableCell>
              <TableCell>
                <Badge className={getStatusClassName(claim.status)}>
                  {getStatusLabel(claim.status)}
                </Badge>
              </TableCell>
              <TableCell>{new Date(claim.dateSubmitted).toLocaleDateString()}</TableCell>
              <TableCell className="text-right">
                <Link to={`/claims/${claim.id}`}>
                  <Button variant="ghost" size="sm">
                    <Eye className="h-4 w-4 mr-1" />
                    View
                  </Button>
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
