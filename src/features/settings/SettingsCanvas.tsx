import { useEffect, useState } from "react";
import { Monitor, Moon, Sun, AlertTriangle, Youtube, Music2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "../../components/ui/button";
import type { Theme, ThemePreference } from "../workspace/types";

const appearanceOptions = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

export function SettingsCanvas({
  displayName,
  themePreference,
  resolvedTheme,
  onSaveName,
  onSaveAppearance,
  onBackToWorkspace,
  onReset,
  isSpotifyConnected,
  spotifyAuthLoading,
  onSpotifyConnect,
  onSpotifyDisconnect,
  exportPlatform,
  onExportPlatformChange,
}: {
  displayName: string;
  themePreference: ThemePreference;
  resolvedTheme: Theme;
  onSaveName: (name: string) => void;
  onSaveAppearance: (appearance: ThemePreference) => void;
  onBackToWorkspace: () => void;
  onReset: () => void;
  isSpotifyConnected?: boolean;
  spotifyAuthLoading?: boolean;
  onSpotifyConnect?: () => void;
  onSpotifyDisconnect?: () => void;
  exportPlatform?: "spotify" | "youtube";
  onExportPlatformChange?: (platform: "spotify" | "youtube") => void;
}) {
  const [nameDraft, setNameDraft] = useState(displayName);
  const [resetConfirming, setResetConfirming] = useState(false);

  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);

  function handleNameBlur() {
    const cleaned = nameDraft.trim();
    if (cleaned !== displayName.trim()) {
      onSaveName(cleaned);
    }
  }

  return (
    <section className="settings-view" aria-labelledby="screen-title">
      <h1 id="screen-title" className="sr-only" tabIndex={-1}>Settings</h1>
      
      <div className="settings-content">
        
        {/* Workspace Section */}
        <div className="settings-section">
          <h2 className="settings-section-title">Workspace</h2>
          <div className="settings-form-row">
            <div className="settings-form-label">
              <label htmlFor="settings-local-name">Local name</label>
              <p className="settings-form-desc">A local name helps SonIQ greet you.</p>
            </div>
            <div className="settings-form-control">
              <input
                id="settings-local-name"
                className="mac-text-input"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={handleNameBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Your name"
                autoComplete="given-name"
                maxLength={32}
              />
            </div>
          </div>
        </div>

        <hr className="settings-divider" />

        {/* Appearance Section */}
        <div className="settings-section">
          <h2 className="settings-section-title">Appearance</h2>
          <div className="settings-form-row">
            <div className="settings-form-label">
              <label>Theme</label>
              <p className="settings-form-desc">Let SonIQ follow this Mac, or choose a fixed appearance.</p>
            </div>
            <div className="settings-form-control">
              <div className="segmented-control" role="radiogroup" aria-label="Theme preference">
                {appearanceOptions.map((opt) => {
                  const isActive = themePreference === opt.value;
                  return (
                    <motion.button
                      key={opt.value}
                      role="radio"
                      aria-checked={isActive}
                      className={`segmented-btn ${isActive ? "is-active" : ""}`}
                      onClick={() => onSaveAppearance(opt.value as ThemePreference)}
                      whileTap={{ scale: 0.96 }}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="appearance-active-bg"
                          className="segmented-bg"
                          transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
                        />
                      )}
                      <span className="segmented-content">
                        <opt.icon size={13} strokeWidth={2.5} />
                        {opt.label}
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <hr className="settings-divider" />

        {/* Integrations Section */}
        <div className="settings-section">
          <h2 className="settings-section-title">Integrations</h2>
          
          <div className="settings-form-row">
            <div className="settings-form-label">
              <label>Default Export Platform</label>
              <p className="settings-form-desc">Choose where to export your soundtracks by default.</p>
            </div>
            <div className="settings-form-control">
              <div className="segmented-control" role="radiogroup" aria-label="Default Export Platform">
                {[{ value: "youtube", label: "YouTube (Free)", icon: Youtube }, { value: "spotify", label: "Spotify", icon: Music2 }].map((opt) => {
                  const isActive = (exportPlatform || "youtube") === opt.value;
                  
                  return (
                    <motion.button
                      key={opt.value}
                      role="radio"
                      aria-checked={isActive}
                      className={`segmented-btn ${isActive ? "is-active" : ""}`}
                      onClick={() => onExportPlatformChange?.(opt.value as "youtube" | "spotify")}
                      whileTap={{ scale: 0.96 }}
                    >
                      {isActive && (
                        <motion.div
                          layoutId="platform-active-bg"
                          className="segmented-bg"
                          transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
                        />
                      )}
                      <span className="segmented-content">
                        <opt.icon size={13} strokeWidth={2.5} />
                        {opt.label}
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {exportPlatform === "spotify" && (
              <motion.div 
                className="settings-form-row"
                initial={{ height: 0, opacity: 0, marginTop: 0 }}
                animate={{ height: "auto", opacity: 1, marginTop: 24 }}
                exit={{ height: 0, opacity: 0, marginTop: 0 }}
                transition={{ type: "spring", bounce: 0, duration: 0.4 }}
                style={{ overflow: 'hidden' }}
              >
                <div className="settings-form-label">
                  <label>Spotify Connection</label>
                  <p className="settings-form-desc">Export your completed soundtracks to Spotify.</p>
                </div>
                <div className="settings-form-control">
                  {isSpotifyConnected ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="quiet-note">Connected</span>
                      <Button type="button" variant="secondary" onClick={onSpotifyDisconnect}>Disconnect</Button>
                    </div>
                  ) : (
                    <Button type="button" variant="secondary" onClick={onSpotifyConnect} disabled={spotifyAuthLoading}>
                      {spotifyAuthLoading ? "Connecting..." : "Connect Spotify"}
                    </Button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <hr className="settings-divider" />

        {/* Danger Section */}
        <div className="settings-section">
          <h2 className="settings-section-title">Data Management</h2>
          <div className="settings-form-row settings-form-row--danger">
            <div className="settings-form-label">
              <label>Reset SonIQ</label>
              <p className="settings-form-desc">Clears all local settings and your scanned soundtrack history. Your original media files are never touched.</p>
            </div>
            <div className="settings-form-control">
              <Button type="button" variant="secondary" onClick={() => setResetConfirming(true)}>
                Reset Data...
              </Button>
            </div>
          </div>
        </div>

      </div>

      <AnimatePresence>
        {resetConfirming && (
          <motion.div
            className="settings-modal-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <motion.div
              key="reset-confirm"
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: "spring", bounce: 0, duration: 0.3 }}
              className="settings-reset-dialog"
            >
              <div className="settings-reset-dialog-content">
                <AlertTriangle size={16} className="text-destructive" />
                <div>
                  <strong>Are you sure?</strong>
                  <p>This action cannot be undone.</p>
                </div>
              </div>
              <div className="settings-reset-dialog-actions">
                <Button type="button" variant="ghost" onClick={() => setResetConfirming(false)}>
                  Cancel
                </Button>
                <button className="settings-danger-button" onClick={() => {
                  setResetConfirming(false);
                  onReset();
                }}>
                  Confirm Reset
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </section>
  );
}
