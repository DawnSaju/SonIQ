import { LockKeyhole, Moon, Music2, Settings, Sun, LayoutGrid, List } from "lucide-react";
import type { AppView, Theme } from "../workspace/types";

export function AppSidebar({
  activeView,
  onNewScan,
  onLibrary,
  onSettings,
}: {
  activeView: AppView;
  onNewScan: () => void;
  onLibrary: () => void;
  onSettings?: () => void;
}) {
  return (
    <aside className="app-sidebar" aria-label="SonIQ navigation" data-tauri-drag-region>
      <div className="sidebar-brand" data-tauri-drag-region>
        <span className="app-brand-mark" aria-hidden="true" data-tauri-drag-region>
          <Music2 size={14} strokeWidth={2.4} />
        </span>
        <span>SonIQ</span>
      </div>
      <nav className="sidebar-nav">
        <button className={activeView === "scan" ? "sidebar-nav-link is-active" : "sidebar-nav-link"} type="button" onClick={onNewScan} aria-current={activeView === "scan" ? "page" : undefined}>
          New scan
        </button>
        <button className={activeView === "library" ? "sidebar-nav-link is-active" : "sidebar-nav-link"} type="button" onClick={onLibrary} aria-current={activeView === "library" ? "page" : undefined}>
          Library
        </button>
      </nav>
      {onSettings && (
        <div className="sidebar-footer">
          <button className={activeView === "settings" ? "sidebar-nav-link sidebar-settings-link is-active" : "sidebar-nav-link sidebar-settings-link"} type="button" onClick={onSettings} aria-current={activeView === "settings" ? "page" : undefined}>
            <Settings size={14} strokeWidth={1.9} aria-hidden="true" />
            Settings
          </button>
        </div>
      )}
    </aside>
  );
}

export function WorkspaceToolbar({
  activeView,
  context,
  theme,
  viewMode,
  onToggleTheme,
  onToggleViewMode,
}: {
  activeView: AppView;
  context?: string;
  theme: Theme;
  viewMode?: "list" | "grid";
  onToggleTheme: () => void;
  onToggleViewMode?: (mode: "list" | "grid") => void;
}) {
  return (
    <div className="workspace-toolbar" data-tauri-drag-region>
      <div className="toolbar-breadcrumb" data-tauri-drag-region>
        {context ?? (activeView === "scan" ? "New scan" : activeView === "library" ? "Library" : "Settings")}
      </div>
      <div className="toolbar-actions">
        {activeView === "library" && onToggleViewMode && (
          <div className="segmented-control" role="group" aria-label="View mode">
            <button className={viewMode === "list" ? "segmented-control-item is-active" : "segmented-control-item"} type="button" onClick={() => onToggleViewMode("list")} aria-label="List view" title="List view">
              <List size={14} aria-hidden="true" />
            </button>
            <button className={viewMode === "grid" ? "segmented-control-item is-active" : "segmented-control-item"} type="button" onClick={() => onToggleViewMode("grid")} aria-label="Grid view" title="Grid view">
              <LayoutGrid size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        <span className="header-local-status">
          <LockKeyhole size={13} aria-hidden="true" />
        </span>
        <button
          className="header-icon-button"
          type="button"
          onClick={onToggleTheme}
          aria-label={"Switch to " + (theme === "light" ? "dark" : "light") + " appearance"}
          title={"Switch to " + (theme === "light" ? "dark" : "light") + " appearance"}
        >
          {theme === "light" ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

