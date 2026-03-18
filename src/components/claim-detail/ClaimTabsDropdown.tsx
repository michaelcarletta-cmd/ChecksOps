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

const staffTabOptions: TabOption[] = [
  { value: "darwin", label: "Darwin", icon: <Brain className="h-4 w-4 mr-2" /> },
];

const portalTabOptions: TabOption[] = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Notes & Activity" },
  { value: "inspections", label: "Inspections" },
  { value: "photos", label: "Photos" },
  { value: "files", label: "Files" },
  { value: "accounting", label: "Accounting" },
];

export function ClaimTabsDropdown({ activeTab, onTabChange, isStaffOrAdmin }: ClaimTabsDropdownProps) {
  const filteredTabs = isStaffOrAdmin ? staffTabOptions : portalTabOptions;
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
