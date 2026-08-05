import "i18next";

// i18next v26 type augmentation (docs: https://www.i18next.com/overview/typescript).
// JSON imports keep property NAMES as literal keys, so key existence is now
// checked at compile time even though values widen to `string` (JSON cannot
// provide literal types — interpolation-{{var}} checks need `as const` TS
// resources; see "Not working interpolation values" in the same docs page).
import type enTranslation from "./locales/en/translation.json";

declare module "i18next" {
  interface CustomTypeOptions {
    // All keys live in the single "translation" namespace configured in
    // src/i18n.ts (resources = { en: { translation }, vi: { translation } }).
    defaultNS: "translation";
    resources: {
      translation: typeof enTranslation;
    };
  }
}
