import { FileVideo, LockKeyhole, Moon, Music2, Sun } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { Theme } from "../workspace/types";

export function Onboarding({
  name,
  theme,
  onNameChange,
  onThemeChange,
  onComplete,
}: {
  name: string;
  theme: Theme;
  onNameChange: (name: string) => void;
  onThemeChange: (theme: Theme) => void;
  onComplete: () => void;
}) {
  return (
    <div className="onboarding-shell" data-theme={theme}>
      {/* Left column — form */}
      <div className="onboarding-left">
        <div className="onboarding-left-brand ob-stagger" style={{ animationDelay: "0ms" }}>
          <span className="app-brand-mark" aria-hidden="true">
            <Music2 size={14} strokeWidth={2.4} />
          </span>
          <span>SonIQ</span>
        </div>

        <div className="onboarding-left-form">
          <div className="ob-stagger" style={{ animationDelay: "60ms" }}>
            <p className="onboarding-kicker">
              <span>SonIQ</span>
              <span className="kicker-pill">First run</span>
            </p>
          </div>

          <h1 className="onboarding-title ob-stagger" style={{ animationDelay: "120ms" }}>
            Set up SonIQ
          </h1>
          <p className="onboarding-subtitle ob-stagger" style={{ animationDelay: "180ms" }}>
            Let's start with the basic information about your workspace
          </p>

          <div className="onboarding-separator ob-stagger" style={{ animationDelay: "220ms" }} />

          <label className="onboarding-field ob-stagger" style={{ animationDelay: "260ms" }}>
            <span className="onboarding-field-label">Enter your name</span>
            <input
              className="onboarding-field-input"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="Your name"
              autoComplete="given-name"
              maxLength={32}
            />
          </label>

          <fieldset className="onboarding-appearance ob-stagger" style={{ animationDelay: "320ms" }}>
            <legend className="onboarding-field-label">Select appearance</legend>
            <div className="appearance-options">
              <label className={"appearance-option" + (theme === "light" ? " is-selected" : "")}>
                <input type="radio" name="appearance" value="light" checked={theme === "light"} onChange={() => onThemeChange("light")} className="sr-only" />
                <Sun size={14} aria-hidden="true" />
                <span>Light</span>
              </label>
              <label className={"appearance-option" + (theme === "dark" ? " is-selected" : "")}>
                <input type="radio" name="appearance" value="dark" checked={theme === "dark"} onChange={() => onThemeChange("dark")} className="sr-only" />
                <Moon size={14} aria-hidden="true" />
                <span>Dark</span>
              </label>
            </div>
          </fieldset>

          <div className="onboarding-actions ob-stagger" style={{ animationDelay: "380ms" }}>
            <Button type="button" onClick={onComplete} className="onboarding-continue">
              Continue
            </Button>
          </div>
        </div>
      </div>

      {/* Right column — preview */}
      <div className="onboarding-right">
        <div className="onboarding-preview-card ob-scale-in">
          <div className="preview-card-header">
            <div className="preview-card-brand">
              <span className="app-brand-mark" aria-hidden="true">
                <Music2 size={10} strokeWidth={2.4} />
              </span>
              <span>SonIQ</span>
            </div>
            <div className="preview-card-nav">
              <span className="preview-nav-item is-active">New scan</span>
              <span className="preview-nav-item">Library</span>
            </div>
          </div>
          <div className="preview-card-body">
            <div className="preview-card-workspace">
              <div className="preview-workspace-toolbar">
                <span>New scan</span>
                <span className="preview-badge">
                  <LockKeyhole size={9} aria-hidden="true" />
                </span>
              </div>
              <div className="preview-workspace-content">
                <FileVideo size={28} strokeWidth={1.2} aria-hidden="true" />
                <span>Choose a video</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

