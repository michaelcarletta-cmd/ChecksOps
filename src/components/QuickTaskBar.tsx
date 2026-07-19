import { useState, useEffect } from "react";
import { Plus, Search, Calendar, User, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useDebounce } from "@/hooks/useDebounce";

interface Claim {
  id: string;
  claim_number: string;
  status: string;
  loss_type: string | null;
  loss_date: string | null;
  clients: {
    name: string;
    email: string | null;
    phone: string | null;
  } | null;
}

interface Assignee {
  id: string;
  name: string;
  type: "user" | "contractor" | "admin" | "policyholder";
}

export function QuickTaskBar() {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [claims, setClaims] = useState<Claim[]>([]);
  const [selectedClaim, setSelectedClaim] = useState<Claim | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  
  // Task form state
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDueDate, setTaskDueDate] = useState<Date | undefined>();
  const [taskAssignee, setTaskAssignee] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);

  const debouncedSearch = useDebounce(searchQuery, 300);

  useEffect(() => {
    if (debouncedSearch.length >= 2) {
      searchClaims(debouncedSearch);
    } else {
      setClaims([]);
    }
  }, [debouncedSearch]);

  useEffect(() => {
    if (selectedClaim) {
      fetchAssigneesForClaim(selectedClaim.id, selectedClaim.clients?.name || null);
    } else {
      setAssignees([]);
    }
  }, [selectedClaim]);

  const fetchAssigneesForClaim = async (claimId: string, clientName: string | null) => {
    const assigneesList: Assignee[] = [];

    // Add policyholder if available
    if (clientName) {
      assigneesList.push({
        id: "policyholder",
        name: `${clientName} (Policyholder)`,
        type: "policyholder"
      });
    }

    // Fetch admins
    const { data: adminRoles } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin");

    if (adminRoles && adminRoles.length > 0) {
      const adminIds = adminRoles.map(r => r.user_id);
      const { data: adminProfiles } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", adminIds);

      if (adminProfiles) {
        adminProfiles.forEach(admin => {
          assigneesList.push({
            id: admin.id,
            name: `${admin.full_name || admin.email} (Admin)`,
            type: "admin"
          });
        });
      }
    }

    // Fetch contractors assigned to this claim
    const { data: claimContractors } = await supabase
      .from("claim_contractors")
      .select("contractor_id")
      .eq("claim_id", claimId);

    if (claimContractors && claimContractors.length > 0) {
      const contractorIds = claimContractors.map(c => c.contractor_id);
      const { data: contractorProfiles } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", contractorIds);

      if (contractorProfiles) {
        contractorProfiles.forEach(contractor => {
          assigneesList.push({
            id: contractor.id,
            name: `${contractor.full_name || contractor.email} (Contractor)`,
            type: "contractor"
          });
        });
      }
    }

    // Fetch staff users assigned to this claim via profiles.assigned_claims or similar
    // For now, also include all staff members as potential assignees
    const { data: staffRoles } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "staff");

    if (staffRoles && staffRoles.length > 0) {
      const staffIds = staffRoles.map(r => r.user_id);
      const { data: staffProfiles } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", staffIds);

      if (staffProfiles) {
        staffProfiles.forEach(user => {
          // Avoid duplicates (user might already be added as admin)
          if (!assigneesList.find(a => a.id === user.id)) {
            assigneesList.push({
              id: user.id,
              name: `${user.full_name || user.email} (Staff)`,
              type: "user"
            });
          }
        });
      }
    }

    setAssignees(assigneesList);
  };

  const searchClaims = async (query: string) => {
    setIsSearching(true);
    
    // First, search by claim number
    const { data: claimsByNumber } = await supabase
      .from("claims")
      .select(`
        id,
        claim_number,
        status,
        loss_type,
        loss_date,
        client_id,
        clients (
          name,
          email,
          phone
        )
      `)
      .ilike("claim_number", `%${query}%`)
      .limit(10);

    // Second, find clients matching the search and get their claims
    const { data: matchingClients } = await supabase
      .from("clients")
      .select("id")
      .ilike("name", `%${query}%`)
      .limit(10);

    let claimsByClient: Claim[] = [];
    if (matchingClients && matchingClients.length > 0) {
      const clientIds = matchingClients.map(c => c.id);
      const { data } = await supabase
        .from("claims")
        .select(`
          id,
          claim_number,
          status,
          loss_type,
          loss_date,
          client_id,
          clients (
            name,
            email,
            phone
          )
        `)
        .in("client_id", clientIds)
        .limit(10);
      
      if (data) {
        claimsByClient = data as Claim[];
      }
    }

    // Merge and dedupe results
    const allClaims = [...(claimsByNumber || []), ...claimsByClient];
    const uniqueClaims = allClaims.reduce((acc, claim) => {
      if (!acc.find(c => c.id === claim.id)) {
        acc.push(claim);
      }
      return acc;
    }, [] as Claim[]);

    setClaims(uniqueClaims.slice(0, 10));
    setIsSearching(false);
  };

  const handleSelectClaim = (claim: Claim) => {
    setSelectedClaim(claim);
    setSearchQuery("");
    setClaims([]);
  };

  const handleClearSelection = () => {
    setSelectedClaim(null);
    setTaskTitle("");
    setTaskDueDate(undefined);
    setTaskAssignee("");
  };

  const handleSubmitTask = async () => {
    if (!selectedClaim || !taskTitle.trim()) {
      toast.error("Please select a claim and enter a task title");
      return;
    }

    setIsSubmitting(true);
    
    const { error } = await supabase
      .from("tasks")
      .insert({
        claim_id: selectedClaim.id,
        title: taskTitle.trim(),
        due_date: taskDueDate ? format(taskDueDate, "yyyy-MM-dd") : null,
        assigned_to: taskAssignee || null,
        status: "pending",
        priority: "medium",
      });

    if (error) {
      toast.error("Failed to create task");
      console.error(error);
    } else {
      toast.success("Task created successfully");
      handleClearSelection();
      setOpen(false);
    }
    
    setIsSubmitting(false);
  };

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case "open":
        return "bg-blue-500/10 text-blue-600 border border-blue-500/20";
      case "in progress":
        return "bg-amber-500/10 text-amber-600 border border-amber-500/20";
      case "closed":
        return "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20";
      default:
        return "bg-muted text-muted-foreground border border-border/50";
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" title="Quick Task">
          <Plus className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(400px,calc(100vw-2rem))] p-0" align="end">
        <div className="p-4 border-b">
          <h3 className="font-semibold flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Quick Task
          </h3>
          <p className="text-sm text-muted-foreground">
            Search for a client to add a task
          </p>
        </div>

        <div className="p-4 space-y-4">
          {/* Search Section */}
          {!selectedClaim && (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by client name or claim number..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              {isSearching && (
                <p className="text-sm text-muted-foreground text-center py-2">Searching...</p>
              )}

              {claims.length > 0 && (
                <ScrollArea className="h-[200px] border rounded-md">
                  <div className="divide-y">
                    {claims.map((claim) => (
                      <div
                        key={claim.id}
                        className="p-3 hover:bg-muted/50 cursor-pointer transition-colors"
                        onClick={() => handleSelectClaim(claim)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="font-medium text-sm">{claim.clients?.name || "Unknown Client"}</p>
                            <p className="text-xs text-muted-foreground">{claim.claim_number}</p>
                          </div>
                          <Badge className={cn("text-xs", getStatusColor(claim.status))}>
                            {claim.status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              {searchQuery.length >= 2 && claims.length === 0 && !isSearching && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No claims found
                </p>
              )}
            </div>
          )}

          {/* Selected Claim Info */}
          {selectedClaim && (
            <div className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    <span className="font-medium">{selectedClaim.clients?.name}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearSelection}
                    className="h-6 px-2 text-xs"
                  >
                    Change
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Claim:</span>{" "}
                    <span className="font-medium">{selectedClaim.claim_number}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Status:</span>{" "}
                    <Badge className={cn("text-xs", getStatusColor(selectedClaim.status))}>
                      {selectedClaim.status}
                    </Badge>
                  </div>
                  {selectedClaim.loss_type && (
                    <div>
                      <span className="text-muted-foreground">Loss Type:</span>{" "}
                      <span>{selectedClaim.loss_type}</span>
                    </div>
                  )}
                  {selectedClaim.loss_date && (
                    <div>
                      <span className="text-muted-foreground">DOL:</span>{" "}
                      <span>{format(new Date(selectedClaim.loss_date), "MMM d, yyyy")}</span>
                    </div>
                  )}
                </div>
                {selectedClaim.clients?.phone && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Phone:</span>{" "}
                    <span>{selectedClaim.clients.phone}</span>
                  </div>
                )}
              </div>

              {/* Task Form */}
              <div className="space-y-3">
                <Input
                  placeholder="Task title..."
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                />

                <div className="grid grid-cols-2 gap-2">
                  <Popover open={showCalendar} onOpenChange={setShowCalendar}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "justify-start text-left font-normal",
                          !taskDueDate && "text-muted-foreground"
                        )}
                      >
                        <Calendar className="mr-2 h-4 w-4" />
                        {taskDueDate ? format(taskDueDate, "MMM d") : "Due date"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarComponent
                        mode="single"
                        selected={taskDueDate}
                        onSelect={(date) => {
                          setTaskDueDate(date);
                          setShowCalendar(false);
                        }}
                        initialFocus
                        className="p-3 pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>

                  <Select value={taskAssignee} onValueChange={setTaskAssignee}>
                    <SelectTrigger>
                      <User className="mr-2 h-4 w-4" />
                      <SelectValue placeholder="Assign to" />
                    </SelectTrigger>
                    <SelectContent>
                      {assignees.map((assignee) => (
                        <SelectItem key={assignee.id} value={assignee.id}>
                          {assignee.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  className="w-full"
                  onClick={handleSubmitTask}
                  disabled={!taskTitle.trim() || isSubmitting}
                >
                  {isSubmitting ? "Creating..." : "Add Task"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
