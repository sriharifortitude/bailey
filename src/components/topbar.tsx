import Link from 'next/link';
import type { Role } from '@prisma/client';

import { can } from '@/lib/policy/rbac';
import { logoutAction } from '@/app/logout/actions';

/**
 * The nav is a real <nav> with aria-current marking the active section, and
 * sign-out is a <form> POST rather than a link -- a GET request that logs
 * someone out is a CSRF target and, separately, not idempotent, which a link
 * implies it is.
 */
export function Topbar({
  orgSlug,
  orgName,
  role,
  active,
}: {
  readonly orgSlug: string;
  readonly orgName: string;
  readonly role: Role;
  readonly active: 'dashboard' | 'members' | 'settings' | 'account' | 'none';
}): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="shell topbar-inner">
        <Link href={`/o/${orgSlug}`} className="topbar-brand">
          Bailey
        </Link>
        <span style={{ color: 'var(--fg-muted)', fontSize: '0.9rem' }}>{orgName}</span>

        <nav className="topbar-nav" aria-label="Primary">
          <Link href={`/o/${orgSlug}`} aria-current={active === 'dashboard' ? 'page' : undefined}>
            Sites
          </Link>
          {can(role, 'member:read') && (
            <Link href={`/o/${orgSlug}/members`} aria-current={active === 'members' ? 'page' : undefined}>
              Team
            </Link>
          )}
          <Link
            href={`/o/${orgSlug}/settings`}
            aria-current={active === 'settings' ? 'page' : undefined}
          >
            Settings
          </Link>
          <Link href="/account" aria-current={active === 'account' ? 'page' : undefined}>
            Account
          </Link>
          <Link href="/select-org">Switch org</Link>
          <form action={logoutAction}>
            <button type="submit" className="btn-secondary btn-sm">
              Sign out
            </button>
          </form>
        </nav>
      </div>
    </header>
  );
}
