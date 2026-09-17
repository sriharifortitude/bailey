/**
 * The one place the session cookie's name and attributes are defined.
 *
 * httpOnly so client-side script cannot read the token even via an XSS bug.
 * sameSite=lax rather than strict: strict would drop the cookie on the first
 * request after a user clicks an emailed invitation link, which is exactly
 * the flow this product depends on. lax still blocks the cookie being sent on
 * a cross-site POST, which is the case that matters for CSRF.
 */
export const SESSION_COOKIE = 'bailey_session';

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env['NODE_ENV'] === 'production',
  sameSite: 'lax' as const,
  path: '/',
};
