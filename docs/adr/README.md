# Architecture decision records

Short notes on decisions that were not obvious, written when they were made.
Each records what was chosen, what was rejected, and what it costs.

| # | Decision |
| --- | --- |
| [0001](0001-row-level-security.md) | Postgres row-level security as the isolation backstop |
| [0002](0002-sessions-not-jwts.md) | Opaque database sessions instead of JWTs |
| [0003](0003-failed-scans-resolve-nothing.md) | A failed or partial scan never resolves an issue |
| [0004](0004-erasure-keeps-the-row.md) | GDPR erasure anonymises the user rather than deleting it |
| [0005](0005-forms-without-javascript.md) | Server-rendered forms that work without JavaScript |
