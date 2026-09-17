import { NextResponse } from 'next/server';

import { getCurrentSession } from '@/lib/auth/current-session';
import { buildPersonalDataExport } from '@/lib/gdpr/export';

/**
 * A GET route rather than a server action: a file download needs a
 * Content-Disposition response, which a server action -- designed to return
 * data to the calling component, not to the browser's navigation -- cannot
 * produce directly.
 *
 * Authentication is checked directly with getCurrentSession() rather than the
 * requireSession() helper used by pages: that helper calls next/navigation's
 * redirect(), which assumes a Server Component or Server Action render
 * context and is not the supported way to redirect from a Route Handler.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getCurrentSession();
  if (session === null) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const data = await buildPersonalDataExport(session.user.id);

  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="bailey-account-data.json"',
      // The export contains the requester's own data by construction, but
      // nothing about a personal-data export should ever be cached upstream.
      'Cache-Control': 'no-store',
    },
  });
}
