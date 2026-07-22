import { useTranslation } from "react-i18next";

interface RateLimitModalProps {
  onClose: () => void;
  onGoHome: () => void;
}

export function RateLimitModal({ onClose, onGoHome }: RateLimitModalProps) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center backdrop-blur-md bg-black/30 dark:bg-black/50 transition-all duration-300">
      <div className="bg-white dark:bg-[#1f2024] p-6 sm:p-8 rounded-2xl shadow-2xl max-w-sm w-full mx-4 border border-gray-100 dark:border-gray-800 animate-in fade-in zoom-in-95">
        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4 text-center">
          {t('rate_limit_title', 'Nghỉ ngơi chút nhé!')}
        </h3>
        <p className="text-gray-600 dark:text-gray-300 text-center mb-6 leading-relaxed">
          {t('rate_limit_greeting', 'Hôm nay bạn đã hoạt động nhiều rồi, hãy nghỉ ngơi 1 chút nhé!')}
        </p>
        <div className="flex justify-center gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 font-medium transition-colors">
            {t('cancel', 'Hủy')}
          </button>
          <button onClick={() => { onClose(); onGoHome(); }} className="px-5 py-2.5 rounded-full text-white bg-[#4285F4] hover:bg-blue-600 font-medium transition-colors shadow-md shadow-blue-500/20">
            {t('ok', 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
