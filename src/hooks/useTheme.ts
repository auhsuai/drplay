import { useState, useEffect, useRef, useCallback } from "react";

export type ThemeType = 'light' | 'dark' | 'system';

export const useTheme = () => {
  const [theme, setTheme] = useState<ThemeType>('system');
  // Lets the system-preference listener below read the LATEST theme at
  // fire-time without needing to be recreated whenever `theme` changes.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const savedTheme = localStorage.getItem("drplay_theme") as ThemeType;
    if (savedTheme) {
      setTheme(savedTheme);
    }
  }, []);

  const applyTheme = useCallback((currentTheme: ThemeType) => {
    const root = window.document.documentElement;
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    root.classList.remove('light', 'dark');

    if (currentTheme === 'dark' || (currentTheme === 'system' && systemPrefersDark)) {
      root.classList.add('dark');
    } else {
      root.classList.add('light');
    }
  }, []);

  // Apply theme whenever the user-facing value changes.
  useEffect(() => {
    applyTheme(theme);
  }, [theme, applyTheme]);

  // System-preference-change listener. Registered ONCE for the lifetime of
  // this hook instead of being torn down and recreated on every theme
  // toggle — a `matchMedia` subscription conceptually outlives any single
  // theme value, it just needs to re-check `theme === 'system'` (via the ref
  // above) whenever the OS preference actually changes. `applyTheme` is a
  // stable `useCallback` (empty deps), so this effect's own deps never
  // change either, keeping the listener genuinely singular.
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (themeRef.current === 'system') applyTheme('system');
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [applyTheme]);

  const changeTheme = (newTheme: ThemeType) => {
    setTheme(newTheme);
    localStorage.setItem('drplay_theme', newTheme);
  };

  return { theme, setTheme: changeTheme };
};
