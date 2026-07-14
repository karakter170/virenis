# Self-service identity

Virenis supports verified, password-based browser accounts when
`APP_IDENTITY_ENABLED=1`. Each registered account receives one independent
private workspace. This feature deliberately does not implement workspace
invitations, shared memberships, or cross-user workspace switching.

## User lifecycle

1. `POST /api/auth/register` creates an unverified account and sends a
   short-lived email verification link.
2. `POST /api/auth/verify-email` consumes that link once.
3. `POST /api/auth/login` verifies the password and creates a server-side
   browser session. The browser receives only an HttpOnly, SameSite=Lax cookie;
   production cookies are also Secure and use the `__Host-` prefix.
4. `POST /api/auth/forgot-password` returns a non-enumerating response and
   sends a one-time reset link when the account is eligible.
5. `POST /api/auth/reset-password` replaces the hash and revokes every browser
   session. Changing a password from account settings keeps the current session
   and revokes the others.

Passwords accept Unicode and whitespace without composition rules, are limited
to 128 characters to bound hashing work, and require at least 15 characters
while MFA is unavailable. Passwords are stored with unique salts and scrypt
parameters embedded in the encoded hash. Production enforces N=131072, r=8,
p=1 or stronger; lower settings are accepted only outside production for fast
tests. Login uses a dummy hash for unknown accounts, constant-time digest
comparison, per-account lockout, and a separate bounded IP rate limiter.

## Account controls

- `GET /api/account/sessions` lists active browser sessions.
- `DELETE /api/account/sessions/:session_id` revokes one session.
- `POST /api/account/sessions/revoke-others` keeps only the current session.
- `POST /api/account/password` verifies the current password before changing it.
- `PATCH /api/account/profile` updates the public display name without changing
  the stable user or workspace identifiers.
- `GET /api/account/export` returns the account's profile and scoped product
  data without password hashes, session-token hashes, OAuth credentials, or
  encrypted secrets.
- `DELETE /api/account` requires the current password and the exact confirmation
  `DELETE`. It removes operational workspace data, runtime agents/documents,
  local document files, and MCP credentials. De-identified append-only integrity
  receipts may remain for security, provenance, and abuse prevention.

## Administration

Addresses in `APP_AUTH_ADMIN_EMAILS` receive the administrator role when they
first register. Administrators can list registered users, verify an address,
assign `admin`, `user`, or `viewer`, suspend/reactivate access, and revoke all
browser sessions. An administrator cannot suspend or demote their own current
account, and the final active registered administrator cannot be removed or
demoted.

Static Basic and bearer identities remain supported for operators and API
clients. They do not become browser accounts and therefore do not expose
password, session, export, or deletion controls in the user interface.

## Production requirements

Configure the identity and SMTP variables in `deploy/env/web.env.example`, use
the real HTTPS `APP_PUBLIC_ORIGIN`, and register at least one real administrator
email before opening registration. Production startup fails closed when SMTP is
missing, capture-mode delivery is selected, SMTP certificate verification is
disabled, a placeholder administrator is configured, or optional Basic Auth is
partial or weak.

Run the focused checks with:

```bash
npm test -- --run tests/identity.test.js tests/identityUi.test.js
DATABASE_URL="$DATABASE_URL" npm run test:identity:postgres
```
