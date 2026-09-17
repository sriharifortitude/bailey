import type { ReactNode } from 'react';
import type { Role } from '@prisma/client';

import { Topbar } from '@/components/topbar';

/**
 * A plain component rather than a Next.js layout. A layout cannot see which
 * of its own children is active without reaching for client-side routing
 * hooks, and every page already resolves its own membership (see the note in
 * requireMembership's callers), so each page simply says which nav item is
 * current when it renders this.
 */
export function AppShell({
  orgSlug,
  orgName,
  role,
  active,
  children,
}: {
  readonly orgSlug: string;
  readonly orgName: string;
  readonly role: Role;
  readonly active: 'dashboard' | 'members' | 'settings' | 'account' | 'none';
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <>
      <Topbar orgSlug={orgSlug} orgName={orgName} role={role} active={active} />
      <main id="main" className="shell">
        {children}
      </main>
    </>
  );
}
