import {
  AlertCircle,
  ArrowLeft,
  Check,
  Download,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound
} from "lucide-react";
import { SignIn, SignUp, useClerk, useUser } from "@clerk/react";
import { useEffect, useState } from "react";

export function IdentityPage({ mode = "login", onHome }) {
  const registering = mode === "register";
  return (
    <main className="identity-page">
      <header className="identity-header">
        <button className="identity-wordmark" type="button" onClick={onHome}>Virenis</button>
        <button className="identity-back" type="button" onClick={onHome}><ArrowLeft size={15} />Back to home</button>
      </header>
      <section className="identity-stage" aria-labelledby="identity-title">
        <div className="identity-intro">
          <span className="identity-kicker"><ShieldCheck size={14} /> Private by default</span>
          <h1 id="identity-title">{registering ? "Build your own team of agents." : "Continue where your agents left off."}</h1>
          <p>
            {registering
              ? "Your workspace, agents, documents, and connections remain scoped to your identity."
              : "Sign in to your private workspace and resume conversations, workflows, and connected tools."}
          </p>
          <ul aria-label="Account protections">
            <li><Check size={14} />A private workspace for your agents and conversations</li>
            <li><Check size={14} />Secure sessions, recovery, and multi-factor authentication</li>
            <li><Check size={14} />Verified identity powered by Clerk</li>
          </ul>
        </div>

        <div className="identity-card clerk-identity-card">
          {registering ? (
            <SignUp
              routing="path"
              path="/register"
              oauthFlow="redirect"
              signInUrl="/login"
              fallbackRedirectUrl="/app"
              forceRedirectUrl="/app"
            />
          ) : (
            <SignIn
              routing="path"
              path="/login"
              oauthFlow="redirect"
              signUpUrl="/register"
              fallbackRedirectUrl="/app"
              forceRedirectUrl="/app"
            />
          )}
        </div>
      </section>
    </main>
  );
}

export function AccountPanel({ auth, onSignedOut }) {
  const { openUserProfile, signOut } = useClerk();
  const { user } = useUser();
  const [deletion, setDeletion] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const isClerkAccount = auth?.auth_type === "clerk";

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
      await identityRequest("/api/account", {
        method: "DELETE",
        body: { confirmation: deletion }
      });
      window.localStorage.removeItem(`virenis:agent-graph:${auth?.workspace_id || "workspace"}`);
      try {
        await signOut({ redirectUrl: "/" });
      } catch {
        onSignedOut();
      }
    });
  }

  if (!isClerkAccount) {
    return (
      <section className="resource-section account-panel" aria-labelledby="account-heading">
        <div className="section-heading"><div><h3 id="account-heading">Account</h3><p>This identity is managed by the deployment administrator.</p></div></div>
        <div className="account-summary"><KeyRound size={18} /><div><strong>{auth?.display_name || auth?.user_id}</strong><span>{auth?.auth_type === "bearer" ? "API bearer identity" : "Configured administrator identity"}</span></div></div>
      </section>
    );
  }

  return (
    <section className="resource-section account-panel" aria-labelledby="account-heading">
      <div className="section-heading"><div><h3 id="account-heading">Account</h3><p>Clerk protects your identity. Virenis keeps your product data inside your private workspace.</p></div></div>
      {error && <div className="identity-message error" role="alert"><AlertCircle size={15} />{error}</div>}
      {notice && <div className="identity-message success" role="status"><Check size={15} />{notice}</div>}

      <div className="account-summary">
        {user?.imageUrl || auth?.avatar_url
          ? <img className="account-avatar" src={user?.imageUrl || auth.avatar_url} alt="" />
          : <span className="profile-initials" aria-hidden="true">{initialsFor(auth)}</span>}
        <div>
          <strong>{user?.fullName || auth?.display_name || auth?.user_id}</strong>
          <span>{user?.primaryEmailAddress?.emailAddress || auth?.email}</span>
          <small><ShieldCheck size={12} />Clerk verified · {auth?.role}</small>
        </div>
        <button className="text-button secondary" type="button" onClick={() => openUserProfile()} disabled={Boolean(busy)}><UserRound size={15} />Manage identity</button>
      </div>

      <div className="account-grid clerk-account-grid">
        <section className="account-card">
          <div className="account-card-heading"><div><h4>Identity & security</h4><p>Update your profile, email addresses, password, connected accounts, MFA, and active sessions through Clerk.</p></div><ShieldCheck size={17} /></div>
          <button className="text-button secondary" type="button" onClick={() => openUserProfile()}><UserRound size={15} />Open account settings</button>
        </section>

        <section className="account-card data-card">
          <div><h4>Your Virenis data</h4><p>Download your profile, agents, chats, workflows, documents, and activity. Stored credentials are never included.</p></div>
          <button className="text-button secondary" type="button" onClick={exportData} disabled={Boolean(busy)}>{busy === "export" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}Export account data</button>
        </section>
      </div>

      <form className="account-card danger-zone account-form" onSubmit={deleteAccount}>
        <div className="account-card-heading"><div><h4>Delete account</h4><p>Permanently removes your Clerk identity and this private Virenis workspace, including its agents, documents, connections, workflows, and conversations. This cannot be undone.</p></div><Trash2 size={17} /></div>
        <label><span>Type DELETE to confirm</span><input value={deletion} onChange={(event) => setDeletion(event.target.value)} required pattern="DELETE" autoComplete="off" /></label>
        <button className="text-button danger" type="submit" disabled={Boolean(busy) || deletion !== "DELETE"}>{busy === "delete" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}Delete account permanently</button>
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
    setNotice("");
    try {
      const result = await identityRequest(`/api/admin/users/${encodeURIComponent(user.user_id)}/revoke-sessions`, { method: "POST", body: {} });
      setNotice(`${result.revoked} Clerk session${result.revoked === 1 ? "" : "s"} revoked for ${user.display_name || user.email}.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="admin-users" aria-labelledby="admin-users-heading">
      <div className="account-card-heading"><div><h4 id="admin-users-heading">Registered users</h4><p>Assign product roles, suspend access, or revoke Clerk sessions. Clerk manages identity verification.</p></div><button className="icon-button compact" type="button" aria-label="Refresh registered users" onClick={refresh}><RefreshCw size={15} /></button></div>
      {error && <div className="identity-message error" role="alert"><AlertCircle size={15} />{error}</div>}
      {notice && <div className="identity-message success" role="status"><Check size={15} />{notice}</div>}
      <div className="admin-user-list">
        {users.map((user) => (
          <div className="admin-user-row" key={user.user_id}>
            {user.avatar_url ? <img className="profile-avatar" src={user.avatar_url} alt="" /> : <span className="profile-initials" aria-hidden="true">{initialsFor(user)}</span>}
            <div className="admin-user-copy"><strong>{user.display_name || user.email}</strong><span>{user.email}</span><small>{user.email_verified ? "Verified by Clerk" : "Verification pending"} · joined {formatIdentityDate(user.created_at)}</small></div>
            <label><span className="sr-only">Role for {user.email}</span><select value={user.role} disabled={busy === user.user_id} onChange={(event) => update(user, { role: event.target.value })}><option value="user">User</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
            <label><span className="sr-only">Status for {user.email}</span><select value={user.status} disabled={busy === user.user_id} onChange={(event) => update(user, { status: event.target.value })}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
            <div className="admin-user-actions"><button type="button" onClick={() => revoke(user)} disabled={busy === user.user_id}>Revoke sessions</button></div>
          </div>
        ))}
        {users.length === 0 && <p className="muted-empty">No Clerk users have signed up yet.</p>}
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
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("virenis:authentication-required"));
    }
    throw error;
  }
  return payload;
}

function formatIdentityDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function initialsFor(identity) {
  return String(identity?.display_name || identity?.fullName || identity?.email || identity?.user_id || "User")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "U";
}
