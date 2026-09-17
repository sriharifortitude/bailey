import type { IssueStatus, Role, Severity } from '@prisma/client';

/**
 * Severity, status and role each get their own colour vocabulary, defined
 * once here rather than re-derived at each call site -- the failure mode
 * being guarded against is one page rendering "high" in orange and another in
 * red because the mapping was copied by hand.
 */
export function SeverityBadge({ severity }: { readonly severity: Severity }): React.JSX.Element {
  return <span className={`badge badge-${severity}`}>{severity}</span>;
}

const STATUS_LABEL: Readonly<Record<IssueStatus, string>> = {
  open: 'Open',
  accepted: 'Accepted',
  resolved: 'Resolved',
  regressed: 'Regressed',
};

export function StatusBadge({ status }: { readonly status: IssueStatus }): React.JSX.Element {
  return <span className={`badge badge-status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function RoleBadge({ role }: { readonly role: Role }): React.JSX.Element {
  return <span className="badge badge-role">{role}</span>;
}
