import { Brain, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface TabOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  staffOnly?: boolean;
}

interface ClaimTabsDropdownProps {
  activeTab: string;
  onTabChange: (value: string) => void;
  isStaffOrAdmin: boolean;
}

const tabOptions: TabOption[] = [
  { value: "overview", label: "Overview" },
  { value: "assigned", label: "Assigned", staffOnly: true },
  { value: "activity", label: "Notes & Activity" },
  { value: "tasks", label: "Tasks", staffOnly: true },
  { value: "inspections", label: "Inspections" },
  { value: "photos", label: "Photos" },
  { value: "files", label: "Files" },
  { value: "accounting", label: "Accounting" },
  { value: "access", label: "Portal Access", staffOnly: true },
  { value: "darwin", label: "Darwin", icon: <Brain className="h-4 w-4 mr-2" />, staffOnly: true },
];

export function ClaimTabsDropdown({ activeTab, onTabChange, isStaffOrAdmin }: ClaimTabsDropdownProps) {
  const filteredTabs = tabOptions.filter(tab => !tab.staffOnly || isStaffOrAdmin);
  const activeTabOption = filteredTabs.find(tab => tab.value === activeTab) || filteredTabs[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button 
          variant="outline" 
          className="w-full justify-between bg-muted border-border text-foreground font-medium"
        >
          <span className="flex items-center">
            {activeTabOption.icon}
            {activeTabOption.label}
          </span>
          <ChevronDown className="h-4 w-4 ml-2 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent 
        className="w-[var(--radix-dropdown-menu-trigger-width)] bg-popover border-border"
        align="start"
      >
        {filteredTabs.map((tab) => (
          <DropdownMenuItem
            key={tab.value}
            onClick={() => onTabChange(tab.value)}
            className={`cursor-pointer ${activeTab === tab.value ? 'bg-accent text-accent-foreground' : ''}`}
          >
            {tab.icon}
            {tab.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
