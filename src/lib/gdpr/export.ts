import { administrativeDb, withUser } from '@/lib/db/tenant';

/**
 * Assembles the personal data export for one user: an Article 15 access
 * request in GDPR terms, or simply "what do you have on me" in plain
 * language.
 *
 * Scope is deliberately the user's own footprint, not their organisations'
 * data. A member of an organisation is not the data controller for that
 * organisation's scan results -- the organisation is -- so a personal export
 * does not include the sites, scans or findings belonging to organisations
 * this person happens to be a member of. It does include the fact of that
 * membership, since that is personal data about them.
 */
export interface PersonalDataExport {
  readonly exportedAt: string;
  readonly account: {
    readonly id: string;
    readonly email: string;
    readonly name: string;
    readonly createdAt: string;
  };
  readonly memberships: ReadonlyArray<{
    readonly organisationName: string;
    readonly role: string;
    readonly memberSince: string;
  }>;
  readonly sessions: ReadonlyArray<{
    readonly createdAt: string;
    readonly lastSeenAt: string;
    readonly userAgent: string | null;
    readonly ipPrefix: string | null;
  }>;
  readonly assignedIssues: ReadonlyArray<{
    readonly title: string;
    readonly organisationName: string;
    readonly status: string;
  }>;
  readonly actionsPerformed: ReadonlyArray<{
    readonly action: string;
    readonly at: string;
  }>;
}

export async function buildPersonalDataExport(userId: string): Promise<PersonalDataExport> {
  const user = await administrativeDb.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, name: true, createdAt: true },
  });

  const memberships = await withUser(userId, (db) =>
    db.membership.findMany({
      where: { userId },
      select: { role: true, createdAt: true, organisationId: true },
    }),
  );
  const organisations = await administrativeDb.organisation.findMany({
    where: { id: { in: memberships.map((membership) => membership.organisationId) } },
    select: { id: true, name: true },
  });
  const orgNameById = new Map(organisations.map((organisation) => [organisation.id, organisation.name]));

  // Sessions and audit events are read through the owner connection: both
  // tables are outside the tenancy model (a session belongs to a person, not
  // an organisation) and this export intentionally spans every organisation
  // the person is a member of, which withOrganisation cannot do in one call.
  const sessions = await administrativeDb.session.findMany({
    where: { userId },
    select: { createdAt: true, lastSeenAt: true, userAgent: true, ipPrefix: true },
    orderBy: { createdAt: 'desc' },
  });

  const assignedIssues = await administrativeDb.issue.findMany({
    where: { assignedToUserId: userId },
    select: { title: true, status: true, organisationId: true },
  });

  const auditEvents = await administrativeDb.auditEvent.findMany({
    where: { actorUserId: userId },
    select: { action: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  return {
    exportedAt: new Date().toISOString(),
    account: {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    },
    memberships: memberships.map((membership) => ({
      organisationName: orgNameById.get(membership.organisationId) ?? 'Unknown organisation',
      role: membership.role,
      memberSince: membership.createdAt.toISOString(),
    })),
    sessions: sessions.map((session) => ({
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      userAgent: session.userAgent,
      ipPrefix: session.ipPrefix,
    })),
    assignedIssues: assignedIssues.map((issue) => ({
      title: issue.title,
      organisationName: orgNameById.get(issue.organisationId) ?? 'Unknown organisation',
      status: issue.status,
    })),
    actionsPerformed: auditEvents.map((event) => ({
      action: event.action,
      at: event.createdAt.toISOString(),
    })),
  };
}
