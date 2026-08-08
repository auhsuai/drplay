import { LoginScreen } from "./Login/LoginScreen";

interface LoginGateProps {
  isLoggedIn: boolean;
  onLogin: (tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }) => void;
}

export function LoginGate({ isLoggedIn, onLogin }: LoginGateProps) {
  if (isLoggedIn) return null;
  return <LoginScreen onLogin={onLogin} />;
}
