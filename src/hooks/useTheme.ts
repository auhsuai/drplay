import { useState, useEffect } from "react";
import { captureError } from "../utils/errorLog";

export type ThemeType = "light" | "dark" | "system";

function isThemeType(value: unknown): value is ThemeType {
  return value === "light" || value === "dark" || value === "system";
}

export const useTheme = () => {
  // Lazy initializer: read the stored theme on first render so the apply
  // effect below already sees the right value (no FOUC after first paint).
  const [theme, setTheme] = useState<ThemeType>(() => {
    try {
      const v = localStorage.getItem("drplay_theme");
      return isThemeType(v) ? v : "system";
    } catch {
      return "system";
    }
  });

  // Apply Theme
  useEffect(() => {
    const applyTheme = () => {
      const root = window.document.documentElement;
      const systemPrefersDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;

      root.classList.remove("light", "dark");

      if (theme === "dark" || (theme === "system" && systemPrefersDark)) {
        root.classList.add("dark");
      } else {
        root.classList.add("light");
      }
    };
    applyTheme();

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (theme === "system") applyTheme();
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  const changeTheme = (newTheme: ThemeType) => {
    setTheme(newTheme);
    try {
      localStorage.setItem("drplay_theme", newTheme);
    } catch {
      captureError({
        level: "warn",
        source: "useTheme",
        message: "theme-write-failed",
      });
    }
  };

  return { theme, setTheme: changeTheme };
};
