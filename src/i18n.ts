import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enTranslation from "./locales/en/translation.json";
import viTranslation from "./locales/vi/translation.json";
import { LANGUAGE_KEY } from "./utils/storageKeys";
import { captureError } from "./utils/errorLog";

const resources = {
  en: {
    translation: enTranslation,
  },
  vi: {
    translation: viTranslation,
  },
};

let savedLanguage = "en";
try {
  savedLanguage = localStorage.getItem(LANGUAGE_KEY) || "en";
} catch (err) {
  // Storage blocked (SecurityError — see MDN Window.localStorage): the app
  // must boot even when persistence is unavailable, so fall back to English.
  // Fire-and-forget: captureError never rejects.
  void captureError({
    level: "warn",
    source: "i18n",
    message: `i18n-language-read-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
  });
}

// Keep <html lang> in sync with the active language so screen readers and the
// browser pick the right defaults. i18next emits 'languageChanged' on init and
// on every changeLanguage() call (see LanguageDropdown), so one listener covers
// both paths. index.html keeps the static default (en) for the pre-boot shell.
const syncDocumentLang = (lng: string) => {
  if (typeof document === "undefined") return;
  // Bare-DOM test environments may stub document WITHOUT documentElement
  // (errorCapture.test.ts sets globalThis.document = { getElementById: ... }),
  // so treat it as optional despite the DOM lib types.
  const docElement = (
    document as Omit<Document, "documentElement"> & {
      documentElement?: HTMLElement;
    }
  ).documentElement;
  if (docElement) {
    docElement.lang = lng;
  }
};

i18n.on("languageChanged", syncDocumentLang);

// Fire-and-forget: i18next init() returns a completion promise the app does
// not await (resources are bundled, init is synchronous in practice).
void i18n.use(initReactI18next).init({
  resources,
  lng: savedLanguage,
  fallbackLng: "en",
  // Corrupt stored values fall back to 'en' instead of being used as-is.
  supportedLngs: ["en", "vi"],
  interpolation: {
    escapeValue: false, // react already safes from xss
  },
});

// Belt-and-suspenders: init is synchronous here, but if a future backend makes
// it async the initial document.lang must still match the resolved language.
syncDocumentLang(i18n.language || "en");

export default i18n;
