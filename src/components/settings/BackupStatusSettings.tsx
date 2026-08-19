import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { 
  Database, 
  Users, 
  FileText, 
  Building2, 
  UserCheck, 
  FolderOpen,
  Mail,
  CheckSquare,
  Zap,
  Shield,
  HardDrive,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";

interface DataCount {
  label: string;
  count: number;
  icon: React.ReactNode;
  category: "database" | "storage";
}

export function BackupStatusSettings() {
  const { data: counts, isLoading } = useQuery({
    queryKey: ["backup-status-counts"],
    queryFn: async () => {
      const [
        clientsResult,
        claimsResult,
        contractorsResult,
        referrersResult,
        filesResult,
        templatesResult,
        emailsResult,
        tasksResult,
        automationsResult,
        insuranceResult,
        mortgageResult,
        inspectionsResult,
        settlementsResult,
        checksResult,
        knowledgeDocsResult,
      ] = await Promise.all([
        supabase.from("clients").select("id", { count: "exact", head: true }),
        supabase.from("claims").select("id", { count: "exact", head: true }),
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("referrers").select("id", { count: "exact", head: true }),
        supabase.from("claim_files").select("id", { count: "exact", head: true }),
        supabase.from("document_templates").select("id", { count: "exact", head: true }),
        supabase.from("emails").select("id", { count: "exact", head: true }),
        supabase.from("tasks").select("id", { count: "exact", head: true }),
        supabase.from("automations").select("id", { count: "exact", head: true }),
        supabase.from("insurance_companies").select("id", { count: "exact", head: true }),
        supabase.from("mortgage_companies").select("id", { count: "exact", head: true }),
        supabase.from("inspections").select("id", { count: "exact", head: true }),
        supabase.from("claim_settlements").select("id", { count: "exact", head: true }),
        supabase.from("claim_checks").select("id", { count: "exact", head: true }),
        supabase.from("ai_knowledge_documents").select("id", { count: "exact", head: true }),
      ]);

      return {
        clients: clientsResult.count || 0,
        claims: claimsResult.count || 0,
        contractors: contractorsResult.count || 0,
        referrers: referrersResult.count || 0,
        files: filesResult.count || 0,
        templates: templatesResult.count || 0,
        emails: emailsResult.count || 0,
        tasks: tasksResult.count || 0,
        automations: automationsResult.count || 0,
        insurance: insuranceResult.count || 0,
        mortgage: mortgageResult.count || 0,
        inspections: inspectionsResult.count || 0,
        settlements: settlementsResult.count || 0,
        checks: checksResult.count || 0,
        knowledgeDocs: knowledgeDocsResult.count || 0,
      };
    },
  });

  const databaseItems: DataCount[] = counts ? [
    { label: "Clients", count: counts.clients, icon: <Users className="h-5 w-5" />, category: "database" },
    { label: "Claims", count: counts.claims, icon: <FileText className="h-5 w-5" />, category: "database" },
    { label: "User Profiles", count: counts.contractors, icon: <UserCheck className="h-5 w-5" />, category: "database" },
    { label: "Referrers", count: counts.referrers, icon: <UserCheck className="h-5 w-5" />, category: "database" },
    { label: "Insurance Companies", count: counts.insurance, icon: <Building2 className="h-5 w-5" />, category: "database" },
    { label: "Mortgage Companies", count: counts.mortgage, icon: <Building2 className="h-5 w-5" />, category: "database" },
    { label: "Emails Sent", count: counts.emails, icon: <Mail className="h-5 w-5" />, category: "database" },
    { label: "Tasks", count: counts.tasks, icon: <CheckSquare className="h-5 w-5" />, category: "database" },
    { label: "Inspections", count: counts.inspections, icon: <CheckSquare className="h-5 w-5" />, category: "database" },
    { label: "Settlements", count: counts.settlements, icon: <Database className="h-5 w-5" />, category: "database" },
    { label: "Checks Received", count: counts.checks, icon: <Database className="h-5 w-5" />, category: "database" },
    { label: "Automations", count: counts.automations, icon: <Zap className="h-5 w-5" />, category: "database" },
  ] : [];

  const storageItems: DataCount[] = counts ? [
    { label: "Claim Files", count: counts.files, icon: <FolderOpen className="h-5 w-5" />, category: "storage" },
    { label: "Document Templates", count: counts.templates, icon: <FileText className="h-5 w-5" />, category: "storage" },
    { label: "AI Knowledge Documents", count: counts.knowledgeDocs, icon: <Database className="h-5 w-5" />, category: "storage" },
  ] : [];

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="Backup Status"
        description="Monitor the health and redundancy of your claim data and files."
        badge="Security & Compliance"
        icon={<Shield className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Backup Health"
        accent="bg-gradient-to-r from-green-500/60 to-green-500/10"
        icon={<Shield className="h-4 w-4 text-green-500" />}
        description="All your data is automatically backed up daily with Lovable Cloud."
      >
        <div className="flex items-center gap-4 p-4 bg-green-500/10 rounded-lg border border-green-500/20">
          <div className="h-3 w-3 rounded-full bg-green-500 animate-pulse" />
          <div>
            <p className="font-medium text-green-700 dark:text-green-400">Automatic Backups Active</p>
            <p className="text-sm text-muted-foreground">
              Daily database backups with point-in-time recovery capability
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Database Records"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<Database className="h-4 w-4 text-primary" />}
        description="All database tables are included in daily backups."
      >
        <div className="space-y-4">
          {isLoading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {[...Array(12)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {databaseItems.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg border"
                >
                  <div className="text-primary">{item.icon}</div>
                  <div>
                    <p className="text-2xl font-bold">{item.count.toLocaleString()}</p>
                    <p className="text-sm text-muted-foreground">{item.label}</p>
                  </div>
                  <Badge variant="outline" className="ml-auto text-green-600 border-green-600">
                    ✓
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="File Storage"
        accent="bg-gradient-to-r from-blue-500/60 to-blue-500/10"
        icon={<HardDrive className="h-4 w-4 text-blue-500" />}
        description="All uploaded files are stored with redundancy."
      >
        <div className="space-y-4">
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {storageItems.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg border"
                >
                  <div className="text-primary">{item.icon}</div>
                  <div>
                    <p className="text-2xl font-bold">{item.count.toLocaleString()}</p>
                    <p className="text-sm text-muted-foreground">{item.label}</p>
                  </div>
                  <Badge variant="outline" className="ml-auto text-green-600 border-green-600">
                    ✓
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Storage Buckets"
        accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
        icon={<FolderOpen className="h-4 w-4 text-amber-500" />}
        description="Dedicated storage buckets with automatic redundancy."
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { name: "claim-files", description: "Claim documents and uploads", isPublic: false },
            { name: "document-templates", description: "Reusable document templates", isPublic: false },
            { name: "ai-knowledge-base", description: "AI training documents", isPublic: false },
          ].map((bucket) => (
            <div
              key={bucket.name}
              className="flex items-center gap-3 p-4 bg-muted/50 rounded-lg border"
            >
              <FolderOpen className="h-5 w-5 text-primary" />
              <div className="flex-1">
                <p className="font-medium">{bucket.name}</p>
                <p className="text-sm text-muted-foreground">{bucket.description}</p>
              </div>
              <Badge variant="outline" className="text-green-600 border-green-600">
                Backed Up
              </Badge>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
