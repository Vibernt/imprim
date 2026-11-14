# Security policy

Imprim handles sign-in, sessions, signing keys and agent grants, so we treat every report seriously.

**Do not open a public issue for a vulnerability.** Report it privately through GitHub:
**Security → Report a vulnerability** on this repository. Include the affected route or module, the commit, what
you expected, what happened, and a minimal reproduction. Never include real tokens, email links, client secrets or
provider credentials.

We aim to acknowledge a report within three working days. Fixes land on `main`, the only supported version, and the
advisory credits you unless you ask us not to.

The threat model, controls and what has not yet been verified against Cloudflare are in
[docs/SECURITY.md](docs/SECURITY.md).
