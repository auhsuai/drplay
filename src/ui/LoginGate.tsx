import { LoginScreen } from "./Login/LoginScreen";

interface LoginGateProps {
  isLoggedIn: boolean;
  isAuthHydrated: boolean;
  onLogin: (tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }) => void;
}

export function LoginGate({
  isLoggedIn,
  isAuthHydrated,
  onLogin,
}: LoginGateProps) {
  // P2-04-9: isLoggedIn=false is ambiguous before useAuth's hydrate effect has
  // run — a cold start with a saved session would paint this overlay for at
  // least one frame. Stay hidden until hydration has settled.
  if (!isAuthHydrated || isLoggedIn) return null;
  return <LoginScreen onLogin={onLogin} />;
}
