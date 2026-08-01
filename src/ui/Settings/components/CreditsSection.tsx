import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyToClipboard } from "../../../utils/copyToClipboard";
import { showErrorToast } from "../../../utils/simpleToast";
import { captureError } from "../../../utils/errorLog";

const CREDITS_MODULE = 'CreditsSection';

export const TELEGRAM_URL = "https://t.me/nguyen_tan_an";
export const GITHUB_URL = "https://github.com/auhsuai/drplay";

// Lucide v1 removed all brand icons (Github, Telegram, ...), so brand marks
// must be provided as inline SVG rather than imported from lucide-react.
// See: https://lucide.dev/guide/react/migration (Brand icons removed in v1).
function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

interface CreditLink {
  label: string;
  display: string;
  url: string;
  Icon: (props: { className?: string }) => ReactElement;
}

const CREDIT_LINKS: CreditLink[] = [
  { label: "Telegram", display: "@nguyen_tan_an", url: TELEGRAM_URL, Icon: TelegramIcon },
  { label: "Github", display: "auhsuai/drplay", url: GITHUB_URL, Icon: GithubIcon },
];

export function CreditsSection() {
  const { t } = useTranslation();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleOpen = (url: string) => async () => {
    try {
      await openUrl(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      captureError({ level: 'error', source: CREDITS_MODULE, message: `open-external-url-failed: ${message}` });
      showErrorToast(t("settings.open_link_error") || "Failed to open link");
    }
  };

  const handleCopy = (index: number, text: string) => async () => {
    try {
      const ok = await copyToClipboard(text);
      if (ok) {
        setCopiedIndex(index);
        setTimeout(() => setCopiedIndex(null), 2000);
      }
    } catch (err) {
      captureError({ level: 'error', source: CREDITS_MODULE, message: `copy-failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  return (
    <div className="flex flex-col gap-2 mt-6 mb-8">
      <h2 className="text-sm font-bold text-[#4285F4] uppercase tracking-wider mb-2">
        {t("settings.contact") || "Contact"}
      </h2>
      {CREDIT_LINKS.map(({ label, display, url, Icon }, index) => (
        <div key={url} className="flex items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[#4285F4]/10 flex items-center justify-center shrink-0">
              <Icon className="w-6 h-6 text-[#4285F4]" />
            </div>
            <span className="text-base font-semibold text-gray-900 dark:text-white">
              {label}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopy(index, display)}
              className="text-base text-gray-900 dark:text-white hover:text-[#4285F4] hover:underline transition-colors cursor-pointer select-none"
              title={t("settings.copy") || "Copy"}
            >
              {copiedIndex === index ? (t("settings.copied") || "Copied!") : display}
            </button>
            <button
              type="button"
              onClick={handleOpen(url)}
              aria-label={t("settings.open_link") || "Open link"}
              title={t("settings.open_link") || "Open link"}
              className="p-2 rounded-full text-gray-400 hover:text-[#4285F4] hover:bg-gray-100 dark:hover:bg-[#33343a] transition-colors"
            >
              <ExternalLink className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
