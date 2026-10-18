import { useTranslation } from "react-i18next";
import type { ThemeType } from "../../../hooks/useTheme";
import { OptionDropdown } from "../../components/OptionDropdown";

export function ThemeDropdown({
  currentTheme,
  onChange,
}: {
  currentTheme: ThemeType;
  onChange: (theme: ThemeType) => void;
}) {
  const { t } = useTranslation();

  const themes: { value: ThemeType; label: string }[] = [
    { value: "light", label: t("settings.light_mode") },
    { value: "dark", label: t("settings.dark_mode") },
    { value: "system", label: t("settings.system_mode") },
  ];

  const currentOption = themes.find((tm) => tm.value === currentTheme) ??
    themes[2] ?? { value: "system", label: "System Default" };

  return (
    <OptionDropdown
      ariaLabel={currentOption.label}
      value={currentOption.value}
      options={themes}
      onChange={(value) => {
        onChange(value as ThemeType);
      }}
    />
  );
}
