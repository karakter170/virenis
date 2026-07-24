import {
  AlertCircle,
  ArrowLeft,
  Check,
  Download,
  Gauge,
  KeyRound,
  LoaderCircle,
  Plug,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRound
} from "lucide-react";
import { SignIn, SignUp, useClerk, useUser } from "@clerk/react";
import { useEffect, useState } from "react";
import { isAuthenticationRequiredResponse, notifyAuthenticationRequired } from "./authRecovery.js";

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

export function SessionRecoveryPage({ failure, busy = "", error = "", onRetry, onSignOut, onHome }) {
  return (
    <main className="identity-page">
      <header className="identity-header">
        <button className="identity-wordmark" type="button" onClick={onHome}>Virenis</button>
        <button className="identity-back" type="button" onClick={onHome}><ArrowLeft size={15} />Back to home</button>
      </header>
      <section className="identity-stage session-recovery-stage" aria-labelledby="session-recovery-title">
        <div className="identity-intro">
          <span className="identity-kicker"><ShieldCheck size={14} /> Session protected</span>
          <h1 id="session-recovery-title">Sign-in succeeded. Server verification did not.</h1>
          <p>Virenis stopped the workspace from retrying automatically, so your browser will remain stable while the session is recovered.</p>
          <ul aria-label="Session recovery protections">
            <li><Check size={14} />No repeated workspace reloads</li>
            <li><Check size={14} />No background API request storm</li>
            <li><Check size={14} />No security checks bypassed</li>
          </ul>
        </div>
        <section className="identity-card session-recovery-card" aria-label="Session recovery">
          <span className="session-recovery-icon" aria-hidden="true"><AlertCircle size={22} /></span>
          <div>
            <h2>{failure?.title || "Your session could not be verified"}</h2>
            <p>{failure?.message || "Refresh the session and try again, or sign out and start a new sign-in."}</p>
          </div>
          {failure?.origin && (
            <div className="session-recovery-origin">
              <span>Current site address</span>
              <code>{failure.origin}</code>
            </div>
          )}
          {failure?.configured_origin && failure.configured_origin !== failure.origin && (
            <div className="session-recovery-origin">
              <span>Server-configured address</span>
              <code>{failure.configured_origin}</code>
            </div>
          )}
          {error && <div className="identity-message error" role="alert"><AlertCircle size={15} />{error}</div>}
          <div className="session-recovery-actions">
            <button className="text-button primary" type="button" onClick={onRetry} disabled={Boolean(busy)}>
              {busy === "retry" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Refresh session and retry
            </button>
            <button className="text-button secondary" type="button" onClick={onSignOut} disabled={Boolean(busy)}>
              {busy === "signout" ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}Sign out
            </button>
          </div>
          {failure?.request_id && <small>Support request ID: <code>{failure.request_id}</code></small>}
        </section>
      </section>
    </main>
  );
}

export function AccountPanel({ auth, billing, onRefreshBilling, onSignedOut }) {
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
      const graphPrefix = `virenis:agent-graph:${auth?.workspace_id || "workspace"}`;
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith(graphPrefix)) window.localStorage.removeItem(key);
      }
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
        <BillingAccountCard billing={billing} onRefresh={onRefreshBilling} />
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

      <BillingAccountCard billing={billing} onRefresh={onRefreshBilling} />

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

function BillingAccountCard({ billing, onRefresh }) {
  const account = billing?.account;
  return (
    <section className="account-card billing-account-card" aria-labelledby="billing-balance-heading">
      <div className="account-card-heading">
        <div>
          <h4 id="billing-balance-heading">Credit balance</h4>
          <p>Model usage is charged from server-reported tokens. Active requests reserve credits, then return any unused amount.</p>
        </div>
        <button className="icon-button compact" type="button" aria-label="Refresh credit balance" onClick={onRefresh} disabled={!onRefresh}>
          <RefreshCw size={15} />
        </button>
      </div>
      {account ? (
        <>
          <dl className="billing-stat-grid">
            <div><dt>Available</dt><dd>{formatCredits(account.balance_credits)}</dd></div>
            <div><dt>Reserved</dt><dd>{formatCredits(account.reserved_credits)}</dd></div>
            <div><dt>Lifetime used</dt><dd>{formatCredits(account.lifetime_debited_credits)}</dd></div>
          </dl>
          <div className="billing-history" aria-label="Recent balance activity">
            {(account.recent_entries || []).slice(0, 6).map((entry) => {
              const amount = billingEntryAmount(entry);
              return (
                <div key={entry.entry_id}>
                  <span><strong>{billingEntryLabel(entry.type)}</strong><small>{formatIdentityDateTime(entry.created_at)}</small></span>
                  <em className={amount.tone}>{amount.text}</em>
                </div>
              );
            })}
            {!account.recent_entries?.length && <p className="muted-empty">No balance activity yet.</p>}
          </div>
        </>
      ) : <p className="muted-empty">Loading your balance…</p>}
    </section>
  );
}

export function AdminUsersPanel() {
  const [users, setUsers] = useState([]);
  const [accounts, setAccounts] = useState({});
  const [pricing, setPricing] = useState(null);
  const [pricingDraft, setPricingDraft] = useState(() => pricingDraftFrom(null));
  const [pricingMutationKey, setPricingMutationKey] = useState("");
  const [outputSettings, setOutputSettings] = useState(null);
  const [outputDraft, setOutputDraft] = useState(() => outputSettingsDraftFrom(null));
  const [runtimeModel, setRuntimeModel] = useState(null);
  const [runtimeModelDraft, setRuntimeModelDraft] = useState(() => runtimeModelDraftFrom(null));
  const [mcpProviders, setMcpProviders] = useState([]);
  const [mcpDrafts, setMcpDrafts] = useState({});
  const [adjustments, setAdjustments] = useState({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loadState, setLoadState] = useState("loading");

  useEffect(() => { refresh(); }, []);

  async function refresh() {
    setLoadState("loading");
    setError("");
    try {
      const [userResult, accountResult, pricingResult, outputResult, runtimeModelResult, mcpProviderResult] = await Promise.all([
        identityRequest("/api/admin/users"),
        identityRequest("/api/admin/billing/accounts"),
        identityRequest("/api/admin/billing/pricing"),
        identityRequest("/api/admin/model-output-settings"),
        identityRequest("/api/admin/runtime-model"),
        identityRequest("/api/admin/mcp-providers")
      ]);
      setUsers(userResult.users || []);
      setAccounts(Object.fromEntries((accountResult.accounts || []).map((account) => [account.user_id, account])));
      setPricing(pricingResult.pricing || null);
      setPricingDraft(pricingDraftFrom(pricingResult.pricing));
      setOutputSettings(outputResult.settings || null);
      setOutputDraft(outputSettingsDraftFrom(outputResult.settings));
      setRuntimeModel(runtimeModelResult.settings || null);
      setRuntimeModelDraft(runtimeModelDraftFrom(runtimeModelResult.settings));
      setMcpProviders(mcpProviderResult.providers || []);
      setMcpDrafts(Object.fromEntries((mcpProviderResult.providers || []).map((provider) => [
        provider.id,
        { client_id: provider.client_id || "", client_secret: "" }
      ])));
      setPricingMutationKey("");
      setLoadState("ready");
    } catch (requestError) {
      setError(requestError.message);
      setLoadState("failed");
    }
  }

  function confirmIdentityChange(user, message) {
    const identity = user.display_name || user.email || user.user_id;
    return globalThis.confirm?.(`${message}\n\nAffected account: ${identity}`) !== false;
  }

  async function confirmAndUpdate(user, patch) {
    const message = patch.role
      ? `Change this account's role from ${user.role} to ${patch.role}?`
      : patch.status === "suspended"
        ? "Suspend this account and block its access?"
        : "Reactivate this account?";
    if (!confirmIdentityChange(user, message)) return;
    await update(user, patch);
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
    if (!confirmIdentityChange(user, "Revoke every active Clerk session for this account?")) return;
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

  async function adjustBalance(user) {
    const draft = adjustments[user.user_id] || {};
    const idempotencyKey = draft.idempotencyKey || mutationKey("balance");
    setAdjustments((current) => ({
      ...current,
      [user.user_id]: { ...current[user.user_id], idempotencyKey }
    }));
    setBusy(`billing:${user.user_id}`);
    setError("");
    setNotice("");
    try {
      await identityRequest(`/api/admin/billing/accounts/${encodeURIComponent(user.user_id)}/adjustments`, {
        method: "POST",
        body: { amount_credits: draft.amount, reason: draft.reason },
        idempotencyKey
      });
      setAdjustments((current) => ({ ...current, [user.user_id]: { amount: "", reason: "" } }));
      setNotice(`${user.display_name || user.email}'s balance was adjusted.`);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  async function savePricing(event) {
    event.preventDefault();
    if (!pricingDraft || loadState !== "ready") return;
    const idempotencyKey = pricingMutationKey || mutationKey("pricing");
    setPricingMutationKey(idempotencyKey);
    setBusy("pricing");
    setError("");
    setNotice("");
    try {
      const result = await identityRequest("/api/admin/billing/pricing", {
        method: "POST",
        body: {
          prompt_credits_per_1k: pricingDraft.prompt,
          completion_credits_per_1k: pricingDraft.completion,
          cached_credits_per_1k: pricingDraft.cached,
          unclassified_credits_per_1k: pricingDraft.completion,
          minimum_reservation_credits: pricingDraft.minimum,
          reason: pricingDraft.reason
        },
        idempotencyKey
      });
      setPricing(result.pricing);
      setPricingDraft(pricingDraftFrom(result.pricing));
      setPricingMutationKey("");
      setNotice("Token pricing was updated. Existing reservations keep their original rate.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  async function saveOutputSettings(event) {
    event.preventDefault();
    if (!outputDraft || !outputSettings || loadState !== "ready") return;
    setBusy("output-settings");
    setError("");
    setNotice("");
    try {
      const result = await identityRequest("/api/admin/model-output-settings", {
        method: "PATCH",
        body: {
          agent_output_tokens: Number(outputDraft.agent),
          final_output_tokens: Number(outputDraft.final),
          reason: outputDraft.reason
        }
      });
      setOutputSettings(result.settings);
      setOutputDraft(outputSettingsDraftFrom(result.settings));
      setNotice("Model output limits were updated for this workspace. New answers will use them immediately.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  async function saveRuntimeModel(event) {
    event.preventDefault();
    setBusy("runtime-model");
    setError("");
    setNotice("");
    try {
      const result = await identityRequest("/api/admin/runtime-model", {
        method: "PATCH",
        body: {
          provider: runtimeModelDraft.provider,
          base_url: runtimeModelDraft.base_url,
          model: runtimeModelDraft.model,
          revision: runtimeModelDraft.revision,
          context_tokens: Number(runtimeModelDraft.context_tokens),
          ...(runtimeModelDraft.api_key ? { api_key: runtimeModelDraft.api_key } : {})
        }
      });
      setRuntimeModel(result.settings);
      setRuntimeModelDraft(runtimeModelDraftFrom(result.settings));
      setNotice(result.applied_immediately
        ? "The global model provider was updated. New work from every user uses it immediately."
        : "The global model provider was saved. It will apply when the real Runtime is enabled.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  async function saveMcpProvider(event, provider) {
    event.preventDefault();
    const draft = mcpDrafts[provider.id] || {};
    setBusy(`mcp:${provider.id}`);
    setError("");
    setNotice("");
    try {
      const result = await identityRequest(`/api/admin/mcp-providers/${encodeURIComponent(provider.id)}`, {
        method: "PATCH",
        body: {
          client_id: draft.client_id,
          ...(draft.client_secret ? { client_secret: draft.client_secret } : {})
        }
      });
      setMcpProviders((items) => items.map((item) => item.id === provider.id ? result.provider : item));
      setMcpDrafts((current) => ({
        ...current,
        [provider.id]: { client_id: result.provider.client_id || "", client_secret: "" }
      }));
      setNotice(`${provider.name} is configured and available to users who grant access.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="admin-users" aria-labelledby="admin-users-heading">
      <div className="account-card-heading"><div><h4 id="admin-users-heading">Registered users</h4><p>Assign product roles, suspend access, or revoke Clerk sessions. Clerk manages identity verification.</p></div><button className="icon-button compact" type="button" aria-label="Refresh registered users" onClick={refresh} disabled={loadState === "loading"}><RefreshCw className={loadState === "loading" ? "spin" : ""} size={15} /></button></div>
      {error && <div className="identity-message error" role="alert"><AlertCircle size={15} />{error}</div>}
      {notice && <div className="identity-message success" role="status"><Check size={15} />{notice}</div>}
      {loadState === "loading" && <p className="muted-empty" role="status">Loading authoritative account and model settings…</p>}
      {loadState === "failed" && (
        <button className="text-button secondary" type="button" onClick={refresh}>
          <RefreshCw size={14} />Retry admin settings
        </button>
      )}
      {loadState === "ready" && outputSettings && outputDraft && <form className="admin-output-form" onSubmit={saveOutputSettings}>
        <div className="admin-form-intro">
          <span><Gauge size={16} aria-hidden="true" /></span>
          <div><strong>Model output limits</strong><small>Maximum generated tokens per agent and for the final answer. Safe limits automatically reserve room for prompts, handoffs, and tool results.</small></div>
        </div>
        <label>
          <span>Each agent</span>
          <input
            type="number"
            inputMode="numeric"
            min={outputSettings?.bounds?.agent_output_tokens?.min || 128}
            max={outputSettings?.bounds?.agent_output_tokens?.max || 8192}
            step="1"
            value={outputDraft.agent}
            onChange={(event) => setOutputDraft({ ...outputDraft, agent: event.target.value })}
            required
          />
          <small>tokens</small>
        </label>
        <label>
          <span>Final answer</span>
          <input
            type="number"
            inputMode="numeric"
            min={outputSettings?.bounds?.final_output_tokens?.min || 256}
            max={outputSettings?.bounds?.final_output_tokens?.max || 12288}
            step="1"
            value={outputDraft.final}
            onChange={(event) => setOutputDraft({ ...outputDraft, final: event.target.value })}
            required
          />
          <small>tokens</small>
        </label>
        <label className="output-reason">
          <span>Change reason</span>
          <input value={outputDraft.reason} maxLength={500} onChange={(event) => setOutputDraft({ ...outputDraft, reason: event.target.value })} required />
        </label>
        <button type="submit" disabled={busy === "output-settings"}>
          {busy === "output-settings" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Save limits
        </button>
        <small className="admin-form-revision">Revision {outputSettings?.revision || 0}</small>
      </form>}
      {loadState === "ready" && runtimeModel && runtimeModelDraft && (
        <form className="admin-runtime-model-form" onSubmit={saveRuntimeModel}>
          <div className="admin-form-intro">
            <span><Gauge size={16} aria-hidden="true" /></span>
            <div><strong>Global base model</strong><small>One server-owned provider for every user. Qwen remains the default; a new API, token, or model applies to new work immediately.</small></div>
          </div>
          <label><span>Provider</span><select value={runtimeModelDraft.provider} onChange={(event) => setRuntimeModelDraft({ ...runtimeModelDraft, provider: event.target.value })}><option value="vllm">Local / vLLM</option><option value="openai_compatible">OpenAI-compatible API</option></select></label>
          <label><span>API base URL</span><input type="url" value={runtimeModelDraft.base_url} onChange={(event) => setRuntimeModelDraft({ ...runtimeModelDraft, base_url: event.target.value })} required /></label>
          <label><span>Model</span><input value={runtimeModelDraft.model} onChange={(event) => setRuntimeModelDraft({ ...runtimeModelDraft, model: event.target.value })} required maxLength={240} /></label>
          <label><span>API token</span><input type="password" value={runtimeModelDraft.api_key} onChange={(event) => setRuntimeModelDraft({ ...runtimeModelDraft, api_key: event.target.value })} placeholder={runtimeModel.api_key_configured ? "Configured · leave blank to keep" : "Optional for local vLLM"} autoComplete="new-password" /></label>
          <label><span>Deployment revision</span><input value={runtimeModelDraft.revision} onChange={(event) => setRuntimeModelDraft({ ...runtimeModelDraft, revision: event.target.value })} maxLength={240} placeholder="Optional immutable revision" /></label>
          <label><span>Context tokens</span><input type="number" min="2048" max="2000000" value={runtimeModelDraft.context_tokens} onChange={(event) => setRuntimeModelDraft({ ...runtimeModelDraft, context_tokens: event.target.value })} required /></label>
          <button type="submit" disabled={busy === "runtime-model"}>{busy === "runtime-model" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Apply globally</button>
          <small>Revision {runtimeModel.revision_number || 0}{runtimeModel.updated_at ? ` · updated ${formatIdentityDateTime(runtimeModel.updated_at)}` : ""}</small>
        </form>
      )}
      {loadState === "ready" && (
        <section className="admin-mcp-provider-settings" aria-labelledby="admin-mcp-provider-heading">
          <div className="admin-form-intro">
            <span><Plug size={16} aria-hidden="true" /></span>
            <div><strong id="admin-mcp-provider-heading">MCP app plugins</strong><small>Configure OAuth once. The app becomes available only after a user grants its requested permissions; tokens remain encrypted and are never shown here.</small></div>
          </div>
          <div>
            {mcpProviders.map((provider) => {
              const draft = mcpDrafts[provider.id] || { client_id: "", client_secret: "" };
              return (
                <form key={provider.id} onSubmit={(event) => saveMcpProvider(event, provider)}>
                  <header><span><strong>{provider.name}</strong><small>{provider.providers.join(" · ")}</small></span><em className={provider.client_secret_configured ? "configured" : ""}>{provider.client_secret_configured ? "Configured" : "Setup required"}</em></header>
                  <label><span>OAuth client ID</span><input value={draft.client_id} onChange={(event) => setMcpDrafts({ ...mcpDrafts, [provider.id]: { ...draft, client_id: event.target.value } })} required maxLength={4096} /></label>
                  <label><span>OAuth client secret</span><input type="password" value={draft.client_secret} onChange={(event) => setMcpDrafts({ ...mcpDrafts, [provider.id]: { ...draft, client_secret: event.target.value } })} placeholder={provider.client_secret_configured ? "Configured · leave blank to keep" : "Required"} required={!provider.client_secret_configured} autoComplete="new-password" /></label>
                  <button type="submit" disabled={busy === `mcp:${provider.id}`}>{busy === `mcp:${provider.id}` ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Save plugin</button>
                </form>
              );
            })}
          </div>
        </section>
      )}
      {loadState === "ready" && pricing && pricingDraft && (
        <form className="admin-pricing-form" onSubmit={savePricing}>
          <div><strong>Token pricing</strong><span>Credits per 1,000 provider-reported tokens. New rates apply only to new reservations.</span></div>
          <label><span>Input</span><input inputMode="decimal" value={pricingDraft.prompt} onChange={(event) => { setPricingDraft({ ...pricingDraft, prompt: event.target.value }); setPricingMutationKey(""); }} required /></label>
          <label><span>Output</span><input inputMode="decimal" value={pricingDraft.completion} onChange={(event) => { setPricingDraft({ ...pricingDraft, completion: event.target.value }); setPricingMutationKey(""); }} required /></label>
          <label><span>Cached input</span><input inputMode="decimal" value={pricingDraft.cached} onChange={(event) => { setPricingDraft({ ...pricingDraft, cached: event.target.value }); setPricingMutationKey(""); }} required /></label>
          <label><span>Minimum reserve</span><input inputMode="decimal" value={pricingDraft.minimum} onChange={(event) => { setPricingDraft({ ...pricingDraft, minimum: event.target.value }); setPricingMutationKey(""); }} required /></label>
          <label className="pricing-reason"><span>Change reason</span><input value={pricingDraft.reason} maxLength={500} onChange={(event) => { setPricingDraft({ ...pricingDraft, reason: event.target.value }); setPricingMutationKey(""); }} required /></label>
          <button type="submit" disabled={busy === "pricing"}>{busy === "pricing" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Save pricing</button>
          {pricing && <small>Current version {pricing.pricing_version_id}</small>}
        </form>
      )}
      {loadState === "ready" && <div className="admin-user-list">
        {users.map((user) => (
          <div className="admin-user-row" key={user.user_id}>
            {user.avatar_url ? <img className="profile-avatar" src={user.avatar_url} alt="" /> : <span className="profile-initials" aria-hidden="true">{initialsFor(user)}</span>}
            <div className="admin-user-copy"><strong>{user.display_name || user.email}</strong><span>{user.email}</span><small>{user.email_verified ? "Verified by Clerk" : "Verification pending"} · joined {formatIdentityDate(user.created_at)}</small></div>
            <label><span className="sr-only">Role for {user.email}</span><select value={user.role} disabled={busy === user.user_id} onChange={(event) => { const role = event.target.value; event.target.value = user.role; void confirmAndUpdate(user, { role }); }}><option value="user">User</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
            <label><span className="sr-only">Status for {user.email}</span><select value={user.status} disabled={busy === user.user_id} onChange={(event) => { const status = event.target.value; event.target.value = user.status; void confirmAndUpdate(user, { status }); }}><option value="active">Active</option><option value="suspended">Suspended</option></select></label>
            <div className="admin-user-actions"><button type="button" onClick={() => revoke(user)} disabled={busy === user.user_id}>Revoke sessions</button></div>
            <div className="admin-billing-summary">
              <span>Balance</span>
              <strong>{formatCredits(accounts[user.user_id]?.balance_credits)}</strong>
              <small>{formatCredits(accounts[user.user_id]?.reserved_credits)} reserved</small>
            </div>
            <div className="admin-balance-adjustment">
              <label><span className="sr-only">Signed credit adjustment for {user.email}</span><input inputMode="decimal" placeholder="10 or -5" value={adjustments[user.user_id]?.amount || ""} onChange={(event) => setAdjustments((current) => ({ ...current, [user.user_id]: { ...current[user.user_id], amount: event.target.value, idempotencyKey: "" } }))} /></label>
              <label><span className="sr-only">Adjustment reason for {user.email}</span><input placeholder="Reason" maxLength={500} value={adjustments[user.user_id]?.reason || ""} onChange={(event) => setAdjustments((current) => ({ ...current, [user.user_id]: { ...current[user.user_id], reason: event.target.value, idempotencyKey: "" } }))} /></label>
              <button type="button" onClick={() => adjustBalance(user)} disabled={busy === `billing:${user.user_id}` || !adjustments[user.user_id]?.amount || !adjustments[user.user_id]?.reason}>
                {busy === `billing:${user.user_id}` ? <LoaderCircle className="spin" size={13} /> : "Adjust"}
              </button>
            </div>
          </div>
        ))}
        {users.length === 0 && <p className="muted-empty">No Clerk users have signed up yet.</p>}
      </div>}
    </section>
  );
}

async function identityRequest(path, { method = "GET", body, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
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
    error.requestId = payload.request_id;
    error.authReason = response.headers.get("x-clerk-auth-reason") || "";
    if (isAuthenticationRequiredResponse(response, payload)) notifyAuthenticationRequired(error);
    throw error;
  }
  return payload;
}

function formatIdentityDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatIdentityDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatCredits(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(numeric)} credits`;
}

function billingEntryLabel(type) {
  const labels = {
    welcome_grant: "Welcome balance",
    usage_reservation: "Request reserved",
    usage_settlement: "Token usage",
    reservation_release: "Unused reserve returned",
    admin_adjustment: "Admin adjustment",
    external_funding: "Credits added"
  };
  return labels[type] || String(type || "Balance activity").replaceAll("_", " ");
}

function billingEntryAmount(entry) {
  const availableDelta = Number(entry?.available_delta_micros || 0);
  if (entry?.type === "usage_settlement") {
    const charged = `${formatCredits(entry.debited_credits)} used`;
    if (availableDelta > 0) return { tone: "debit", text: `${charged} · ${formatCredits(entry.available_delta_credits)} returned` };
    if (availableDelta < 0) return { tone: "debit", text: `${charged} · ${formatCredits(Math.abs(Number(entry.available_delta_credits)))} over reserve` };
    return { tone: "debit", text: charged };
  }
  return {
    tone: availableDelta < 0 ? "debit" : "credit",
    text: `${availableDelta > 0 ? "+" : ""}${formatCredits(entry?.available_delta_credits)}`
  };
}

function pricingDraftFrom(pricing) {
  if (!pricing) return null;
  const rule = pricing?.rules?.[0] || {};
  return {
    prompt: rule.prompt_credits_per_1k ?? "0.1",
    completion: rule.completion_credits_per_1k ?? "0.2",
    cached: rule.cached_credits_per_1k ?? "0.02",
    minimum: pricing?.minimum_reservation_credits ?? "0.1",
    reason: "Administrator pricing update"
  };
}

function outputSettingsDraftFrom(settings) {
  if (!settings) return null;
  return {
    agent: String(settings?.agent_output_tokens ?? 4096),
    final: String(settings?.final_output_tokens ?? 8192),
    reason: "Administrator output-limit update"
  };
}

function runtimeModelDraftFrom(settings) {
  if (!settings) return null;
  return {
    provider: settings.provider || "vllm",
    base_url: settings.base_url || "http://127.0.0.1:8000/v1",
    model: settings.model || "qwen36-awq",
    revision: settings.revision || "",
    context_tokens: String(settings.context_tokens || 32768),
    api_key: ""
  };
}

function mutationKey(scope) {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${scope}-${suffix}`;
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
