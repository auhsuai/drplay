import { useState, useEffect, useRef, useCallback } from 'react';
import { PlayerAction, toastTypes, TOAST_DURATION, TOAST_SLIDE_IN_MS, TOAST_DISMISS_DELAY_MS } from './types';

export interface ErrorDisplayAPI {
  toastSlideIn: boolean;
  dismissToast: () => void;
  toastDismissRef: React.MutableRefObject<(() => void) | null>;
}

interface UseErrorDisplayParams {
  errorInfo: { type: string; text: string } | null;
  dispatch: React.Dispatch<PlayerAction>;
  rateLimitUntilRef: React.MutableRefObject<number>;
}

export function useErrorDisplay(params: UseErrorDisplayParams): ErrorDisplayAPI {
  const { errorInfo, dispatch, rateLimitUntilRef } = params;

  const [toastSlideIn, setToastSlideIn] = useState(false);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideInTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastDismissRef = useRef<(() => void) | null>(null);

  const clearAutoDismissTimer = () => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
  };

  const clearToastTimers = () => {
    clearAutoDismissTimer();
    if (slideInTimeoutRef.current) {
      clearTimeout(slideInTimeoutRef.current);
      slideInTimeoutRef.current = null;
    }
    if (clearErrorTimeoutRef.current) {
      clearTimeout(clearErrorTimeoutRef.current);
      clearErrorTimeoutRef.current = null;
    }
  };

  const startToastTimer = (dismiss: () => void) => {
    clearAutoDismissTimer();
    toastTimeoutRef.current = setTimeout(dismiss, TOAST_DURATION * 1000);
  };

  const dismissToast = useCallback(() => {
    clearToastTimers();
    setToastSlideIn(false);
    clearErrorTimeoutRef.current = setTimeout(() => {
      clearErrorTimeoutRef.current = null;
      dispatch({ type: 'CLEAR_ERROR' });
    }, TOAST_DISMISS_DELAY_MS);
  }, [dispatch]);

  useEffect(() => {
    if (errorInfo && toastTypes.includes(errorInfo.type)) {
      slideInTimeoutRef.current = setTimeout(() => {
        slideInTimeoutRef.current = null;
        setToastSlideIn(true);
      }, TOAST_SLIDE_IN_MS);
      toastDismissRef.current = dismissToast;

      if (document.visibilityState === 'visible') {
        startToastTimer(dismissToast);
      }

      const onVisibility = () => {
        if (document.visibilityState === 'visible') {
          const stillRelevant = (
            errorInfo.type === 'drive_quota_exceeded' ||
            (errorInfo.type === 'rate_limited' && Date.now() < rateLimitUntilRef.current) ||
            (errorInfo.type !== 'rate_limited' && errorInfo.type !== 'drive_quota_exceeded' && !navigator.onLine)
          );
          if (stillRelevant) {
            startToastTimer(dismissToast);
          } else {
            dismissToast();
          }
        } else {
          clearAutoDismissTimer();
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        clearToastTimers();
        document.removeEventListener('visibilitychange', onVisibility);
        toastDismissRef.current = null;
      };
    }
    toastDismissRef.current = null;
  }, [errorInfo?.type, errorInfo?.text]);

  return {
    toastSlideIn,
    dismissToast,
    toastDismissRef,
  };
}
