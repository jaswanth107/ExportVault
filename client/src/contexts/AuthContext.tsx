import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { clearToken, getToken, setToken } from '../api/client';
import { fetchMe, login as loginRequest, register as registerRequest } from '../api/auth';
import type { User } from '../types';

interface AuthContextValue {
  user: User | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');

  useEffect(() => {
    let cancelled = false;

    async function restore() {
      if (!getToken()) {
        if (!cancelled) setStatus('anonymous');
        return;
      }
      try {
        const result = await fetchMe();
        if (cancelled) return;
        setUser(result.user);
        setStatus('authenticated');
      } catch (error) {
        // An expired or invalid token is an expected outcome, but it is still
        // logged so a genuine API outage is not mistaken for a logout.
        console.warn('Could not restore the existing session', error);
        clearToken();
        if (!cancelled) {
          setUser(null);
          setStatus('anonymous');
        }
      }
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await loginRequest({ email, password });
    setToken(result.token);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      await registerRequest({ name, email, password });
      await login(email, password);
    },
    [login],
  );

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo(
    () => ({ user, status, login, register, logout }),
    [user, status, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
