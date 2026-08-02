import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import enTranslation from './locales/en/translation.json';
import viTranslation from './locales/vi/translation.json';
import { LANGUAGE_KEY } from './utils/storageKeys';
import { captureError } from './utils/errorLog';

const resources = {
  en: {
    translation: enTranslation,
  },
  vi: {
    translation: viTranslation,
  },
};

let savedLanguage = 'en';
try {
  savedLanguage = localStorage.getItem(LANGUAGE_KEY) || 'en';
} catch (err) {
  // Storage blocked (SecurityError — see MDN Window.localStorage): the app
  // must boot even when persistence is unavailable, so fall back to English.
  captureError({
    level: 'warn',
    source: 'i18n',
    message: `i18n-language-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : 'unknown'}`
  });
}

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: savedLanguage,
    fallbackLng: 'en',
    // Corrupt stored values fall back to 'en' instead of being used as-is.
    supportedLngs: ['en', 'vi'],
    interpolation: {
      escapeValue: false, // react already safes from xss
    },
  });

export default i18n;
