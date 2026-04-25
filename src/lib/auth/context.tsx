'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import type { SessionUser } from './session';

interface AuthContextValue {
  user: SessionUser;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  initialUser,
  children,
}: {
  initialUser: SessionUser;
  children: ReactNode;
}) {
  const [user, setUser] = useState<SessionUser>(initialUser);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    // Hard navigation to clear all client-side state and re-trigger middleware.
    window.location.href = '/login';
  }

  // Suppress unused-state warning by referencing it.
  void setUser;

  return <Ctx.Provider value={{ user, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('useAuth must be used within <AuthProvider>');
  }
  return v;
}
