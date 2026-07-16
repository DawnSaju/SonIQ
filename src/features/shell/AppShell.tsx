import { LockKeyhole, Moon, Music2, Settings, Sun } from "lucide-react";
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
    <aside className="app-sidebar" aria-label="SonIQ navigation">
      <div className="sidebar-brand">
        <span className="app-brand-mark" aria-hidden="true">
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
  onToggleTheme,
}: {
  activeView: AppView;
  context?: string;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  return (
    <div className="workspace-toolbar">
      <div className="toolbar-breadcrumb">
        {context ?? (activeView === "scan" ? "New scan" : activeView === "library" ? "Library" : "Settings")}
      </div>
      <div className="toolbar-actions">
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

