# Security policy

## What this system sends to sites

Bailey scans only sites whose ownership has been proven by DNS TXT record or
a well-known file, re-checked periodically. Scans run parapet-scan as a
subprocess; see [its security policy](https://github.com/sriharifortitude/parapet-scan/blob/main/SECURITY.md)
for the full request inventory. Nothing here sends a write, fuzzes, or
exploits. Targets are screened against reserved address ranges at
registration and again before every scan, so the platform cannot be pointed
at a private network.

## Controls that matter

- Tenant isolation is enforced by Postgres row-level security and verified at
  boot; see [ADR 0001](docs/adr/0001-row-level-security.md).
- Passwords: Argon2id at OWASP parameters, no composition rules. The
  no-such-user path still does the hash work so response time does not
  disclose whether an address is registered.
- Sessions: opaque, hashed at rest, rotated on privilege change, absolute and
  idle expiry.
- Every server action re-checks membership and permission regardless of what
  the UI showed.
- Form fields are read as strings only; a tampered file field is rejected.
- Scanner output is schema-validated; a shape mismatch fails loudly rather
  than silently producing zero findings.
- Evidence rendered in the UI is text content only. React escapes it; nothing
  writes raw HTML.

## Known gaps

- No rate limiting on authentication endpoints. Put one at the proxy before
  this faces the internet.
- No email delivery, so invitation links are shown on screen to the inviter.
- DNS rebinding between address screening and the scanner's request is not
  defended against; see parapet-scan ADR 0003.

## Reporting

Open a [security advisory](https://github.com/sriharifortitude/bailey/security/advisories/new)
rather than a public issue. Most useful to hear about: a way to read another
organisation's rows, to bypass ownership verification, or to reach a private
address through a scan.
