# 0004. GDPR erasure anonymises the user rather than deleting it

**Status:** accepted

## Decision

Erasure overwrites name, email and password hash, sets `deletedAt`, revokes
every session and removes every membership. The `users` row remains.
Erasure is blocked while the user is the sole owner of an organisation.

## Reasoning

`issues.assignedToUserId`, `audit_events.actorUserId` and
`issue_events.actorUserId` reference the user. Deleting the row would cascade
or null those out, and "who accepted this risk, and when" would vanish from an
organisation's record on the request of the person who did it. The
organisation's accountability trail is the organisation's data, not the
former member's; erasure removes what identifies the person and nothing else.

Sole-owner blocking: erasing them would either delete an organisation as a
side effect of a personal request, or leave it ownerless. Both are wrong
defaults. The person resolves ownership first.

## Costs

A row per erased user, carrying a placeholder email. Negligible, and it is
what keeps foreign keys resolving.
