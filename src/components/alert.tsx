/**
 * Every form action in this app reports failure by redirecting back to the
 * same page with `?error=...`, rather than throwing into an error boundary.
 * That keeps validation feedback on the page the user was already looking at,
 * next to the field they need to fix, and it means the flow works with
 * JavaScript disabled -- a real page load, not a client-side error toast.
 *
 * role="alert" makes a screen reader announce it as soon as it renders,
 * which matters here because it appears after a full navigation, not as a
 * live update a screen reader is already primed to notice.
 */
export function Alert({
  kind,
  children,
}: {
  readonly kind: 'error' | 'success' | 'info';
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function ErrorFromQuery({
  error,
}: {
  readonly error?: string | undefined;
}): React.JSX.Element | null {
  if (error === undefined || error === '') return null;
  return <Alert kind="error">{error}</Alert>;
}

export function SuccessFromQuery({
  success,
}: {
  readonly success?: string | undefined;
}): React.JSX.Element | null {
  if (success === undefined || success === '') return null;
  return <Alert kind="success">{success}</Alert>;
}
