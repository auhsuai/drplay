import { create } from "zustand";
import type { UserProfile } from "../types";

interface AuthState {
  /** Whether a session is currently active (token present and not logged out). */
  isLoggedIn: boolean;
  /** The current Google access token (null when signed out). */
  accessToken: string | null;
  /** The signed-in user's Google profile, or null before the profile fetch lands. */
  userProfile: UserProfile | null;
  /**
   * Mark the session active/inactive. Login and logout flows call this
   * alongside the token writes so UI reacts in the same render.
   * @param isLoggedIn True when a session starts, false on logout.
   */
  setIsLoggedIn: (isLoggedIn: boolean) => void;
  /** Swap in a new access token (login, refresh, or logout → null). */
  setAccessToken: (token: string | null) => void;
  /** Store (or clear, on logout) the fetched Google profile. */
  setUserProfile: (profile: UserProfile | null) => void;
}

/**
 * Global auth state: login flag, the current access token, and the fetched
 * Google profile. Kept separate from the token lifecycle in apiClient/useAuth
 * so any component can render login-dependent UI from one source of truth.
 */
export const useAuthStore = create<AuthState>((set) => ({
  isLoggedIn: false,
  accessToken: null,
  userProfile: null,
  setIsLoggedIn: (isLoggedIn) => {
    set({ isLoggedIn });
  },
  setAccessToken: (accessToken) => {
    set({ accessToken });
  },
  setUserProfile: (userProfile) => {
    set({ userProfile });
  },
}));
