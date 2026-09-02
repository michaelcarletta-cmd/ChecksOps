// Tenant Management Tabs component
import { useState } from "react\); import SecurityComplianceOverview from \"\./security-compliance\\); import Overview from \"\./overview\\); // assume existing overview component

const Tab = ({ children, onClick, isActive, className }) => (
  <button
    onClick={onClick}
    className={`${className} px-4 py-2 border-b-2 ${isActive ? \"border-blue-600 text-blue-600\" : \"text-gray-600\"}`}
  >
    {children}
  </button>
);

export default function TenantManagementTabs({ onTabChange }) {
  const [activeTab, setActiveTab] = useState(\"overview\");

  const tabs = [
    { id: \"overview\", label: \"Overview\", component: <Overview /> },
    { id: \"security-compliance\", label: \"Security & Compliance\", component: <SecurityComplianceOverview /> },
    // other tabs...
  ];

  const TabComponent = tabs.find((t) => t.id === activeTab)?.component;

  return (
    <div className=\"space-y-4\">
      {tabs.map((tab) => (
        <Tab
          key={tab.id}
          onClick={() => {
            setActiveTab(tab.id);
            onTabChange?.(tab.id);
          }}
          isActive={activeTab === tab.id}
          className=\"px-4 py-2 border-b-2 text-sm font-medium\"
        >
          {tab.label}
        </Tab>
      ))}
      {TabComponent}
    </div>
  );
