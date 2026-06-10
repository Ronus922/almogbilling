'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { hasPermission } from '@/lib/permissions/check';
import type { Action, ModulePermission, Role } from '@/lib/permissions/constants';

export interface ClientActor {
  id: string;
  username: string;
  email: string;
  full_name: string | null;
  role: Role;
  permissions: ModulePermission[];
}

interface AuthContextValue {
  user: ClientActor;
  signOut: () => Promise<void>;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  can: (module: string, action: Action) => boolean;
}

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  initialActor,
  children,
}: {
  initialActor: ClientActor;
  children: ReactNode;
}) {
  const value = useMemo<AuthContextValue>(() => {
    const isSuperAdmin = initialActor.role === 'super_admin';
    const isAdmin = isSuperAdmin || initialActor.role === 'admin';
    return {
      user: initialActor,
      isAdmin,
      isSuperAdmin,
      can: (module, action) =>
        hasPermission(initialActor.role, initialActor.permissions, module, action),
      signOut: async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login';
      },
    };
  }, [initialActor]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used within <AuthProvider>');
  return v;
}

export function usePermissions(): {
  role: Role;
  permissions: ModulePermission[];
  can: (module: string, action: Action) => boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
} {
  const { user, can, isAdmin, isSuperAdmin } = useAuth();
  return { role: user.role, permissions: user.permissions, can, isAdmin, isSuperAdmin };
}
