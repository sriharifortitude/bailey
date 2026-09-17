# 0005. Server-rendered forms that work without JavaScript

**Status:** accepted

## Decision

Every mutation is a real `<form>` posting to a Next.js server action.
Validation failure redirects back to the same page with `?error=`. No client
components, no state library, no fetch calls from the browser.

## Reasoning

Three reasons, in order of weight.

**Accessibility.** A native form submission and a full navigation is the
interaction pattern assistive technology handles best, and `role="alert"` on
the redirected-in message is announced without a live region needing to
already exist on the page.

**Verifiability.** The signup flow was driven end to end with curl,
replicating a browser's multipart POST, which is only possible because
nothing depends on client script.

**Scope.** A client-side form library would be the largest single dependency
in the project, for a product whose complexity is in the data model rather
than the UI.

The origin check Next.js applies to server actions, plus `SameSite=Lax`
cookies, is the CSRF control; no separate token is needed.

## Costs

Every validation error is a round trip. Every message is a URL parameter, so
messages are short. A form with rich client-side behaviour would need a
different approach; none does yet.
