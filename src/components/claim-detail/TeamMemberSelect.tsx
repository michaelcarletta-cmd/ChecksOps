import { useState, useEffect } from "react";
import { Check, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { supabase } from "@/integrations/aws/client";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

interface TeamMember {
  id: string;
  full_name: string | null;
  email: string;
}

interface TeamMemberSelectProps {
  selectedMembers: string[];
  onSelectionChange: (memberIds: string[]) => void;
  disabled?: boolean;
}

export function TeamMemberSelect({
  selectedMembers,
  onSelectionChange,
  disabled = false,
}: TeamMemberSelectProps) {
  const [open, setOpen] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    const fetchTeamMembers = async () => {
      // Get all users with staff or admin roles (internal team)
      const { data: roleData, error: roleError } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("role", ["admin", "staff"]);

      if (roleError) {
        console.error("Error fetching team roles:", roleError);
        setLoading(false);
        return;
      }

      const userIds = roleData?.map((r) => r.user_id).filter((id) => id !== user?.id) || [];

      if (userIds.length === 0) {
        setTeamMembers([]);
        setLoading(false);
        return;
      }

      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", userIds)
        .eq("approval_status", "approved");

      if (profilesError) {
        console.error("Error fetching team profiles:", profilesError);
      } else {
        setTeamMembers(profiles || []);
      }
      setLoading(false);
    };

    fetchTeamMembers();
  }, [user?.id]);

  const toggleMember = (memberId: string) => {
    if (selectedMembers.includes(memberId)) {
      onSelectionChange(selectedMembers.filter((id) => id !== memberId));
    } else {
      onSelectionChange([...selectedMembers, memberId]);
    }
  };

  const removeMember = (memberId: string) => {
    onSelectionChange(selectedMembers.filter((id) => id !== memberId));
  };

  const getSelectedMemberNames = () => {
    return selectedMembers
      .map((id) => {
        const member = teamMembers.find((m) => m.id === id);
        return member?.full_name || member?.email || "Unknown";
      });
  };

  if (loading) {
    return (
      <div className="text-sm text-muted-foreground">Loading team members...</div>
    );
  }

  if (teamMembers.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Notify Team Members:</span>
      </div>
      
      <div className="flex flex-wrap gap-2 items-center">
        {selectedMembers.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {getSelectedMemberNames().map((name, index) => (
              <Badge
                key={selectedMembers[index]}
                variant="secondary"
                className="flex items-center gap-1 pr-1"
              >
                {name}
                <Button
                  type="button"
                  onClick={() => removeMember(selectedMembers[index])}
                  variant="ghost"
                  size="icon"
                  className="ml-1 h-5 w-5 rounded-full p-0"
                >
                  <X className="h-3 w-3" />
                </Button>
              </Badge>
            ))}
          </div>
        )}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              className="h-7 text-xs"
            >
              {selectedMembers.length === 0 ? "Select team members" : "Add more"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[250px] p-0" align="start">
            <Command>
              <CommandInput placeholder="Search team members..." />
              <CommandList>
                <CommandEmpty>No team members found.</CommandEmpty>
                <CommandGroup>
                  {teamMembers.map((member) => {
                    const isSelected = selectedMembers.includes(member.id);
                    return (
                      <CommandItem
                        key={member.id}
                        value={member.full_name || member.email}
                        onSelect={() => toggleMember(member.id)}
                      >
                        <div
                          className={cn(
                            "mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-primary",
                            isSelected
                              ? "bg-primary text-primary-foreground"
                              : "opacity-50 [&_svg]:invisible"
                          )}
                        >
                          <Check className="h-3 w-3" />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm">
                            {member.full_name || "No name"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {member.email}
                          </span>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
