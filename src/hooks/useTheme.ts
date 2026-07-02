import { useState, useEffect } from "react";

export type ThemeType = 'light' | 'dark' | 'system';

export const useTheme = () => {
  const [theme, setTheme] = useState<ThemeType>('system');

  useEffect(() => {
    const savedTheme = localStorage.getItem("drplay_theme") as ThemeType;
    if (savedTheme) {
      setTheme(savedTheme);
    }
  }, []);

  // Apply Theme
  useEffect(() => {
    const applyTheme = () => {
      const root = window.document.documentElement;
      const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

      root.classList.remove('light', 'dark');

      if (theme === 'dark' || (theme === 'system' && systemPrefersDark)) {
        root.classList.add('dark');
      } else {
        root.classList.add('light');
      }
    };
    applyTheme();

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      if (theme === 'system') applyTheme();
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const changeTheme = (newTheme: ThemeType) => {
    setTheme(newTheme);
    localStorage.setItem('drplay_theme', newTheme);
  };

  return { theme, setTheme: changeTheme };
};
