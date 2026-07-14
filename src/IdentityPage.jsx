import {
  AlertCircle,
  ArrowLeft,
  Check,
  Download,
  KeyRound,
  LoaderCircle,
  LogOut,
  Mail,
  MonitorSmartphone,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const DEFAULT_CONFIG = {
  self_service_enabled: false,
  registration_enabled: false,
  email_verification_required: false,
  password_min_characters: 15
};

export function IdentityPage({ mode = "login", onNavigate, onAuthenticated, onHome }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({ display_name: "", email: "", password: "", confirm_password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [notice, setNotice] = useState("");
  const [linkToken] = useState(() => identityLinkToken());
  const verificationStarted = useRef(false);

  useEffect(() => {
    identityRequest("/api/auth/config")
      .then(setConfig)
      .catch((requestError) => { setError(requestError.message); setErrorCode(requestError.code || ""); });
  }, []);

  useEffect(() => {
    if ((mode === "verify" || mode === "reset") && linkToken) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [mode, linkToken]);

  useEffect(() => {
    if (mode !== "verify" || verificationStarted.current) return;
    verificationStarted.current = true;
    const token = linkToken;
    if (!token) {
      setError("This verification link is missing its token.");
      return;
    }
    setBusy(true);
    identityRequest("/api/auth/verify-email", { method: "POST", body: { token } })
      .then(() => setNotice("Your email is verified. You can sign in now."))
      .catch((requestError) => { setError(requestError.message); setErrorCode(requestError.code || ""); })
      .finally(() => setBusy(false));
  }, [mode, linkToken]);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setErrorCode("");
    setNotice("");
    if ((mode === "register" || mode === "reset") && form.password !== form.confirm_password) {
      setError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") {
        await identityRequest("/api/auth/login", {
          method: "POST",
          body: { email: form.email, password: form.password }
        });
        onAuthenticated();
        return;
      }
      if (mode === "register") {
        const result = await identityRequest("/api/auth/register", {
          method: "POST",
          body: { display_name: form.display_name, email: form.email, password: form.password }
        });
        setNotice(result.message || "Check your email to verify your account.");
        return;
      }
      if (mode === "forgot") {
        const result = await identityRequest("/api/auth/forgot-password", {
          method: "POST",
          body: { email: form.email }
        });
        setNotice(result.message || "Check your email for a reset link.");
        return;
      }
      if (mode === "reset") {
        await identityRequest("/api/auth/reset-password", {
          method: "POST",
          body: { token: linkToken, password: form.password }
        });
        setNotice("Your password has been reset. You can sign in now.");
      }
    } catch (requestError) {
      setError(requestError.message);
      setErrorCode(requestError.code || "");
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      const result = await identityRequest("/api/auth/resend-verification", {
        method: "POST",
        body: { email: form.email }
      });
      setNotice(result.message);
    } catch (requestError) {
      setError(requestError.message);
      setErrorCode(requestError.code || "");
    } finally {
      setBusy(false);
    }
  }

  const loadedConfig = config || DEFAULT_CONFIG;
  const copy = identityCopy(mode);
  const completedLinkMode = mode === "verify" || mode === "reset";
  return (
    <main className="identity-page">
      <header className="identity-header">
        <button className="identity-wordmark" type="button" onClick={onHome}>Virenis</button>
        <button className="identity-back" type="button" onClick={onHome}><ArrowLeft size={15} />Back to home</button>
      </header>
      <section className="identity-stage" aria-labelledby="identity-title">
        <div className="identity-intro">
          <span className="identity-kicker"><ShieldCheck size={14} /> Private by default</span>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
          <ul aria-label="Account protections">
            <li><Check size={14} />A private workspace for your agents and conversations</li>
            <li><Check size={14} />Secure browser sessions you can review and revoke</li>
            <li><Check size={14} />Verified email and recoverable account access</li>
          </ul>
        </div>

        <div className="identity-card">
          {!config && !error && <div className="identity-loading" role="status"><LoaderCircle className="spin" size={18} />Loading account access</div>}
          {!config && error && <div className="identity-result"><AlertCircle size={25} /><p role="alert">{error}</p><button className="identity-primary" type="button" onClick={() => window.location.reload()}>Try again</button></div>}
          {config && !loadedConfig.self_service_enabled && (
            <div className="identity-disabled">
              <KeyRound size={24} />
              <h2>Configured access</h2>
              <p>This installation uses administrator-provided credentials instead of self-service accounts.</p>
              <button className="identity-primary" type="button" onClick={onAuthenticated}>Open workspace</button>
            </div>
          )}
          {config && loadedConfig.self_service_enabled && (
            <>
              <div className="identity-card-heading">
                <span>{copy.eyebrow}</span>
                <h2>{copy.formTitle}</h2>
              </div>

              {mode === "verify" ? (
                <IdentityResult busy={busy} error={error} notice={notice} onSignIn={() => onNavigate("login")} />
              ) : (
                <form className="identity-form" onSubmit={submit}>
                  {mode === "register" && (
                    <label>
                      <span>Name</span>
                      <div className="identity-input"><UserRound size={16} /><input autoComplete="name" value={form.display_name} onChange={(event) => update("display_name", event.target.value)} required maxLength={80} /></div>
                    </label>
                  )}
                  {(mode === "login" || mode === "register" || mode === "forgot") && (
                    <label>
                      <span>Email</span>
                      <div className="identity-input"><Mail size={16} /><input type="email" autoComplete="email" value={form.email} onChange={(event) => update("email", event.target.value)} required maxLength={254} /></div>
                    </label>
                  )}
                  {(mode === "login" || mode === "register" || mode === "reset") && (
                    <label>
                      <span>{mode === "reset" ? "New password" : "Password"}</span>
                      <div className="identity-input"><KeyRound size={16} /><input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={form.password} onChange={(event) => update("password", event.target.value)} required minLength={loadedConfig.password_min_characters} maxLength={128} /></div>
                      {mode !== "login" && <small>At least {loadedConfig.password_min_characters} characters</small>}
                    </label>
                  )}
                  {(mode === "register" || mode === "reset") && (
                    <label>
                      <span>Confirm password</span>
                      <div className="identity-input"><KeyRound size={16} /><input type="password" autoComplete="new-password" value={form.confirm_password} onChange={(event) => update("confirm_password", event.target.value)} required minLength={loadedConfig.password_min_characters} maxLength={128} /></div>
                    </label>
                  )}

                  {mode === "login" && <button className="identity-inline-link" type="button" onClick={() => onNavigate("forgot")}>Forgot password?</button>}
                  {error && <div className="identity-message error" role="alert"><AlertCircle size={15} />{error}</div>}
                  {errorCode === "email_not_verified" && form.email && (
                    <button className="identity-inline-link" type="button" disabled={busy} onClick={resendVerification}>Send a new verification email</button>
                  )}
                  {notice && <div className="identity-message success" role="status"><Check size={15} />{notice}</div>}
                  {!notice && (
                    <button className="identity-primary" type="submit" disabled={busy}>
                      {busy && <LoaderCircle className="spin" size={16} />}{copy.action}
                    </button>
                  )}
                  {notice && completedLinkMode && <button className="identity-primary" type="button" onClick={() => onNavigate("login")}>Continue to sign in</button>}
                </form>
              )}

              <div className="identity-switch">
                {mode === "login" && loadedConfig.registration_enabled && <>New to Virenis? <button type="button" onClick={() => onNavigate("register")}>Create an account</button></>}
                {mode === "register" && <>Already have an account? <button type="button" onClick={() => onNavigate("login")}>Sign in</button></>}
                {mode === "forgot" && <button type="button" onClick={() => onNavigate("login")}>Return to sign in</button>}
                {mode === "reset" && notice && <button type="button" onClick={() => onNavigate("login")}>Return to sign in</button>}
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}

function IdentityResult({ busy, error, notice, onSignIn }) {
  return (
    <div className="identity-result">
      {busy && <><LoaderCircle className="spin" size={25} /><p>Verifying your email…</p></>}
      {!busy && error && <><AlertCircle size={25} /><p role="alert">{error}</p></>}
      {!busy && notice && <><Check size={25} /><p>{notice}</p><button className="identity-primary" type="button" onClick={onSignIn}>Continue to sign in</button></>}
    </div>
  );
}

function identityCopy(mode) {
  if (mode === "register") return { eyebrow: "Create account", title: "Build your own team of agents.", description: "Your workspace, agents, documents, and connections remain scoped to your identity.", formTitle: "Get started", action: "Create account" };
  if (mode === "forgot") return { eyebrow: "Account recovery", title: "Recover access securely.", description: "We will send a short-lived reset link if the email belongs to an active account.", formTitle: "Reset your password", action: "Send reset link" };
  if (mode === "reset") return { eyebrow: "Choose a password", title: "Set a new account password.", description: "Completing this reset signs out every existing browser session for your protection.", formTitle: "New password", action: "Reset password" };
  if (mode === "verify") return { eyebrow: "Email verification", title: "Confirm this account belongs to you.", description: "Verification activates sign-in without exposing the verification token to stored account data.", formTitle: "Verifying email", action: "Verify" };
  return { eyebrow: "Welcome back", title: "Continue where your agents left off.", description: "Sign in to your private workspace and resume conversations, workflows, and connected tools.", formTitle: "Sign in", action: "Sign in" };
}

export function AccountPanel({ auth, onSignedOut, onAuthChanged = async () => undefined }) {
  const [sessions, setSessions] = useState([]);
  const [displayName, setDisplayName] = useState(auth?.display_name || "");
  const [passwords, setPasswords] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [deletion, setDeletion] = useState({ password: "", confirmation: "" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isBrowserAccount = auth?.auth_type === "session";

  useEffect(() => {
    if (isBrowserAccount) refreshSessions();
  }, [isBrowserAccount]);

  async function refreshSessions() {
    try {
      const result = await identityRequest("/api/account/sessions");
      setSessions(result.sessions || []);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function run(action, callback) {
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await callback();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  async function signOut() {
    await run("logout", async () => {
      await identityRequest("/api/auth/logout", { method: "POST", body: {} });
      onSignedOut();
    });
  }

  async function revokeSession(session) {
    await run(`revoke:${session.session_id}`, async () => {
      await identityRequest(`/api/account/sessions/${encodeURIComponent(session.session_id)}`, { method: "DELETE" });
      if (session.current) onSignedOut();
      else await refreshSessions();
    });
  }

  async function changePassword(event) {
    event.preventDefault();
    if (passwords.new_password !== passwords.confirm_password) {
      setError("The new passwords do not match.");
      return;
    }
    await run("password", async () => {
      await identityRequest("/api/account/password", {
        method: "POST",
        body: { current_password: passwords.current_password, new_password: passwords.new_password }
      });
      setPasswords({ current_password: "", new_password: "", confirm_password: "" });
      setNotice("Password updated. Other browser sessions were signed out.");
      await refreshSessions();
    });
  }

  async function updateProfile(event) {
    event.preventDefault();
    await run("profile", async () => {
      await identityRequest("/api/account/profile", { method: "PATCH", body: { display_name: displayName } });
      await onAuthChanged();
      setNotice("Profile updated.");
    });
  }

  async function exportData() {
    await run("export", async () => {
      const payload = await identityRequest("/api/account/export");
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `virenis-account-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("Your account export has been prepared.");
    });
  }

  async function deleteAccount(event) {
    event.preventDefault();
    await run("delete", async () => {
      await identityRequest("/api/account", { method: "DELETE", body: deletion });
      window.localStorage.removeItem(`virenis:agent-graph:${auth?.workspace_id || "workspace"}`);
      onSignedOut();
    });
  }

  if (!isBrowserAccount) {
    return (
      <section className="resource-section account-panel" aria-labelledby="account-heading">
        <div className="section-heading"><div><h3 id="account-heading">Account</h3><p>This identity is managed by the deployment administrator.</p></div></div>
        <div className="account-summary"><KeyRound size={18} /><div><strong>{auth?.display_name || auth?.user_id}</strong><span>{auth?.auth_type === "bearer" ? "API bearer identity" : "Configured administrator identity"}</span></div></div>
      </section>
    );
  }

  return (
    <section className="resource-section account-panel" aria-labelledby="account-heading">
      <div className="section-heading"><div><h3 id="account-heading">Account</h3><p>Manage your profile, security, data, and active browser sessions.</p></div></div>
      {error && <div className="identity-message error" role="alert"><AlertCircle size={15} />{error}</div>}
      {notice && <div className="identity-message success" role="status"><Check size={15} />{notice}</div>}

      <div className="account-summary">
        <span className="profile-initials" aria-hidden="true">{String(auth?.display_name || auth?.user_id || "U").slice(0, 2).toUpperCase()}</span>
        <div><strong>{auth?.display_name || auth?.user_id}</strong><span>{auth?.email}</span><small><ShieldCheck size={12} />Email verified · {auth?.role}</small></div>
        <button className="text-button secondary" type="button" onClick={signOut} disabled={Boolean(busy)}><LogOut size={15} />Sign out</button>
      </div>

      <div className="account-grid">
        <form className="account-card account-form" onSubmit={updateProfile}>
          <div className="account-card-heading"><div><h4>Profile</h4><p>This name appears on agents you publish.</p></div><UserRound size={17} /></div>
          <label><span>Display name</span><input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={80} /></label>
          <label><span>Verified email</span><input value={auth?.email || ""} disabled readOnly /></label>
          <button className="text-button secondary" type="submit" disabled={Boolean(busy)}>{busy === "profile" ? <LoaderCircle className="spin" size={15} /> : <UserRound size={15} />}Save profile</button>
        </form>

        <section className="account-card" aria-labelledby="browser-sessions-heading">
          <div className="account-card-heading"><div><h4 id="browser-sessions-heading">Browser sessions</h4><p>Review where this account is signed in.</p></div><button className="icon-button compact" aria-label="Refresh browser sessions" type="button" onClick={refreshSessions}><RefreshCw size={15} /></button></div>
          <div className="account-session-list">
            {sessions.map((session) => (
              <div className="account-session" key={session.session_id}>
                <MonitorSmartphone size={17} />
                <div><strong>{session.current ? "This browser" : "Browser session"}</strong><span>{session.user_agent}</span><small>Last active {formatIdentityDate(session.last_seen_at)}</small></div>
                <button type="button" onClick={() => revokeSession(session)} disabled={Boolean(busy)}>{busy === `revoke:${session.session_id}` ? "Revoking…" : "Revoke"}</button>
              </div>
            ))}
          </div>
          {sessions.length > 1 && <button className="text-button secondary" type="button" disabled={Boolean(busy)} onClick={() => run("others", async () => { await identityRequest("/api/account/sessions/revoke-others", { method: "POST", body: {} }); await refreshSessions(); setNotice("Other browser sessions were signed out."); })}>Sign out other sessions</button>}
        </section>

        <form className="account-card account-form" onSubmit={changePassword}>
          <div className="account-card-heading"><div><h4>Change password</h4><p>This signs out every other browser session.</p></div><KeyRound size={17} /></div>
          <label><span>Current password</span><input type="password" autoComplete="current-password" value={passwords.current_password} onChange={(event) => setPasswords((current) => ({ ...current, current_password: event.target.value }))} required /></label>
          <label><span>New password</span><input type="password" autoComplete="new-password" minLength={15} maxLength={128} value={passwords.new_password} onChange={(event) => setPasswords((current) => ({ ...current, new_password: event.target.value }))} required /></label>
          <label><span>Confirm new password</span><input type="password" autoComplete="new-password" minLength={15} maxLength={128} value={passwords.confirm_password} onChange={(event) => setPasswords((current) => ({ ...current, confirm_password: event.target.value }))} required /></label>
          <button className="text-button secondary" type="submit" disabled={Boolean(busy)}>{busy === "password" ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}Update password</button>
        </form>
      </div>

      <section className="account-card data-card">
        <div><h4>Your data</h4><p>Download a structured copy of your profile, agents, chats, workflows, documents, and activity. Stored credentials are never included.</p></div>
        <button className="text-button secondary" type="button" onClick={exportData} disabled={Boolean(busy)}>{busy === "export" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}Export account data</button>
      </section>

      <form className="account-card danger-zone account-form" onSubmit={deleteAccount}>
        <div className="account-card-heading"><div><h4>Delete account</h4><p>Permanently removes this workspace, its agents, documents, connections, workflows, and conversations. De-identified integrity receipts may be retained for security and provenance. This cannot be undone.</p></div><Trash2 size={17} /></div>
        <label><span>Current password</span><input type="password" autoComplete="current-password" value={deletion.password} onChange={(event) => setDeletion((current) => ({ ...current, password: event.target.value }))} required /></label>
        <label><span>Type DELETE to confirm</span><input value={deletion.confirmation} onChange={(event) => setDeletion((current) => ({ ...current, confirmation: event.target.value }))} required pattern="DELETE" /></label>
        <button className="text-button danger" type="submit" disabled={Boolean(busy) || deletion.confirmation !== "DELETE"}>{busy === "delete" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}Delete account permanently</button>
      </form>
    </section>
  );
}

export function AdminUsersPanel() {
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => { refresh(); }, []);

  async function refresh() {
    try {
      const result = await identityRequest("/api/admin/users");
      setUsers(result.users || []);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function update(user, patch) {
    setBusy(user.user_id);
    setError("");
    setNotice("");
    try {
      await identityRequest(`/api/admin/users/${encodeURIComponent(user.user_id)}`, { method: "PATCH", body: patch });
      setNotice(`${user.display_name || user.email} was updated.`);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  async function revoke(user) {
    setBusy(user.user_id);
    setError("");
    try {
      const result = await identityRequest(`/api/admin/users/${encodeURIComponent(user.user_id)}/revoke-sessions`, { method: "POST", body: {} });
      setNotice(`${result.revoked} session${result.revoked === 1 ? "" : "s"} revoked for ${user.display_name || user.email}.`);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="admin-users" aria-labelledby="admin-users-heading">
      <div className="account-card-heading"><div><h4 id="admin-users-heading">Registered users</h4><p>Suspend access, assign roles, verify an address, or revoke browser sessions.</p></div><button className="icon-button compact" type="button" aria-label="Refresh registered users" onClick={refresh}><RefreshCw size={15} /></button></div>
      {error && <div className="identity-message error" role="alert"><AlertCircle size={15} />{error}</div>}
      {notice && <div className="identity-message success" role="status"><Check size={15} />{notice}</div>}
      <div className="admin-user-list">
        {users.map((user) => (
          <div className="admin-user-row" key={user.user_id}>
            <span className="profile-initials" aria-hidden="true">{String(user.display_name || user.email).slice(0, 2).toUpperCase()}</span>
            <div className="admin-user-copy"><strong>{user.display_name || user.email}</strong><span>{user.email}</span><small>{user.active_sessions} active session{user.active_sessions === 1 ? "" : "s"} · joined {formatIdentityDate(user.created_at)}</small></div>
            <label><span className="sr-only">Role for {user.email}</span><select value={user.role} disabled={busy === user.user_id} onChange={(event) => update(user, { role: event.target.value })}><option value="user">User</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
            <label><span className="sr-only">Status for {user.email}</span><select value={user.status} disabled={busy === user.user_id} onChange={(event) => update(user, { status: event.target.value })}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
            <div className="admin-user-actions">
              {!user.email_verified && <button type="button" onClick={() => update(user, { email_verified: true })} disabled={busy === user.user_id}>Verify</button>}
              <button type="button" onClick={() => revoke(user)} disabled={busy === user.user_id || user.active_sessions === 0}>Revoke sessions</button>
            </div>
          </div>
        ))}
        {users.length === 0 && <p className="muted-empty">No self-service users have registered.</p>}
      </div>
    </section>
  );
}

async function identityRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try { payload = JSON.parse(text); }
    catch { payload = { message: text }; }
  }
  if (!response.ok) {
    const error = new Error(payload.message || "The request could not be completed.");
    error.status = response.status;
    error.code = payload.error;
    if (response.status === 401 && typeof window !== "undefined" && path !== "/api/auth/login") {
      window.dispatchEvent(new Event("virenis:authentication-required"));
    }
    throw error;
  }
  return payload;
}

function formatIdentityDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function identityLinkToken() {
  if (typeof window === "undefined") return "";
  const fragment = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
  return fragment.get("token") || new URLSearchParams(window.location.search).get("token") || "";
}
