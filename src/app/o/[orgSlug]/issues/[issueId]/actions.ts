'use server';

import { redirect } from 'next/navigation';
import { IssueStatus } from '@prisma/client';

import { requireMembership } from '@/lib/auth/current-session';
import { withOrganisation } from '@/lib/db/tenant';
import { assertCan } from '@/lib/policy/rbac';
import { formString } from '@/lib/forms';

function back(orgSlug: string, issueId: string, message: string, kind: 'error' | 'success' = 'error'): never {
  const param = kind === 'error' ? 'error' : 'success';
  redirect(`/o/${orgSlug}/issues/${issueId}?${param}=${encodeURIComponent(message)}`);
}

export async function acceptIssueAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const issueId = formString(formData, 'issueId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'issue:triage');

  const reason = formString(formData, 'reason').trim();
  const untilRaw = formString(formData, 'until').trim();
  if (reason === '') back(orgSlug, issueId, 'Explain why this risk is being accepted.');

  const acceptedUntil = untilRaw === '' ? null : new Date(`${untilRaw}T00:00:00.000Z`);
  if (acceptedUntil !== null && Number.isNaN(acceptedUntil.getTime())) {
    back(orgSlug, issueId, 'That date could not be understood.');
  }

  const issue = await withOrganisation(context, (db) =>
    db.issue.findUniqueOrThrow({ where: { id: issueId }, select: { status: true } }),
  );

  await withOrganisation(context, async (db) => {
    await db.issue.update({
      where: { id: issueId },
      data: {
        status: IssueStatus.accepted,
        acceptedReason: reason,
        acceptedUntil,
      },
    });
    await db.issueEvent.create({
      data: {
        organisationId: context.organisationId,
        issueId,
        actorUserId: context.userId,
        type: 'accepted',
        fromStatus: issue.status,
        toStatus: IssueStatus.accepted,
        note: reason,
      },
    });
  });

  back(orgSlug, issueId, 'Risk accepted.', 'success');
}

export async function reopenIssueAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const issueId = formString(formData, 'issueId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'issue:triage');

  const issue = await withOrganisation(context, (db) =>
    db.issue.findUniqueOrThrow({ where: { id: issueId }, select: { status: true } }),
  );

  await withOrganisation(context, async (db) => {
    await db.issue.update({
      where: { id: issueId },
      data: { status: IssueStatus.open, acceptedReason: null, acceptedUntil: null },
    });
    await db.issueEvent.create({
      data: {
        organisationId: context.organisationId,
        issueId,
        actorUserId: context.userId,
        type: 'reopened',
        fromStatus: issue.status,
        toStatus: IssueStatus.open,
      },
    });
  });

  back(orgSlug, issueId, 'Issue reopened.', 'success');
}

export async function assignIssueAction(formData: FormData): Promise<void> {
  const orgSlug = formString(formData, 'orgSlug');
  const issueId = formString(formData, 'issueId');
  const { role, context } = await requireMembership(orgSlug);
  assertCan(role, 'issue:assign');

  const raw = formString(formData, 'assigneeId');
  const assigneeId = raw === '' ? null : raw;

  if (assigneeId !== null) {
    const membership = await withOrganisation(context, (db) =>
      db.membership.findUnique({
        where: { organisationId_userId: { organisationId: context.organisationId, userId: assigneeId } },
      }),
    );
    if (membership === null) back(orgSlug, issueId, 'That person is not a member of this organisation.');
  }

  await withOrganisation(context, (db) =>
    db.issue.update({ where: { id: issueId }, data: { assignedToUserId: assigneeId } }),
  );

  back(orgSlug, issueId, 'Assignment updated.', 'success');
}
