import { useEffect, useState } from "react";
import { Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { Theme, ThemePreference } from "../workspace/types";

export function SettingsCanvas({
  displayName,
  themePreference,
  resolvedTheme,
  onSaveName,
  onSaveAppearance,
  onBackToWorkspace,
  onReset,
}: {
  displayName: string;
  themePreference: ThemePreference;
  resolvedTheme: Theme;
  onSaveName: (name: string) => void;
  onSaveAppearance: (appearance: ThemePreference) => void;
  onBackToWorkspace: () => void;
  onReset: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(displayName);
  const [appearanceDraft, setAppearanceDraft] = useState<ThemePreference>(themePreference);
  const [nameSaved, setNameSaved] = useState(false);
  const [appearanceSaved, setAppearanceSaved] = useState(false);
  const [resetConfirming, setResetConfirming] = useState(false);

  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);

  useEffect(() => {
    setAppearanceDraft(themePreference);
  }, [themePreference]);

  const cleanedName = nameDraft.trim();
  const nameChanged = cleanedName !== displayName.trim();
  const appearanceChanged = appearanceDraft !== themePreference;

  function saveName() {
    onSaveName(cleanedName);
    setNameSaved(true);
  }

  function saveAppearance() {
    onSaveAppearance(appearanceDraft);
    setAppearanceSaved(true);
  }

  return (
    <section className="settings-view" aria-labelledby="screen-title">
      <header className="settings-header">
        <div>
          <h1 id="screen-title" tabIndex={-1}>Settings</h1>
          <p>Choose what SonIQ remembers on this Mac.</p>
        </div>
        <Button type="button" variant="secondary" onClick={onBackToWorkspace}>Return to workspace</Button>
      </header>

      <div className="settings-content">
        <section className="settings-section" aria-labelledby="settings-workspace-title">
          <div className="settings-section-heading">
            <h2 id="settings-workspace-title">Workspace</h2>
            <p>A local name helps SonIQ greet you. It stays on this Mac.</p>
          </div>
          <div className="settings-group">
            <label className="settings-field" htmlFor="settings-local-name">
              <span>Local name</span>
              <input
                id="settings-local-name"
                value={nameDraft}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  setNameSaved(false);
                }}
                placeholder="Your name"
                autoComplete="given-name"
                maxLength={32}
              />
              <small>Leave it blank if you prefer a quiet, unnamed workspace.</small>
            </label>
            <div className="settings-action-row">
              <Button type="button" variant="secondary" onClick={saveName} disabled={!nameChanged}>Save changes</Button>
              <span className="settings-inline-status" role="status" aria-live="polite">{nameSaved ? "Name saved locally." : ""}</span>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-appearance-title">
          <div className="settings-section-heading">
            <h2 id="settings-appearance-title">Appearance</h2>
            <p>Let SonIQ follow this Mac, or choose a fixed appearance.</p>
          </div>
          <div className="settings-group settings-group--appearance">
            <fieldset className="settings-appearance-fieldset">
              <legend className="sr-only">Appearance</legend>
              <div className="settings-appearance-options">
                <label className={appearanceDraft === "system" ? "settings-appearance-option is-selected" : "settings-appearance-option"}>
                  <input type="radio" name="settings-appearance" value="system" checked={appearanceDraft === "system"} onChange={() => { setAppearanceDraft("system"); setAppearanceSaved(false); }} />
                  <Monitor size={16} aria-hidden="true" />
                  <span><strong>System</strong><small>Follow this Mac · Currently {resolvedTheme}</small></span>
                </label>
                <label className={appearanceDraft === "light" ? "settings-appearance-option is-selected" : "settings-appearance-option"}>
                  <input type="radio" name="settings-appearance" value="light" checked={appearanceDraft === "light"} onChange={() => { setAppearanceDraft("light"); setAppearanceSaved(false); }} />
                  <Sun size={16} aria-hidden="true" />
                  <span><strong>Light</strong><small>Always use the light workspace</small></span>
                </label>
                <label className={appearanceDraft === "dark" ? "settings-appearance-option is-selected" : "settings-appearance-option"}>
                  <input type="radio" name="settings-appearance" value="dark" checked={appearanceDraft === "dark"} onChange={() => { setAppearanceDraft("dark"); setAppearanceSaved(false); }} />
                  <Moon size={16} aria-hidden="true" />
                  <span><strong>Dark</strong><small>Always use the dark workspace</small></span>
                </label>
              </div>
            </fieldset>
            <div className="settings-action-row">
              <Button type="button" variant="secondary" onClick={saveAppearance} disabled={!appearanceChanged}>Save appearance</Button>
              <span className="settings-inline-status" role="status" aria-live="polite">{appearanceSaved ? "Appearance saved." : ""}</span>
            </div>
          </div>
        </section>

        <section className="settings-section settings-section--danger" aria-labelledby="settings-reset-title">
          <div className="settings-section-heading">
            <h2 id="settings-reset-title">Reset SonIQ</h2>
            <p>Remove SonIQ’s local preferences and saved soundtrack history. Your original videos are never touched.</p>
          </div>
          <div className="settings-group settings-reset-group">
            {!resetConfirming ? (
              <Button type="button" variant="secondary" onClick={() => setResetConfirming(true)}>
                <RotateCcw size={15} aria-hidden="true" />
                Reset SonIQ…
              </Button>
            ) : (
              <div className="settings-reset-confirmation" role="group" aria-label="Confirm resetting SonIQ">
                <p><strong>Reset all local SonIQ data?</strong> This cannot be undone. It clears your name, appearance, saved scans, and soundtrack history, then returns you to first-run setup.</p>
                <div className="settings-reset-actions">
                  <Button type="button" variant="ghost" onClick={() => setResetConfirming(false)}>Cancel</Button>
                  <button className="settings-danger-button" type="button" onClick={onReset}>
                    <RotateCcw size={15} aria-hidden="true" />
                    Reset SonIQ
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}

