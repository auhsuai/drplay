import { HardDrive } from "lucide-react";
import { TABS, type TabKey } from "../../utils/driveConstants";
import { UploadButton } from "../components/UploadButton";

interface SidebarHeaderProps {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  token?: string | null | undefined;
  activeTab: TabKey;
}

export function SidebarHeader({
  isSidebarOpen,
  onToggleSidebar,
  token,
  activeTab,
}: SidebarHeaderProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className="px-7 py-6 flex items-center cursor-pointer transition-all duration-300"
      onClick={onToggleSidebar}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleSidebar();
        }
      }}
    >
      <h1
        className="text-xl font-bold flex items-center text-[#4285F4] w-full"
        title="DrPlay"
      >
        <HardDrive className="w-6 h-6 shrink-0" />
        <div
          className={`overflow-hidden transition-all duration-300 whitespace-nowrap flex items-center ${isSidebarOpen ? "max-w-[100px] opacity-100 ml-2" : "max-w-0 opacity-0 ml-0"}`}
        >
          <span className="truncate">DrPlay</span>
        </div>
        {/* ml-auto pushes the upload button to the header's right edge,
            vertically centered against the heading — no negative margin
            so it stays inside the header's px-7 padding. */}
        {isSidebarOpen && (
          <div className="ml-auto flex items-center">
            <UploadButton token={token} disabled={activeTab !== TABS.myDrive} />
          </div>
        )}
      </h1>
    </div>
  );
}
