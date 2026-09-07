import { randomUUID } from 'node:crypto';

import { administrativeDb } from '@/lib/db/tenant';
import { Role, VerificationMethod } from '@prisma/client';

/**
 * Fixtures are created through the owner connection, which is not subject to
 * row-level security. That matters: the setup has to be able to create data in
 * two organisations at once, which is precisely what the application is never
 * allowed to do.
 */

export interface SeededOrganisation {
  readonly organisationId: string;
  readonly ownerUserId: string;
  readonly siteId: string;
  readonly slug: string;
}

export async function resetDatabase(): Promise<void> {
  // Order matters less than it looks: CASCADE handles the graph. Kept explicit
  // so an added table that is not truncated shows up as a test failure rather
  // than as cross-test pollution.
  await administrativeDb.$executeRawUnsafe(`
    TRUNCATE TABLE
      issue_events, findings, issues, scan_runs, sites,
      invitations, memberships, audit_events, organisations, sessions, users
    RESTART IDENTITY CASCADE
  `);
}

export async function seedOrganisation(label: string): Promise<SeededOrganisation> {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;

  const user = await administrativeDb.user.create({
    data: {
      email: `owner@${slug}.test`,
      name: `${label} owner`,
      passwordHash: 'not-a-real-hash',
    },
  });

  const organisation = await administrativeDb.organisation.create({
    data: {
      name: `${label} Ltd`,
      slug,
      memberships: { create: { userId: user.id, role: Role.owner } },
    },
  });

  const site = await administrativeDb.site.create({
    data: {
      organisationId: organisation.id,
      label: `${label} website`,
      origin: `https://${slug}.example.com`,
      verificationMethod: VerificationMethod.dns_txt,
      verificationToken: randomUUID(),
      verifiedAt: new Date(),
    },
  });

  return {
    organisationId: organisation.id,
    ownerUserId: user.id,
    siteId: site.id,
    slug,
  };
}
