import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  __unsafeRestrictedClientForTests as unscoped,
  administrativeDb,
  assertTenantIsolationActive,
  disconnect,
  withOrganisation,
  withUser,
} from '@/lib/db/tenant';
import { resetDatabase, seedOrganisation, type SeededOrganisation } from '../helpers/fixtures';

/**
 * The isolation suite.
 *
 * Multi-tenancy is where SaaS products leak customer data, so it is not enough
 * for the application guard to be correct today -- the database has to hold
 * when the guard is wrong tomorrow. These tests are written from that
 * assumption: several of them deliberately bypass withOrganisation() and issue
 * exactly the unscoped query a careless change would introduce, then assert
 * that the database returns nothing anyway.
 *
 * A failure here is a data breach, not a bug.
 */
describe('tenant isolation', () => {
  let alpha: SeededOrganisation;
  let beta: SeededOrganisation;

  beforeAll(async () => {
    await resetDatabase();
    alpha = await seedOrganisation('alpha');
    beta = await seedOrganisation('beta');
  });

  afterAll(async () => {
    await disconnect();
  });

  it('confirms the isolation preconditions actually hold in this database', async () => {
    // If this fails, every other assertion in the file is meaningless: the app
    // would be connecting as a role that bypasses row-level security.
    await expect(assertTenantIsolationActive()).resolves.toBeUndefined();
  });

  describe('through the application guard', () => {
    it('returns only the scoped organisation\'s sites', async () => {
      const sites = await withOrganisation(
        { userId: alpha.ownerUserId, organisationId: alpha.organisationId },
        (db) => db.site.findMany(),
      );

      expect(sites).toHaveLength(1);
      expect(sites[0]!.id).toBe(alpha.siteId);
    });

    it('cannot read another organisation\'s site even by its exact id', async () => {
      const site = await withOrganisation(
        { userId: alpha.ownerUserId, organisationId: alpha.organisationId },
        (db) => db.site.findUnique({ where: { id: beta.siteId } }),
      );

      expect(site).toBeNull();
    });

    it('cannot update another organisation\'s rows', async () => {
      const result = await withOrganisation(
        { userId: alpha.ownerUserId, organisationId: alpha.organisationId },
        (db) => db.site.updateMany({ where: { id: beta.siteId }, data: { label: 'taken over' } }),
      );

      expect(result.count).toBe(0);

      const untouched = await administrativeDb.site.findUniqueOrThrow({
        where: { id: beta.siteId },
      });
      expect(untouched.label).toBe('beta website');
    });

    it('cannot delete another organisation\'s rows', async () => {
      const result = await withOrganisation(
        { userId: alpha.ownerUserId, organisationId: alpha.organisationId },
        (db) => db.site.deleteMany({ where: { id: beta.siteId } }),
      );

      expect(result.count).toBe(0);
      await expect(
        administrativeDb.site.findUniqueOrThrow({ where: { id: beta.siteId } }),
      ).resolves.toBeDefined();
    });

    // WITH CHECK, not USING: this is the policy half that stops a tenant
    // writing rows into someone else's organisation.
    it('cannot insert a row belonging to another organisation', async () => {
      await expect(
        withOrganisation(
          { userId: alpha.ownerUserId, organisationId: alpha.organisationId },
          (db) =>
            db.site.create({
              data: {
                organisationId: beta.organisationId,
                label: 'planted',
                origin: 'https://planted.example.com',
                verificationMethod: 'dns_txt',
                verificationToken: 'x',
              },
            }),
        ),
      ).rejects.toThrow();

      const betaSites = await administrativeDb.site.count({
        where: { organisationId: beta.organisationId },
      });
      expect(betaSites).toBe(1);
    });

    it('does not leak context from one scoped transaction into the next', async () => {
      await withOrganisation(
        { userId: alpha.ownerUserId, organisationId: alpha.organisationId },
        (db) => db.site.findMany(),
      );

      const betaSites = await withOrganisation(
        { userId: beta.ownerUserId, organisationId: beta.organisationId },
        (db) => db.site.findMany(),
      );

      expect(betaSites).toHaveLength(1);
      expect(betaSites[0]!.id).toBe(beta.siteId);
    });

    it('rejects a non-UUID organisation id before it reaches a policy expression', async () => {
      await expect(
        withOrganisation(
          { userId: alpha.ownerUserId, organisationId: "' OR '1'='1" },
          (db) => db.site.findMany(),
        ),
      ).rejects.toThrow(TypeError);
    });
  });

  /**
   * The guard is bypassed on purpose below. These queries are what a mistake
   * looks like -- a findMany with no organisation filter, run outside
   * withOrganisation(). The application should never issue them; the point is
   * that the database refuses them regardless.
   */
  describe('with the application guard deliberately bypassed', () => {
    it('returns no rows at all when no organisation context is set', async () => {
      const sites = await unscoped.site.findMany();
      expect(sites).toEqual([]);
    });

    it('returns nothing for a findMany that forgot its organisation filter', async () => {
      const issues = await unscoped.issue.findMany();
      const runs = await unscoped.scanRun.findMany();
      const findings = await unscoped.finding.findMany();

      expect(issues).toEqual([]);
      expect(runs).toEqual([]);
      expect(findings).toEqual([]);
    });

    it('cannot reach a known row by primary key', async () => {
      // The id is correct and the row exists. Without context, it is invisible.
      const site = await unscoped.site.findUnique({ where: { id: alpha.siteId } });
      expect(site).toBeNull();

      await expect(
        administrativeDb.site.findUniqueOrThrow({ where: { id: alpha.siteId } }),
      ).resolves.toBeDefined();
    });

    it('cannot count across organisations', async () => {
      expect(await unscoped.site.count()).toBe(0);
      expect(await unscoped.organisation.count()).toBe(0);
      // Both organisations plus their sites do exist.
      expect(await administrativeDb.organisation.count()).toBe(2);
      expect(await administrativeDb.site.count()).toBe(2);
    });
  });

  describe('organisation selection', () => {
    it('lets a user see only their own memberships before an organisation is chosen', async () => {
      const memberships = await withUser(alpha.ownerUserId, (db) =>
        db.membership.findMany({ select: { organisationId: true, role: true } }),
      );

      expect(memberships).toHaveLength(1);
      expect(memberships[0]!.organisationId).toBe(alpha.organisationId);
    });

    it('shows a second membership once the user is added to another organisation', async () => {
      await administrativeDb.membership.create({
        data: {
          organisationId: beta.organisationId,
          userId: alpha.ownerUserId,
          role: 'viewer',
        },
      });

      const memberships = await withUser(alpha.ownerUserId, (db) => db.membership.findMany());
      expect(memberships.map((m) => m.organisationId).sort()).toEqual(
        [alpha.organisationId, beta.organisationId].sort(),
      );
    });

    // Membership is what authorises selection; the policy does not check it,
    // so this is the application's responsibility and is covered separately in
    // the authorisation tests. Recorded here so the boundary is explicit.
    it('scopes data correctly for each organisation the user belongs to', async () => {
      const inBeta = await withOrganisation(
        { userId: alpha.ownerUserId, organisationId: beta.organisationId },
        (db) => db.site.findMany(),
      );

      expect(inBeta).toHaveLength(1);
      expect(inBeta[0]!.id).toBe(beta.siteId);
    });
  });
});
