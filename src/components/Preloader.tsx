import React, { useEffect, useState, useRef } from "react";
import "./Preloader.css";

type PreloaderProps = {
  loading?: boolean;
  isComplete?: boolean;
  size?: number;
  strokeWidth?: number;
  loopDurationSeconds?: number;
  fillFadeSeconds?: number;
  className?: string;
  ariaLabel?: string;
  onDone?: () => void;
};

const LOGO_VIEW_BOX = "0 0 35 40";

const TRACE_PATH =
  "M32.6727 5.67902e-05C33.0099 -0.00299568 33.3663 0.117453 33.6724 0.252917C34.5499 0.641158 34.735 1.55277 34.7476 2.44591C34.7705 4.05811 34.7561 5.69217 34.7541 7.31369L34.748 16.7811L34.754 24.6655C34.7549 26.1769 34.7882 27.694 34.711 29.2024C34.4673 33.9594 29.4245 36.8379 25.1868 34.7636C23.6258 33.9962 22.4344 32.6393 21.8753 30.9923C21.2917 29.3053 21.4144 27.4541 22.2156 25.859C22.9884 24.2985 24.3488 23.1083 25.9982 22.5498C27.9907 21.8825 29.7483 22.1889 31.5948 23.1112L31.6037 15.2419C31.6052 13.8407 31.6834 12.3923 31.4925 11.0084C31.3545 9.82067 30.1588 9.60783 29.1958 9.91588C24.8206 11.3166 20.4733 12.8161 16.1035 14.2364C14.8544 14.6424 14.365 14.8091 13.6824 15.9874C13.3562 16.8865 13.4558 18.8976 13.4558 19.9521L13.4662 28.9787C13.468 30.2117 13.5334 32.8387 13.3733 33.9355C13.2372 34.8927 12.9173 35.8146 12.431 36.6503C11.5337 38.1821 10.0358 39.3578 8.30935 39.7975C6.56919 40.2355 4.72597 39.9565 3.19322 39.0234C1.69661 38.1326 0.619852 36.6787 0.204199 34.9874C-0.234143 33.2845 0.0397686 31.4766 0.962984 29.98C1.88207 28.453 3.3763 27.3594 5.10978 26.9452C6.93715 26.5013 8.71098 26.8448 10.3078 27.8189C10.4149 21.7179 10.245 15.5923 10.3541 9.48961C10.403 6.75888 13.2914 6.4194 15.4375 5.70958L21.6695 3.63555L28.7287 1.25891C29.8133 0.893688 31.6198 0.226022 32.6727 5.67902e-05Z";
const FILL_PATHS = [TRACE_PATH] as const;

type LoaderPhase = "loop" | "closingOutline" | "fadingFill" | "done";

export const Preloader: React.FC<PreloaderProps> = ({
  loading = true,
  isComplete = false,
  size = 40,
  strokeWidth = 2,
  loopDurationSeconds = 1.5,
  fillFadeSeconds = 0.5,
  className = "",
  ariaLabel = "Loading...",
  onDone,
}) => {
  const [phase, setPhase] = useState<LoaderPhase>("loop");
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const listener = (e: MediaQueryListEvent) =>
      setPrefersReducedMotion(e.matches);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) {
      if (phase !== "done") {
        setPhase("done");
      }
      return;
    }

    if (!loading || isComplete) {
      if (phase === "loop") {
        setPhase("closingOutline");
      }
    }
  }, [loading, isComplete, prefersReducedMotion, phase]);

  useEffect(() => {
    if (phase === "closingOutline") {
      const timeout = setTimeout(() => {
        setPhase("fadingFill");
      }, 300);
      return () => clearTimeout(timeout);
    } else if (phase === "fadingFill") {
      const timeout = setTimeout(() => {
        setPhase("done");
      }, fillFadeSeconds * 1000);
      return () => clearTimeout(timeout);
    } else if (phase === "done") {
      if (onDoneRef.current) {
        onDoneRef.current();
      }
    }
  }, [phase, fillFadeSeconds]);

  return (
    <svg
      role="status"
      aria-label={ariaLabel}
      viewBox={LOGO_VIEW_BOX}
      width={size}
      height={size}
      className={`preloader-svg ${className}`}
    >
      {!prefersReducedMotion && phase !== "done" && (
        <g opacity="0.18">
          <path
            d={TRACE_PATH}
            fill="none"
            stroke="currentColor"
            strokeWidth={Math.max(1, strokeWidth / 2)}
            strokeLinejoin="round"
          />
        </g>
      )}

      {!prefersReducedMotion && (
        <path
          d={TRACE_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          style={{
            strokeDasharray: phase === "loop" ? "0.16 0.84" : "1 0",
            transition: "stroke-dasharray 0.3s ease-out",
            animation: `preloader-loop ${loopDurationSeconds}s linear infinite`,
            animationPlayState: phase === "done" ? "paused" : "running",
          }}
        />
      )}

      {(phase === "fadingFill" || phase === "done") &&
        FILL_PATHS.map((path, i) => (
          <path
            key={i}
            d={path}
            fill="currentColor"
            className={
              phase === "fadingFill" ? "preloader-fill-enter" : ""
            }
            style={
              phase === "fadingFill"
                ? { animationDuration: `${fillFadeSeconds}s` }
                : {}
            }
          />
        ))}
    </svg>
  );
};
