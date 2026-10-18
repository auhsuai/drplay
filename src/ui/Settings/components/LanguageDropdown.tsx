import { useTranslation } from "react-i18next";
import { LANGUAGE_KEY } from "../../../utils/storageKeys";
import { captureError } from "../../../utils/errorLog";
import { OptionDropdown } from "../../components/OptionDropdown";

export function LanguageDropdown() {
  const { t, i18n } = useTranslation();

  const languages = [
    { value: "en", label: t("settings.english") },
    { value: "vi", label: t("settings.vietnamese") },
  ];

  const currentLang = languages.find((l) => l.value === i18n.language) ??
    languages[0] ?? { value: "en", label: "English" };

  const handleSelect = (code: string) => {
    void i18n.changeLanguage(code);
    try {
      localStorage.setItem(LANGUAGE_KEY, code);
    } catch (err) {
      void captureError({
        level: "warn",
        source: "LanguageDropdown",
        message: `language-write-failed:${err instanceof Error || err instanceof DOMException ? err.name : "unknown"}`,
      });
    }
  };

  return (
    <OptionDropdown
      ariaLabel={currentLang.label}
      value={currentLang.value}
      options={languages}
      onChange={handleSelect}
    />
  );
}
