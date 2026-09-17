import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'Bailey',
  description: 'Continuous web security posture monitoring.',
};

/**
 * The root layout is deliberately thin: no navigation, no session read. Both
 * the marketing/auth pages and the authenticated app render their own chrome,
 * because they need different things in it (a sign-in link versus an
 * organisation switcher) and a shared nav here would mean every route paid
 * for a session lookup it might not need.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
