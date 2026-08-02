// Single source of truth for localStorage keys shared across modules.
export const USER_EMAIL_KEY = 'drplay_current_user_email';
export const DEFAULT_USER_EMAIL = 'default';
export const LANGUAGE_KEY = 'drplay_language';

export function getCurrentUserEmail(): string {
  try {
    return localStorage.getItem(USER_EMAIL_KEY) || DEFAULT_USER_EMAIL;
  } catch {
    return DEFAULT_USER_EMAIL;
  }
}
