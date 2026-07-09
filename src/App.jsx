import {
  Activity,
  AlertTriangle,
  Archive,
  Bot,
  Boxes,
  CheckCircle2,
  Clipboard,
  Copy,
  Cpu,
  Download,
  Eye,
  FilePlus,
  FileText,
  KeyRound,
  Loader2,
  LockKeyhole,
  MessageSquarePlus,
  Network,
  PanelRightOpen,
  Pencil,
  Plus,
  RefreshCcw,
  Route,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  Workflow,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const api = {
  async get(path) {
    const response = await fetch(path);
    return parseResponse(response);
  },
  async post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return parseResponse(response);
  },
  async patch(path, body) {
    const response = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return parseResponse(response);
  },
  async delete(path) {
    const response = await fetch(path, { method: "DELETE" });
    return parseResponse(response);
  },
  async postForm(path, formData) {
    const response = await fetch(path, { method: "POST", body: formData });
    return parseResponse(response);
  }
};

const PROMPT_PRESETS = [
  {
    icon: ShieldCheck,
    title: "Review an AI architecture",
    meta: "Software + security",
    prompt: "Review the software architecture and security boundaries for a web backend that connects to a private vLLM deployment."
  },
  {
    icon: FileText,
    title: "Synthesize source evidence",
    meta: "Research + writing",
    prompt: "Summarize the available source evidence, identify uncertainty, and produce a concise executive brief."
  },
  {
    icon: Workflow,
    title: "Plan a product rollout",
    meta: "Strategy + planning",
    prompt: "Create a practical product rollout plan with milestones, owners, risks, and measurable launch checks."
  }
];

function emptyMetrics() {
  return {
    total_runs: 0,
    p95_end_to_end_latency: 0,
    bad_response_flags: 0,
    most_used_agents: [],
    admin_available: false
  };
}

async function parseResponse(response) {
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok) {
    throw new Error(payload.message || "Request failed");
  }
  return payload;
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [agents, setAgents] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [runtime, setRuntime] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [auth, setAuth] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [runEvents, setRunEvents] = useState([]);
  const [draft, setDraft] = useState("");
  const [showInspector, setShowInspector] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia("(min-width: 1181px)").matches;
  });
  const [uploadOpen, setUploadOpen] = useState(false);
  const [agentEditor, setAgentEditor] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const threadRef = useRef(null);

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, activeRun?.status]);

  const selectedSources = activeRun?.sources || [];
  const selectedRoutes = activeRun?.expert_outputs || [];
  const canWrite = Boolean(auth && !auth.is_viewer);

  async function bootstrap() {
    try {
      setLoading(true);
      const [me, sessionList, health, agentList, docList] = await Promise.all([
        api.get("/api/auth/me"),
        api.get("/api/chat/sessions"),
        api.get("/api/runtime/health"),
        api.get("/api/agents"),
        api.get("/api/documents")
      ]);
      const metricData = me.is_admin ? await api.get("/api/admin/metrics") : emptyMetrics();
      setAuth(me);
      setRuntime(health);
      setAgents(agentList.agents);
      setDocuments(docList.documents);
      setMetrics(metricData);
      let nextSession = sessionList.sessions[0];
      if (!nextSession && !me.is_viewer) {
        nextSession = await api.post("/api/chat/sessions", { title: "New chat", visibility: "private" });
      }
      setSessions(sessionList.sessions.length ? sessionList.sessions : nextSession ? [nextSession] : []);
      if (nextSession) {
        await openSession(nextSession.session_id);
      } else {
        setSession(null);
        setMessages([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshSidebar() {
    const [me, sessionList, agentList, docList, health] = await Promise.all([
      api.get("/api/auth/me"),
      api.get("/api/chat/sessions"),
      api.get("/api/agents"),
      api.get("/api/documents"),
      api.get("/api/runtime/health")
    ]);
    const metricData = me.is_admin ? await api.get("/api/admin/metrics") : emptyMetrics();
    setAuth(me);
    setSessions(sessionList.sessions);
    setAgents(agentList.agents);
    setDocuments(docList.documents);
    setMetrics(metricData);
    setRuntime(health);
  }

  async function openSession(sessionId) {
    const payload = await api.get(`/api/chat/sessions/${sessionId}`);
    setSession(payload);
    setMessages(payload.messages);
    const latestRunId = [...payload.messages].reverse().find((message) => message.run_id)?.run_id;
    if (latestRunId) {
      await loadRun(latestRunId);
    } else {
      setActiveRun(null);
      setRunEvents([]);
    }
  }

  async function newChat() {
    if (!canWrite) return;
    try {
      const created = await api.post("/api/chat/sessions", { title: "New chat", visibility: "private" });
      await refreshSidebar();
      await openSession(created.session_id);
    } catch (err) {
      setError(err.message);
    }
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || !session || !canWrite) return;
    setDraft("");
    setError("");
    const optimistic = {
      message_id: `local_${Date.now()}`,
      role: "user",
      content,
      created_at: new Date().toISOString()
    };
    setMessages((items) => [...items, optimistic]);
    try {
      const queued = await api.post(`/api/chat/sessions/${session.session_id}/messages`, {
        content,
        attachments: [],
        options: {
          show_route_details: true
        }
      });
      subscribeRun(queued.run_id);
    } catch (err) {
      setError(err.message);
      setDraft(content);
    }
  }

  function subscribeRun(runId) {
    setRunEvents([]);
    const source = new EventSource(`/api/chat/runs/${runId}/events`);
    source.onmessage = async (message) => {
      const event = JSON.parse(message.data);
      setRunEvents((items) => [...items, event]);
      if (event.type === "planner.completed" || event.type === "route.completed" || event.type === "final.completed" || event.type === "run.failed") {
        await loadRun(runId);
      }
      if (event.type === "final.completed" || event.type === "run.failed") {
        source.close();
        await openSession(session.session_id);
        await refreshSidebar();
      }
    };
    source.onerror = () => {
      source.close();
      loadRun(runId).catch(() => undefined);
    };
  }

  async function loadRun(runId) {
    const run = await api.get(`/api/chat/runs/${runId}`);
    setActiveRun(run);
    setRunEvents(run.events || []);
    return run;
  }

  async function regenerate() {
    if (!canWrite) return;
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (lastUser) {
      setDraft(lastUser.content);
    }
  }

  async function copyAnswer() {
    const text = activeRun?.final_answer || messages.findLast?.((message) => message.role === "assistant")?.content || "";
    if (text) {
      await navigator.clipboard.writeText(text);
    }
  }

  function exportMarkdown() {
    const latestAnswer = activeRun?.final_answer || [...messages].reverse().find((message) => message.role === "assistant")?.content || "";
    if (!latestAnswer) return;
    const markdown = [
      `# ${session?.title || "TCAR chat export"}`,
      "",
      "## Answer",
      latestAnswer,
      "",
      "## Routes",
      ...(activeRun?.expert_outputs || []).map((route) => `- ${route.adapter}: ${route.domain_answer}`),
      "",
      "## Sources",
      ...((activeRun?.sources || []).map((source) => `- ${source.title} (${source.chunk_id}): ${source.path}`))
    ].join("\n");
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(session?.title || "tcar-chat").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function flagResponse() {
    if (!activeRun?.run_id) return;
    const reason = window.prompt("What was wrong with this response?");
    if (reason === null) return;
    try {
      await api.post(`/api/chat/runs/${activeRun.run_id}/feedback`, { rating: "bad", reason });
      await refreshSidebar();
    } catch (err) {
      setError(err.message);
    }
  }

  async function archiveAgent(agent) {
    if (!window.confirm(`Archive ${agent.title || agent.id}?`)) return;
    try {
      setError("");
      await api.delete(`/api/agents/${encodeURIComponent(agent.id)}`);
      if (agentEditor?.agent?.id === agent.id) {
        setAgentEditor(null);
      }
      await refreshSidebar();
    } catch (err) {
      setError(err.message);
    }
  }

  const statusText = useMemo(() => {
    if (!activeRun) return "Ready";
    if (activeRun.status === "queued") return "Queued";
    if (activeRun.status === "planning") return "Planning routes";
    if (activeRun.status === "synthesizing") return "Synthesizing final answer";
    if (activeRun.status === "completed") return "Completed";
    if (activeRun.status === "failed") return "Failed";
    return "Running selected routes";
  }, [activeRun]);

  function usePrompt(prompt) {
    if (!canWrite) return;
    setDraft(prompt);
  }

  return (
    <div className={`app-shell ${showInspector ? "" : "inspector-closed"}`}>
      <aside className="sidebar" aria-label="Conversations">
        <div className="brand">
          <div className="brand-mark"><Route size={22} /></div>
          <div>
            <strong>TCAR Chat</strong>
            <span>Agent orchestration</span>
          </div>
          <i className={`brand-signal ${runtime?.ok === false ? "offline" : ""}`} aria-hidden="true" />
        </div>

        <button className="primary-action" onClick={newChat} disabled={!canWrite} title={canWrite ? "Create a private conversation" : "Viewer role is read-only"}>
          <MessageSquarePlus size={17} />
          New chat
        </button>

        <div className="sidebar-section">
          <div className="section-label">Conversations</div>
          <div className="conversation-list">
            {sessions.map((item) => (
              <button
                className={`conversation-row ${session?.session_id === item.session_id ? "active" : ""}`}
                key={item.session_id}
                onClick={() => openSession(item.session_id)}
              >
                <MessageSquarePlus size={15} />
                <span>{item.title}</span>
                <small>{item.message_count}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="sidebar-footer">
          <SystemFabric agents={agents} documents={documents} runtime={runtime} metrics={metrics} />
          <AccessProfile auth={auth} />
        </div>
      </aside>

      <main className="chat-workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">Active chat workspace</div>
            <h1 title={session?.title || "TCAR Agent Router Chat"}>{session?.title || "TCAR Agent Router Chat"}</h1>
            <div className="session-meta">
              <span><LockKeyhole size={12} />{session?.visibility === "team" ? "Team" : session?.visibility === "global" ? "Global" : "Private"} session</span>
              <span>{messages.length} messages</span>
            </div>
          </div>
          <div className="topbar-actions">
            <RoleBadge auth={auth} compact />
            <StatusPill status={activeRun?.status} label={statusText} />
            <button className="icon-button" title="Copy latest answer" onClick={copyAnswer}>
              <Copy size={18} />
            </button>
            <button className="icon-button" title="Export markdown" onClick={exportMarkdown}>
              <Download size={18} />
            </button>
            <button className="icon-button" title={canWrite ? "Flag response" : "Viewer role is read-only"} onClick={flagResponse} disabled={!canWrite}>
              <AlertTriangle size={18} />
            </button>
            <button className="icon-button" title={canWrite ? "Regenerate from latest user message" : "Viewer role is read-only"} onClick={regenerate} disabled={!canWrite}>
              <RefreshCcw size={18} />
            </button>
            <button className="icon-button" title="Toggle inspector" onClick={() => setShowInspector((value) => !value)}>
              <PanelRightOpen size={18} />
            </button>
          </div>
        </header>

        {error && (
          <div className="error-banner">
            <AlertTriangle size={17} />
            {error}
          </div>
        )}

        <section className="message-thread" ref={threadRef} aria-live="polite">
          {loading && <EmptyState title="Loading workspace" text="Preparing sessions, agents, documents, and runtime health." />}
          {!loading && messages.length === 0 && (
            <WorkspaceEmptyState
              auth={auth}
              agents={agents}
              documents={documents}
              runtime={runtime}
              onPrompt={usePrompt}
            />
          )}
          {messages.map((message) => (
            <MessageBubble key={message.message_id} message={message} />
          ))}
          {activeRun && activeRun.status !== "completed" && activeRun.status !== "failed" && (
            <div className="assistant-pending">
              <Loader2 className="spin" size={18} />
              <span>{statusText}</span>
            </div>
          )}
        </section>

        <form className="composer" onSubmit={sendMessage}>
          <div className="composer-context">
            <span><ShieldCheck size={13} />Server-secured</span>
            <span><Boxes size={13} />{agents.length} routes available</span>
          </div>
          <button type="button" className="icon-button" title={canWrite ? "Upload document" : "Viewer role is read-only"} onClick={() => setUploadOpen(true)} disabled={!canWrite}>
            <Upload size={18} />
          </button>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage(event);
              }
            }}
            placeholder={canWrite ? "Ask TCAR anything..." : "Viewer access is read-only"}
            rows={1}
            maxLength={12000}
            disabled={!canWrite}
          />
          <button className="send-button" type="submit" disabled={!draft.trim() || !canWrite} title="Send message">
            <Send size={18} />
          </button>
        </form>
      </main>

      {showInspector && (
        <aside className="inspector" aria-label="Execution inspector">
          <GraphPanel
            run={activeRun}
            events={runEvents}
            routes={selectedRoutes}
            sources={selectedSources}
            agents={agents}
            documents={documents}
            runtime={runtime}
            metrics={metrics}
            auth={auth}
            onCreateAgent={() => setAgentEditor({ mode: "create", agent: null })}
            onEditAgent={(agent) => setAgentEditor({ mode: "edit", agent })}
            onArchiveAgent={archiveAgent}
            onCreateDocument={() => setUploadOpen(true)}
            onRefresh={refreshSidebar}
            onClose={() => setShowInspector(false)}
          />
        </aside>
      )}

      {uploadOpen && (
        <DocumentUploadDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={async () => {
            setUploadOpen(false);
            await refreshSidebar();
          }}
        />
      )}

      {agentEditor && (
        <AgentDialog
          auth={auth}
          agent={agentEditor.agent}
          onClose={() => setAgentEditor(null)}
          onSaved={async () => {
            setAgentEditor(null);
            await refreshSidebar();
          }}
        />
      )}
    </div>
  );
}

function SystemFabric({ agents, documents, runtime, metrics }) {
  const simulator = String(runtime?.vllm?.mode || "").toLowerCase().includes("simulator");
  const runtimeReady = runtime?.ok !== false && (simulator || runtime?.vllm?.models_endpoint_ok !== false);
  const metricValue = metrics?.admin_available === false ? "Gated" : String(metrics?.total_runs ?? 0);
  return (
    <section className="system-fabric" aria-label="System fabric">
      <div className="section-label">System fabric</div>
      <div className="fabric-grid">
        <SystemSignal icon={<Network size={15} />} label="Routes" value={agents.length} tone="green" />
        <SystemSignal icon={<FileText size={15} />} label="Docs" value={documents.length} tone="amber" />
        <SystemSignal icon={<Cpu size={15} />} label="Runtime" value={runtimeReady ? "Ready" : "Degraded"} tone={runtimeReady ? "cyan" : "danger"} />
        <SystemSignal icon={<Activity size={15} />} label="Runs" value={metricValue} tone="coral" />
      </div>
    </section>
  );
}

function SystemSignal({ icon, label, value, tone }) {
  return (
    <div className={`system-signal ${tone}`}>
      <span className="signal-icon">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function roleDetails(auth) {
  if (auth?.is_admin) {
    return {
      label: "Admin",
      scope: "Workspace control",
      icon: ShieldCheck,
      permissions: ["Agents", "Validation", "Metrics"]
    };
  }
  if (auth?.is_viewer) {
    return {
      label: "Viewer",
      scope: "Read-only access",
      icon: Eye,
      permissions: ["Chats", "Runs", "Sources"]
    };
  }
  return {
    label: "User",
    scope: "Private workspace",
    icon: UserRound,
    permissions: ["Chat", "Private agents", "Documents"]
  };
}

function RoleBadge({ auth, compact = false }) {
  const details = roleDetails(auth);
  const Icon = details.icon;
  return (
    <div className={`role-badge ${compact ? "compact" : ""}`} title={`${details.label}: ${details.scope}`}>
      <Icon size={compact ? 14 : 16} />
      <span>{details.label}</span>
    </div>
  );
}

function AccessProfile({ auth }) {
  const details = roleDetails(auth);
  const Icon = details.icon;
  const initials = String(auth?.user_id || "local user")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <section className="access-profile" aria-label="Authentication and role">
      <div className="access-head">
        <div className="access-avatar">{initials || <Icon size={16} />}</div>
        <div>
          <strong>{auth?.user_id || "Local user"}</strong>
          <span>{details.scope}</span>
        </div>
        <RoleBadge auth={auth} compact />
      </div>
      <div className="permission-row" aria-label={`${details.label} permissions`}>
        {details.permissions.map((permission) => <span key={permission}>{permission}</span>)}
      </div>
      <div className="auth-method">
        <KeyRound size={13} />
        <span>{auth?.auth_type || "local session"}</span>
        <small>{auth?.workspace_id || "workspace_default"}</small>
      </div>
    </section>
  );
}

function StatusPill({ status, label }) {
  const isBusy = ["queued", "planning", "synthesizing", "running"].includes(status);
  return (
    <div className={`status-pill ${status || "ready"}`}>
      {isBusy ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
      {label}
    </div>
  );
}

function EmptyState({ title, text }) {
  return (
    <div className="empty-state">
      <Route size={28} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

function WorkspaceEmptyState({ auth, agents, documents, runtime, onPrompt }) {
  const runtimeReady = runtime?.ok !== false;
  if (auth?.is_viewer) {
    return (
      <div className="empty-state viewer-empty">
        <Eye size={28} />
        <strong>No accessible conversation</strong>
        <p>Viewer role: chats, runs, and sources.</p>
      </div>
    );
  }
  return (
    <section className="workspace-empty" aria-label="Start a routed analysis">
      <div className="orchestration-visual" aria-hidden="true">
        <div className="visual-node request"><MessageSquarePlus size={18} /></div>
        <i />
        <div className="visual-node routes"><Network size={19} /></div>
        <i />
        <div className="visual-node synthesis"><Sparkles size={18} /></div>
      </div>
      <div className="empty-heading">
        <span>Routed workspace</span>
        <h2>Start a multi-agent analysis</h2>
      </div>
      <div className="empty-stats" aria-label="Available system resources">
        <span><strong>{agents.length}</strong> specialists</span>
        <span><strong>{documents.length}</strong> knowledge agents</span>
        <span className={runtimeReady ? "ready" : "degraded"}><strong>{runtimeReady ? "Live" : "Check"}</strong> runtime</span>
      </div>
      <div className="prompt-grid">
        {PROMPT_PRESETS.map(({ icon: Icon, title, meta, prompt }) => (
          <button type="button" className="prompt-option" key={title} onClick={() => onPrompt(prompt)}>
            <Icon size={17} />
            <span><strong>{title}</strong><small>{meta}</small></span>
            <span className="prompt-arrow">+</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function MessageBubble({ message }) {
  return (
    <article className={`message ${message.role}`}>
      <div className="avatar">{message.role === "user" ? "U" : <Bot size={17} />}</div>
      <div className="message-body">
        <div className="message-role">{message.role === "user" ? "You" : "TCAR"}</div>
        <div className="message-content">{message.content}</div>
      </div>
    </article>
  );
}

function GraphPanel({ run, events, routes, sources, agents, documents, runtime, metrics, auth, onCreateAgent, onEditAgent, onArchiveAgent, onCreateDocument, onRefresh, onClose }) {
  const [nodePositions, setNodePositions] = useState({});
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [activeView, setActiveView] = useState("graph");
  const [validation, setValidation] = useState(null);
  const latestEvent = events.at(-1);
  const baseGraph = useMemo(
    () => buildGraphModel({ run, routes, sources, agents, documents, runtime }),
    [run, routes, sources, agents, documents, runtime]
  );
  const graph = useMemo(() => applyNodePositions(baseGraph, nodePositions), [baseGraph, nodePositions]);
  const canWrite = !auth?.is_viewer;

  async function runValidation() {
    if (!auth?.is_admin) return;
    const queued = await api.post("/api/admin/validation/run", { suite: "mock_smoke", case_filter: "patient_newsletter_faq" });
    let result = queued;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      result = await api.get(`/api/admin/validation/runs/${queued.validation_run_id}`);
      if (result.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    setValidation(result);
    await onRefresh();
  }

  return (
    <div className="panel-body graph-panel">
      <div className="inspector-heading">
        <PanelHeader
          icon={<Network size={18} />}
          title="Execution fabric"
          subtitle={run ? `${graph.activeCount} selected routes / ${graph.edges.length} connections` : `${agents.length} routes available / ${documents.length} knowledge agents`}
        />
        <button className="icon-button inspector-close" type="button" title="Close inspector" onClick={onClose}>
          <X size={17} />
        </button>
      </div>

      <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
        <button type="button" role="tab" aria-selected={activeView === "graph"} className={activeView === "graph" ? "active" : ""} onClick={() => setActiveView("graph")}>
          <Workflow size={15} />Graph
        </button>
        <button type="button" role="tab" aria-selected={activeView === "agents"} className={activeView === "agents" ? "active" : ""} onClick={() => setActiveView("agents")}>
          <Bot size={15} />Agents <span>{agents.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeView === "ops"} className={activeView === "ops" ? "active" : ""} onClick={() => setActiveView("ops")}>
          <Activity size={15} />Ops
        </button>
      </div>

      {activeView === "graph" && (
        <div className="inspector-view graph-view" role="tabpanel">
          <div className="graph-toolbar">
            <div className={`live-state ${run?.status || "ready"}`}>
              <i />
              <span>{run ? run.status : "Topology ready"}</span>
            </div>
            <span>{graph.layers} execution stages</span>
            <button type="button" className="catalog-icon" title="Reset node positions" onClick={() => setNodePositions({})}>
              <RefreshCcw size={14} />
            </button>
          </div>
          <GraphCanvas
            graph={graph}
            hoveredNodeId={hoveredNodeId}
            selectedNodeId={selectedNodeId}
            onHoverNode={setHoveredNodeId}
            onSelectNode={setSelectedNodeId}
            onMoveNode={(nodeId, position) => {
              setNodePositions((current) => ({ ...current, [nodeId]: position }));
            }}
            metrics={metrics}
            validation={validation}
            latestEvent={latestEvent}
          />
          <div className="graph-legend">
            <span><i className="legend-dot route" />selected route</span>
            <span><i className="legend-dot runtime" />GPU runtime</span>
            <span><i className="legend-dot agent" />standby route</span>
            <span><i className="legend-dot source" />knowledge</span>
          </div>
        </div>
      )}

      {activeView === "agents" && (
        <div className="inspector-view" role="tabpanel">
          <div className="graph-actions" aria-label="Agent actions">
            <button className="graph-action" title={auth?.is_admin ? "Create agent" : "Create private agent"} onClick={onCreateAgent} disabled={!canWrite}>
              <Plus size={18} />
              <span>Agent</span>
            </button>
            <button className="graph-action" title="Register document agent" onClick={onCreateDocument} disabled={!canWrite}>
              <FilePlus size={18} />
              <span>Document</span>
            </button>
          </div>
          <AgentCatalog agents={agents} auth={auth} onEdit={onEditAgent} onArchive={onArchiveAgent} />
        </div>
      )}

      {activeView === "ops" && (
        <div className="inspector-view" role="tabpanel">
          <button className="validation-action" title={auth?.is_admin ? "Run validation" : "Admin only"} onClick={runValidation} disabled={!auth?.is_admin}>
            <Clipboard size={16} />
            <span>Run validation suite</span>
          </button>
          <OperationsPanel
            run={run}
            events={events}
            latestEvent={latestEvent}
            agents={agents}
            documents={documents}
            metrics={metrics}
            runtime={runtime}
            validation={validation}
          />
        </div>
      )}
    </div>
  );
}

function AgentCatalog({ agents, auth, onEdit, onArchive }) {
  const [query, setQuery] = useState("");
  const canManage = (agent) => auth?.is_admin || (!auth?.is_viewer &&
    agent.visibility === "private" &&
    agent.created_by === auth?.user_id &&
    agent.workspace_id === auth?.workspace_id
  );
  const ordered = [...agents].filter((agent) => {
    const searchText = `${agent.id} ${agent.title || ""} ${agent.capability || ""}`.toLowerCase();
    return !query || searchText.includes(query.toLowerCase());
  }).sort((left, right) => {
    const ownershipOrder = Number(canManage(right)) - Number(canManage(left));
    return ownershipOrder || String(left.title || left.id).localeCompare(String(right.title || right.id));
  });
  return (
    <section className="agent-catalog" aria-label="Agent catalog">
      <div className="catalog-heading">
        <strong>Route catalog</strong>
        <span>{ordered.length} of {agents.length}</span>
      </div>
      <label className="catalog-search">
        <Search size={15} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search routes" />
      </label>
      <div className="catalog-list">
        {ordered.map((agent) => {
          const manageable = canManage(agent);
          const archived = agent.enabled === false;
          return (
            <div className="catalog-row" key={agent.id}>
              <i className={`catalog-status ${archived ? "archived" : agent.mounted === false ? "pending" : "mounted"}`} />
              <div className="catalog-copy">
                <strong>{agent.title || agent.id}</strong>
                <span>{agent.capability || agent.id}</span>
                <small className={`visibility-chip ${agent.visibility || "global"}`}>{archived ? "Archived" : agent.visibility === "private" ? "Private" : agent.visibility === "team" ? "Team" : "Global"}</small>
              </div>
              {manageable && (
                <div className="catalog-actions">
                  <button
                    type="button"
                    className="catalog-icon"
                    title={`Edit ${agent.title || agent.id}`}
                    aria-label={`Edit ${agent.title || agent.id}`}
                    onClick={() => onEdit(agent)}
                    disabled={archived}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="catalog-icon archive"
                    title={`Archive ${agent.title || agent.id}`}
                    aria-label={`Archive ${agent.title || agent.id}`}
                    onClick={() => onArchive(agent)}
                    disabled={archived}
                  >
                    <Archive size={15} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const GRAPH_WIDTH = 420;
const GRAPH_HEIGHT = 620;

function GraphCanvas({ graph, hoveredNodeId, selectedNodeId, onHoverNode, onSelectNode, onMoveNode, metrics, validation, latestEvent }) {
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const candidateNodeId = hoveredNodeId || selectedNodeId;
  const activeNodeId = graph.nodeMap.has(candidateNodeId) ? candidateNodeId : null;
  const activeNode = activeNodeId ? graph.nodeMap.get(activeNodeId) : null;

  function pointFromEvent(event) {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * GRAPH_WIDTH,
      y: ((event.clientY - rect.top) / rect.height) * GRAPH_HEIGHT
    };
  }

  function clampNode(node, position) {
    return {
      x: Math.min(GRAPH_WIDTH - 18 - node.r, Math.max(18 + node.r, position.x)),
      y: Math.min(GRAPH_HEIGHT - 28 - node.r, Math.max(28 + node.r, position.y))
    };
  }

  function startDrag(event, node) {
    event.preventDefault();
    const point = pointFromEvent(event);
    svgRef.current.setPointerCapture(event.pointerId);
    setDrag({
      nodeId: node.id,
      pointerId: event.pointerId,
      offsetX: point.x - node.x,
      offsetY: point.y - node.y
    });
    onHoverNode(node.id);
    onSelectNode(node.id);
  }

  function moveDrag(event) {
    if (!drag) return;
    const node = graph.nodeMap.get(drag.nodeId);
    if (!node) return;
    const point = pointFromEvent(event);
    onMoveNode(drag.nodeId, clampNode(node, { x: point.x - drag.offsetX, y: point.y - drag.offsetY }));
  }

  function endDrag(event) {
    if (!drag) return;
    if (svgRef.current.hasPointerCapture(drag.pointerId)) {
      svgRef.current.releasePointerCapture(drag.pointerId);
    }
    setDrag(null);
    onHoverNode(event.currentTarget.matches(":hover") ? drag.nodeId : null);
  }

  function nudgeNode(event, node) {
    const step = event.shiftKey ? 18 : 8;
    const deltas = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step }
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    onMoveNode(node.id, clampNode(node, { x: node.x + delta.x, y: node.y + delta.y }));
  }

  return (
    <div className="graph-canvas" role="group" aria-label="TCAR route graph">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <pattern id="graph-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" className="graph-grid-line" />
          </pattern>
          <filter id="node-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,3.5 L0,7 Z" />
          </marker>
        </defs>
        <rect className="graph-grid" width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="url(#graph-grid)" />
        <text className="graph-zone-label" x="22" y="32">REQUEST</text>
        <text className="graph-zone-label" x="22" y="152">{graph.routeZoneLabel}</text>
        {graph.standbyCount > 0 && <text className="graph-zone-label" x="22" y="555">STANDBY FABRIC</text>}
        <line className="graph-lane" x1="20" y1="126" x2="400" y2="126" />
        {graph.standbyCount > 0 && <line className="graph-lane" x1="20" y1="535" x2="400" y2="535" />}
        {graph.edges.map((edge, index) => {
          const source = graph.nodeMap.get(edge.source);
          const target = graph.nodeMap.get(edge.target);
          if (!source || !target) return null;
          const pathId = edgePathId(edge, index);
          const connected = !activeNodeId || edge.source === activeNodeId || edge.target === activeNodeId;
          return (
            <path
              key={pathId}
              id={pathId}
              className={`graph-edge ${edge.kind || ""} ${connected ? "connected" : "muted"}`}
              d={graphEdgePath(source, target, edge.kind)}
              markerEnd={edge.directed ? "url(#arrow)" : undefined}
            />
          );
        })}
        {graph.isActive && graph.edges.map((edge, index) => {
          const source = graph.nodeMap.get(edge.source);
          const target = graph.nodeMap.get(edge.target);
          if (!source || !target) return null;
          const pathId = edgePathId(edge, index);
          return (
            <circle key={`pulse-${pathId}`} className={`edge-pulse ${edge.kind || ""}`} r={edge.kind === "dependency" ? 3.3 : 2.7}>
              <animateMotion
                dur={`${1.35 + (index % 4) * 0.18}s`}
                begin={`${index * 0.11}s`}
                repeatCount="indefinite"
              >
                <mpath href={`#${pathId}`} />
              </animateMotion>
            </circle>
          );
        })}
        {graph.nodes.map((node) => (
          <g
            key={node.id}
            className={`graph-node ${node.type} ${node.status || ""} ${graph.isActive && node.type === "route" ? "firing" : ""} ${drag?.nodeId === node.id ? "dragging" : ""} ${activeNodeId === node.id ? "selected" : ""}`}
            transform={`translate(${node.x} ${node.y})`}
            tabIndex={0}
            role="button"
            aria-label={node.label}
            aria-pressed={selectedNodeId === node.id}
            onPointerDown={(event) => startDrag(event, node)}
            onClick={() => onSelectNode(selectedNodeId === node.id ? null : node.id)}
            onPointerEnter={() => onHoverNode(node.id)}
            onPointerLeave={() => {
              if (!drag) onHoverNode(null);
            }}
            onFocus={() => onHoverNode(node.id)}
            onBlur={() => {
              if (!drag) onHoverNode(null);
            }}
            onKeyDown={(event) => nudgeNode(event, node)}
          >
            <circle className="node-ring" r={node.r + 6} />
            {node.type === "chat" || node.type === "runtime" ? (
              <rect className="node-core" x={-node.r * 1.24} y={-node.r * 0.78} width={node.r * 2.48} height={node.r * 1.56} rx="10" />
            ) : node.type === "document" || node.type === "source" ? (
              <rect className="node-core" x={-node.r} y={-node.r} width={node.r * 2} height={node.r * 2} rx="7" />
            ) : (
              <circle className="node-core" r={node.r} />
            )}
            <text className="node-monogram" y="3">{node.shortLabel}</text>
            <circle className="node-status" cx={node.r * 0.78} cy={-node.r * 0.72} r="3.5" />
            {node.showLabel !== false && <text className="node-name" y={node.r + 18}>{node.displayLabel || node.label}</text>}
          </g>
        ))}
      </svg>
      {activeNode && (
        <GraphNodePopover
          node={activeNode}
          metrics={metrics}
          validation={validation}
          latestEvent={latestEvent}
        />
      )}
    </div>
  );
}

function graphEdgePath(source, target, kind) {
  if (kind === "runtime") {
    const midX = (source.x + target.x) / 2;
    return `M ${source.x} ${source.y} C ${midX} ${source.y}, ${midX} ${target.y}, ${target.x} ${target.y}`;
  }
  const direction = target.y >= source.y ? 1 : -1;
  const offset = Math.max(28, Math.abs(target.y - source.y) * 0.48) * direction;
  return `M ${source.x} ${source.y} C ${source.x} ${source.y + offset}, ${target.x} ${target.y - offset}, ${target.x} ${target.y}`;
}

function OperationsPanel({ run, events, latestEvent, agents, documents, metrics, runtime, validation }) {
  const mountedAgents = agents.filter((agent) => agent.mounted !== false).length;
  const topAgents = metrics?.most_used_agents?.slice?.(0, 3) || [];
  const runStatus = run?.status || "ready";
  const metricsAvailable = metrics?.admin_available !== false;
  const recentEvents = (events?.length ? events : latestEvent ? [latestEvent] : []).slice(-5);
  return (
    <div className="ops-panel" aria-label="Runtime operations">
      <div className="ops-grid">
        <Metric label="Agents" value={`${mountedAgents}/${agents.length}`} />
        <Metric label="Docs" value={documents.length} />
        <Metric label="Runs" value={metricsAvailable ? (metrics?.total_runs ?? 0) : "n/a"} />
        <Metric label="p95" value={metricsAvailable ? `${metrics?.p95_end_to_end_latency ?? 0}s` : "n/a"} />
      </div>

      <div className="ops-strip">
        <div>
          <span>Run</span>
          <strong>{runStatus}</strong>
        </div>
        <div>
          <span>Runtime</span>
          <strong>{runtime?.vllm?.models_endpoint_ok === false || runtime?.router?.models_endpoint_ok === false ? "degraded" : runtime?.ok === false ? "offline" : "ready"}</strong>
        </div>
        <div>
          <span>Event</span>
          <strong>{latestEvent?.type || "idle"}</strong>
        </div>
      </div>

      {recentEvents.length > 0 && (
        <div className="signal-trail" aria-label="Execution event trail">
          {recentEvents.map((event, index) => (
            <div className="signal-step" key={`${event.type}-${event.ts || index}-${index}`}>
              <span />
              <strong>{event.type}</strong>
            </div>
          ))}
        </div>
      )}

      {topAgents.length > 0 && (
        <div className="agent-signal-list">
          {topAgents.map((agent) => (
            <div className="agent-signal" key={agent.adapter || agent.agent_id || agent.id}>
              <span>{agent.adapter || agent.agent_id || agent.id}</span>
              <strong>{agent.count}</strong>
            </div>
          ))}
        </div>
      )}

      {validation && (
        <div className={`validation-chip ${validation.ok ? "ok" : ""}`}>
          <CheckCircle2 size={15} />
          <span>{validation.status}</span>
        </div>
      )}
    </div>
  );
}

function GraphNodePopover({ node, metrics, validation, latestEvent }) {
  const data = node.data || {};
  const style = {
    left: `${(node.x / GRAPH_WIDTH) * 100}%`,
    top: `${(node.y / GRAPH_HEIGHT) * 100}%`
  };
  const edgeClass = [
    node.x > GRAPH_WIDTH * 0.68 ? "near-right" : "",
    node.x < GRAPH_WIDTH * 0.32 ? "near-left" : "",
    node.y > GRAPH_HEIGHT * 0.72 ? "near-bottom" : "",
    node.y < GRAPH_HEIGHT * 0.2 ? "near-top" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className={`graph-popover ${edgeClass}`} style={style}>
      <div className="graph-detail-head">
        <span className={`node-chip ${node.type}`}>{node.type}</span>
        <strong>{node.label}</strong>
      </div>

      {node.type === "chat" && (
        <div className="metric-grid">
          <Metric label="Runs" value={metrics?.admin_available === false ? "n/a" : (metrics?.total_runs ?? 0)} />
          <Metric label="p95" value={metrics?.admin_available === false ? "n/a" : `${metrics?.p95_end_to_end_latency ?? 0}s`} />
          <Metric label="Flags" value={metrics?.admin_available === false ? "n/a" : (metrics?.bad_response_flags ?? 0)} />
          <Metric label="Latest" value={latestEvent?.type || "ready"} />
        </div>
      )}

      {node.type === "route" && (
        <>
          <p>{data.step?.task || data.route?.task}</p>
          <div className="route-meta">
            <span>Status: {data.route?.status || node.status || "planned"}</span>
            <span>Depends on: {data.step?.depends_on?.length ? data.step.depends_on.join(", ") : "none"}</span>
            <span>Tools: {data.route?.allowed_tools?.length ? data.route.allowed_tools.join(", ") : "none"}</span>
            <span>Sources: {data.route?.approved_sources?.length || data.route?.citations?.length || 0}</span>
          </div>
          {data.route?.domain_answer && <div className="route-answer">{data.route.domain_answer}</div>}
          {data.route?.boundary_check && <div className="boundary">{data.route.boundary_check}</div>}
          {data.route?.policy_violations?.length > 0 && (
            <div className="warning">
              <AlertTriangle size={15} />
              {data.route.policy_violations.join(", ")}
            </div>
          )}
        </>
      )}

      {node.type === "agent" && (
        <>
          <p>{data.agent?.title}</p>
          <div className="route-meta">
            <span>{data.agent?.mounted ? "mounted" : "reload needed"}</span>
            <span>Tools: {data.agent?.tools?.length ? data.agent.tools.join(", ") : "none"}</span>
            <span>Sources: {data.agent?.sources?.length || 0}</span>
          </div>
        </>
      )}

      {node.type === "document" && (
        <>
          <p>{data.document?.title}</p>
          <div className="route-meta">
            <span>Agent: {data.document?.agent_id}</span>
            <span>Chunks: {data.document?.chunks}</span>
            <span>{data.document?.visibility}</span>
          </div>
        </>
      )}

      {node.type === "source" && (
        <>
          <p>{data.source?.excerpt}</p>
          <div className="route-meta">
            <span>{data.source?.chunk_id}</span>
            <span>score {data.source?.score}</span>
            <span>{data.source?.path}</span>
          </div>
        </>
      )}

      {node.type === "runtime" && (
        <div className="runtime-details">
          <div><span>Base model</span><strong>{data.runtime?.vllm?.base_model}</strong></div>
          {data.runtime?.vllm?.base_url && <div><span>vLLM endpoint</span><strong>{data.runtime.vllm.base_url}</strong></div>}
          {data.runtime?.router && (
            <div><span>Router</span><strong>{data.runtime.router.model || data.runtime.router.mode}</strong></div>
          )}
          {data.runtime?.router?.base_url && <div><span>Router endpoint</span><strong>{data.runtime.router.base_url}</strong></div>}
          {data.runtime?.manifest?.path && <div><span>Manifest</span><strong>{data.runtime.manifest.path}</strong></div>}
          {validation && (
            <div className="validation-result">
              <strong>{validation.status}</strong>
              <span>{validation.ok ? "All mock gates passed" : "Validation still running"}</span>
              {validation.summary && <small>max batch width {validation.summary.maxParallelBatchWidth}</small>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function applyNodePositions(graph, positions) {
  const nodes = graph.nodes.map((node) => {
    const position = positions[node.id];
    return position ? { ...node, x: position.x, y: position.y } : node;
  });
  return {
    ...graph,
    nodes,
    nodeMap: new Map(nodes.map((node) => [node.id, node]))
  };
}

function buildGraphModel({ run, routes, sources, agents, documents, runtime }) {
  const nodes = [];
  const edges = [];
  const nodeMap = new Map();
  const addNode = (node) => {
    nodes.push(node);
    nodeMap.set(node.id, node);
  };
  const addEdge = (source, target, kind = "soft", directed = false) => {
    if (source !== target) edges.push({ source, target, kind, directed });
  };

  const routeByStep = new Map(routes.map((route) => [route.step_id, route]));
  const planSteps = run?.plan?.steps || [];
  const activeAdapters = new Set(planSteps.map((step) => step.adapter));
  const stepById = new Map(planSteps.map((step) => [step.id, step]));
  const depthMemo = new Map();
  const stepDepth = (step, visiting = new Set()) => {
    if (depthMemo.has(step.id)) return depthMemo.get(step.id);
    if (visiting.has(step.id) || !step.depends_on?.length) return 0;
    const nextVisiting = new Set(visiting).add(step.id);
    const depth = 1 + Math.max(...step.depends_on.map((id) => stepById.has(id) ? stepDepth(stepById.get(id), nextVisiting) : 0));
    depthMemo.set(step.id, depth);
    return depth;
  };
  const routeGroups = new Map();
  for (const step of planSteps) {
    const depth = stepDepth(step);
    routeGroups.set(depth, [...(routeGroups.get(depth) || []), step]);
  }
  const maxDepth = Math.max(0, ...routeGroups.keys());

  addNode({
    id: "chat",
    type: "chat",
    label: run?.status ? `Request / ${run.status}` : "Request",
    displayLabel: "User request",
    shortLabel: "IN",
    x: 210,
    y: 72,
    r: 27,
    status: run?.status || "ready",
    data: { run }
  });
  addNode({
    id: "router",
    type: "router",
    label: "Cue router",
    displayLabel: "Cue router",
    shortLabel: "R",
    x: 210,
    y: 145,
    r: 19,
    status: planSteps.length ? "complete" : "ready",
    data: { run }
  });
  addEdge("chat", "router", "activation", true);

  for (const [depth, steps] of [...routeGroups.entries()].sort(([left], [right]) => left - right)) {
    const y = 230 + (maxDepth ? (depth / maxDepth) * 190 : 0);
    const spacing = steps.length > 1 ? 300 / (steps.length - 1) : 0;
    steps.forEach((step, index) => {
      const route = routeByStep.get(step.id);
      const nodeId = `route:${step.id}`;
      const x = steps.length === 1 ? 210 : 60 + spacing * index;
      addNode({
        id: nodeId,
        type: "route",
        label: step.adapter,
        displayLabel: compactNodeLabel(step.adapter),
        shortLabel: shortNodeLabel(step.adapter),
        x,
        y,
        r: step.adapter === "writing_synthesis_lora" ? 27 : 23,
        status: route?.status || (run?.status === "completed" ? "complete" : "running"),
        data: { step, route }
      });
    });
  }

  for (const step of planSteps) {
    const target = `route:${step.id}`;
    if (step.depends_on?.length) {
      for (const dep of step.depends_on) addEdge(`route:${dep}`, target, "dependency", true);
    } else {
      addEdge("router", target, "activation", true);
    }
  }

  const agentNodes = agents.filter((agent) => !activeAdapters.has(agent.id));
  const visibleAgentLimit = planSteps.length ? 3 : 11;
  const visibleAgents = agentNodes.slice(0, visibleAgentLimit);
  visibleAgents.forEach((agent, index) => {
    const columns = planSteps.length ? Math.max(visibleAgents.length, 1) : 3;
    const x = planSteps.length ? 70 + index * 93 : 82 + (index % columns) * 128;
    const y = planSteps.length ? 574 : 235 + Math.floor(index / columns) * 78;
    const nodeId = `agent:${agent.id}`;
    addNode({
      id: nodeId,
      type: "agent",
      label: agent.id,
      displayLabel: compactNodeLabel(agent.id),
      shortLabel: shortNodeLabel(agent.id),
      x,
      y,
      r: planSteps.length ? 14 : 17,
      showLabel: !planSteps.length,
      status: agent.mounted ? "mounted" : "unmounted",
      data: { agent }
    });
    addEdge("router", nodeId, "catalog", false);
  });

  const remainingAgents = agentNodes.length - visibleAgents.length;
  if (remainingAgents > 0) {
    const index = visibleAgents.length;
    const columns = planSteps.length ? 4 : 3;
    const x = planSteps.length ? 70 + index * 93 : 82 + (index % columns) * 128;
    const y = planSteps.length ? 574 : 235 + Math.floor(index / columns) * 78;
    const aggregateId = "agent:remaining";
    addNode({
      id: aggregateId,
      type: "agent",
      label: `${remainingAgents} additional routes`,
      displayLabel: `${remainingAgents} more routes`,
      shortLabel: `+${remainingAgents}`,
      x,
      y,
      r: planSteps.length ? 14 : 17,
      showLabel: !planSteps.length,
      status: "mounted",
      data: { agent: { title: `${remainingAgents} additional mounted routes`, mounted: true, tools: [], sources: [] } }
    });
    addEdge("router", aggregateId, "catalog", false);
  }

  documents.slice(0, 4).forEach((document, index) => {
    const x = 34;
    const y = 210 + index * 66;
    const nodeId = `doc:${document.document_id}`;
    addNode({
      id: nodeId,
      type: "document",
      label: document.title,
      displayLabel: compactNodeLabel(document.title),
      shortLabel: "DOC",
      x,
      y,
      r: 14,
      showLabel: false,
      data: { document }
    });
    const routeStep = planSteps.find((step) => step.adapter === document.agent_id);
    const agentNode = nodeMap.has(`route:${routeStep?.id}`) ? `route:${routeStep.id}` : `agent:${document.agent_id}`;
    addEdge(nodeId, nodeMap.has(agentNode) ? agentNode : "router", "source", true);
  });

  sources.slice(0, 4).forEach((source, index) => {
    const x = 386;
    const y = 210 + index * 66;
    const nodeId = `source:${source.citation_id || source.chunk_id || index}`;
    addNode({
      id: nodeId,
      type: "source",
      label: source.title || source.chunk_id,
      displayLabel: compactNodeLabel(source.title || source.chunk_id),
      shortLabel: "SRC",
      x,
      y,
      r: 13,
      showLabel: false,
      data: { source }
    });
    const routeStep = planSteps.find((step) => step.id === source.step_id || step.adapter === source.agent_id);
    addEdge(nodeId, nodeMap.has(`route:${routeStep?.id}`) ? `route:${routeStep.id}` : "router", "source", true);
  });

  addNode({
    id: "runtime",
    type: "runtime",
    label: runtime?.vllm?.base_model || "Runtime",
    displayLabel: "GPU runtime",
    shortLabel: "GPU",
    x: 64,
    y: 72,
    r: 21,
    status: runtime?.ok ? "ready" : "failed",
    data: { runtime }
  });
  addEdge("runtime", "router", "runtime", false);

  return {
    nodes,
    edges: edges.filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target)),
    nodeMap,
    activeCount: planSteps.length,
    layers: planSteps.length ? maxDepth + 2 : 1,
    routeZoneLabel: planSteps.length ? "ACTIVE ROUTE DAG" : "AVAILABLE ROUTES",
    standbyCount: planSteps.length ? agentNodes.length : 0,
    isActive: Boolean(run && !["completed", "failed"].includes(run.status))
  };
}

function edgePathId(edge, index) {
  return `edge-${index}-${String(edge.source).replace(/[^a-z0-9_-]/gi, "_")}-${String(edge.target).replace(/[^a-z0-9_-]/gi, "_")}`;
}

function shortNodeLabel(label) {
  return String(label)
    .replace(/_lora$/, "")
    .split("_")
    .map((part) => part[0])
    .join("")
    .slice(0, 4)
    .toUpperCase();
}

function compactNodeLabel(label) {
  const normalized = String(label || "")
    .replace(/_lora$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return normalized.length > 20 ? `${normalized.slice(0, 19)}...` : normalized;
}

function PanelHeader({ icon, title, subtitle }) {
  return (
    <div className="panel-header">
      {icon}
      <div>
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function createAgentForm(agent = null) {
  if (agent) {
    return {
      id: agent.id,
      title: agent.title || "",
      capability: agent.capability || "",
      boundary: agent.boundary || "",
      routing_cues: (agent.routing_cues || []).join(", "),
      produces: (agent.produces || []).join(", "),
      tools: (agent.tools || []).join(", "),
      sources: (agent.sources || []).join(", "),
      source_text: ""
    };
  }
  const suffix = Date.now().toString(36).slice(-6);
  return {
    id: `custom_${suffix}_lora`,
    title: "",
    capability: "",
    boundary: "",
    routing_cues: "",
    produces: "",
    tools: "",
    sources: "",
    source_text: ""
  };
}

function DocumentUploadDialog({ onClose, onUploaded }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [routingCues, setRoutingCues] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (!file) {
      setError("Choose a PDF, Markdown, or text file.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("title", title || file.name.replace(/\.[^.]+$/, ""));
      form.append("routing_cues", routingCues || title || file.name);
      form.append("visibility", "private");
      await api.postForm("/api/documents", form);
      await onUploaded();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <form className="dialog" onSubmit={submit}>
        <PanelHeader icon={<FilePlus size={18} />} title="Register Document Agent" subtitle="PDF, Markdown, or text" />
        {error && <div className="field-error">{error}</div>}
        <label>
          File
          <input type="file" accept=".pdf,.md,.markdown,.txt" onChange={(event) => setFile(event.target.files?.[0] || null)} />
        </label>
        <label>
          Document name
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Linear algebra textbook" />
        </label>
        <label>
          Routing cues
          <textarea value={routingCues} onChange={(event) => setRoutingCues(event.target.value)} placeholder="rank-nullity, textbook, linear maps" />
        </label>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button className="send-button" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <Upload size={16} />}
            Upload
          </button>
        </div>
      </form>
    </div>
  );
}

function AgentDialog({ auth, agent, onClose, onSaved }) {
  const editing = Boolean(agent);
  const [form, setForm] = useState(() => createAgentForm(agent));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (editing) {
        const patch = { ...form };
        delete patch.id;
        if (!patch.source_text || agent?.document) delete patch.source_text;
        if (!auth?.is_admin) delete patch.sources;
        await api.patch(`/api/agents/${encodeURIComponent(agent.id)}`, patch);
      } else {
        await api.post("/api/agents", form);
      }
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <form className="dialog" onSubmit={submit}>
        <PanelHeader
          icon={<Bot size={18} />}
          title={editing ? `Edit ${agent.title || agent.id}` : auth?.is_admin ? "Create Custom Route" : "Create Private Agent"}
          subtitle={editing ? agent.id : "Prompt-defined zero-effect LoRA identity"}
        />
        {error && <div className="field-error">{error}</div>}
        <label>Adapter id<input value={form.id} onChange={(event) => update("id", event.target.value)} disabled={editing} /></label>
        <label>Title<input value={form.title} onChange={(event) => update("title", event.target.value)} /></label>
        <label>Capability<textarea value={form.capability} onChange={(event) => update("capability", event.target.value)} /></label>
        <label>Boundary<textarea value={form.boundary} onChange={(event) => update("boundary", event.target.value)} /></label>
        <label>Routing cues<textarea value={form.routing_cues} onChange={(event) => update("routing_cues", event.target.value)} /></label>
        <label>Produces<input value={form.produces} onChange={(event) => update("produces", event.target.value)} /></label>
        <label>Allowed tools<input value={form.tools} onChange={(event) => update("tools", event.target.value)} /></label>
        {!agent?.document && (
          <label>{editing ? "Replace private knowledge" : "Private knowledge"}<textarea value={form.source_text} onChange={(event) => update("source_text", event.target.value)} /></label>
        )}
        {auth?.is_admin && (
          <label>Approved sources<input value={form.sources} onChange={(event) => update("sources", event.target.value)} /></label>
        )}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="send-button" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : editing ? <Pencil size={16} /> : <Plus size={16} />}
            {editing ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
