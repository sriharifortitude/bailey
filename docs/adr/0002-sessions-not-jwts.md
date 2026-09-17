# 0002. Opaque database sessions instead of JWTs

**Status:** accepted

## Decision

A session is 32 random bytes in an httpOnly cookie. Only its SHA-256 is
stored. Validity is a database lookup with an absolute lifetime and an idle
timeout. Rotation happens on privilege change; password change revokes every
other session.

## Reasoning

A JWT is valuable when the verifier cannot reach the issuer. Here every
request already reaches the database, so the property JWTs buy -- stateless
verification -- is not needed, and the property they cost -- revocation
requires a denylist, which is state -- is exactly what a security product
needs most. "Sign out everywhere" and "this account was erased" have to take
effect on the next request, not at token expiry.

SHA-256 rather than argon2 for the stored hash: the input already has 256
bits of entropy, so there is no dictionary to slow down, and this runs on
every request. A dump of the table yields nothing usable.

## Costs

One indexed lookup per request. `lastSeenAt` is written at most every five
minutes so an active session is not a write per request.
