import { create } from "zustand";
import type { UserProfile } from "../types";

interface AuthState {
  isLoggedIn: boolean;
  accessToken: string | null;
  userProfile: UserProfile | null;
  setIsLoggedIn: (isLoggedIn: boolean) => void;
  setAccessToken: (token: string | null) => void;
  setUserProfile: (profile: UserProfile | null) => void;
}

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
