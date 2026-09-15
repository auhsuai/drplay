import { useState, useLayoutEffect } from "react";
import { captureError } from "../utils/errorLog";

export type ThemeType = "light" | "dark" | "system";

function isThemeType(value: unknown): value is ThemeType {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredTheme(): ThemeType {
  try {
    const v = localStorage.getItem("drplay_theme");
    return isThemeType(v) ? v : "system";
  } catch {
    return "system";
  }
}

function resolveThemeClass(theme: ThemeType): "light" | "dark" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyThemeClass(theme: ThemeType): void {
  const root = window.document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolveThemeClass(theme));
}

// Pre-mount bootstrap for main.tsx: apply the persisted theme class BEFORE
// createRoot's first commit. The hook below applies it in useLayoutEffect,
// which only runs AFTER the first commit — and lazy chunks/Suspense postpone
// that commit, leaving the light App.css background painted in the meantime.
// Shares read/resolve logic with the hook (single source, no duplication).
export function applyStoredTheme(): ThemeType {
  const theme = readStoredTheme();
  applyThemeClass(theme);
  return theme;
}

export const useTheme = () => {
  // Lazy initializer: read the stored theme on first render so the apply
  // effect below already sees the right value (no FOUC after first paint).
  const [theme, setTheme] = useState<ThemeType>(readStoredTheme);

  // Apply Theme. useLayoutEffect (not useEffect): the class must land before
  // the first paint or dark-mode users see a white flash (App.css defaults to
  // #ffffff until .dark is set). React docs: useLayoutEffect "fires before the
  // browser repaints"; useEffect "can result in visual flickering".
  useLayoutEffect(() => {
    applyThemeClass(theme);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme === "system") applyThemeClass(theme);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [theme]);

  const changeTheme = (newTheme: ThemeType) => {
    setTheme(newTheme);
    try {
      localStorage.setItem("drplay_theme", newTheme);
    } catch {
      void captureError({
        level: "warn",
        source: "useTheme",
        message: "theme-write-failed",
      });
    }
  };

  return { theme, setTheme: changeTheme };
};
