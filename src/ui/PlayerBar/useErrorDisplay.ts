import { useState, useEffect, useRef, useCallback } from 'react';
import { PlayerAction, toastTypes, TOAST_DURATION } from './types';

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
  const toastIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastDismissRef = useRef<(() => void) | null>(null);

  const clearToastTimer = () => {
    if (toastIntervalRef.current) {
      clearInterval(toastIntervalRef.current);
      toastIntervalRef.current = null;
    }
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
  };

  const startToastTimer = (dismiss: () => void) => {
    clearToastTimer();
    toastTimeoutRef.current = setTimeout(dismiss, TOAST_DURATION * 1000);
  };

  const dismissToast = useCallback(() => {
    clearToastTimer();
    setToastSlideIn(false);
    setTimeout(() => dispatch({ type: 'CLEAR_ERROR' }), 300);
  }, [dispatch]);

  useEffect(() => {
    if (errorInfo && toastTypes.includes(errorInfo.type)) {
      setTimeout(() => setToastSlideIn(true), 10);
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
            clearToastTimer();
            dismissToast();
          }
        } else {
          clearToastTimer();
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        clearToastTimer();
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
