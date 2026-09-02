import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Status = "Compliant" | "Action Required" | "Pending" | "Review Due" | "Restricted";

interface StatusCardProps {
  title: string;
  status: Status;
  description?: string;
}

const StatusCard: React.FC<StatusCardProps> = ({ title, status, description }) => {
  const statusVariant: Record<Status, "default" | "destructive" | "secondary" | "outline"> = {
    "Compliant": "default",
    "Action Required": "destructive",
    "Pending": "secondary",
    "Review Due": "secondary",
    "Restricted": "outline",
  };


  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Badge variant={statusVariant[status]}>{status}</Badge>
      </CardHeader>
      <CardContent>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </CardContent>
    </Card>
  );
};

export const SecurityComplianceOverview: React.FC = () => {
  // Placeholder data – will be connected to AWS backend later
  const cards: { title: string; status: Status; description?: string }[] = [
    {
      title: "Security Status",
      status: "Compliant",
      description: "All security controls active",
    },
    {
      title: "Users & Access",
      status: "Action Required",
      description: "2 users pending review",
    },
    {
      title: "MFA Enrollment",
      status: "Pending",
      description: "MFA not yet enforced",
    },
    {
      title: "Agreements & Policies",
      status: "Review Due",
      description: "Annual review overdue",
    },
    {
      title: "Compliance Issues",
      status: "Restricted",
      description: "Open issues require attention",
    },
    {
      title: "Next Review",
      status: "Pending",
      description: "Scheduled for next quarter",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card, index) => (
          <StatusCard
            key={index}
            title={card.title}
            status={card.status}
            description={card.description}
          />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Action Required</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Items requiring attention will appear here once the backend is connected.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};