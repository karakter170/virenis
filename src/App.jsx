import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clipboard,
  Copy,
  Download,
  FilePlus,
  FileText,
  Loader2,
  MessageSquarePlus,
  Network,
  PanelRightOpen,
  Plus,
  RefreshCcw,
  Route,
  Send,
  ShieldCheck,
  Upload
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
  async postForm(path, formData) {
    const response = await fetch(path, { method: "POST", body: formData });
    return parseResponse(response);
  }
};

async function parseResponse(response) {
  const payload = await response.json();
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
  const [activeRun, setActiveRun] = useState(null);
  const [runEvents, setRunEvents] = useState([]);
  const [draft, setDraft] = useState("");
  const [showInspector, setShowInspector] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
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

  async function bootstrap() {
    try {
      setLoading(true);
      const [sessionList, health, agentList, docList, metricData] = await Promise.all([
        api.get("/api/chat/sessions"),
        api.get("/api/runtime/health"),
        api.get("/api/agents"),
        api.get("/api/documents"),
        api.get("/api/admin/metrics")
      ]);
      setRuntime(health);
      setAgents(agentList.agents);
      setDocuments(docList.documents);
      setMetrics(metricData);
      let nextSession = sessionList.sessions[0];
      if (!nextSession) {
        nextSession = await api.post("/api/chat/sessions", { title: "New chat", visibility: "private" });
      }
      setSessions(sessionList.sessions.length ? sessionList.sessions : [nextSession]);
      await openSession(nextSession.session_id);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshSidebar() {
    const [sessionList, agentList, docList, metricData, health] = await Promise.all([
      api.get("/api/chat/sessions"),
      api.get("/api/agents"),
      api.get("/api/documents"),
      api.get("/api/admin/metrics"),
      api.get("/api/runtime/health")
    ]);
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
    if (!content || !session) return;
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
          show_route_details: true,
          planner_mode: "deterministic",
          max_routing_adapters: 12,
          parallel_workers: 2,
          temperature: 0
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

  const statusText = useMemo(() => {
    if (!activeRun) return "Ready";
    if (activeRun.status === "queued") return "Queued";
    if (activeRun.status === "planning") return "Planning routes";
    if (activeRun.status === "synthesizing") return "Synthesizing final answer";
    if (activeRun.status === "completed") return "Completed";
    if (activeRun.status === "failed") return "Failed";
    return "Running selected routes";
  }, [activeRun]);

  return (
    <div className={`app-shell ${showInspector ? "" : "inspector-closed"}`}>
      <aside className="sidebar" aria-label="Conversations">
        <div className="brand">
          <div className="brand-mark"><Route size={22} /></div>
          <div>
            <strong>TCAR Chat</strong>
            <span>Route-aware workspace</span>
          </div>
        </div>

        <button className="primary-action" onClick={newChat}>
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

        <div className="feature-stack" aria-label="Feature highlights">
          <Feature icon={<Network size={16} />} label="Parallel DAG execution" />
          <Feature icon={<ShieldCheck size={16} />} label="Tool and source policy checks" />
          <Feature icon={<FileText size={16} />} label="Document agents with citations" />
          <Feature icon={<Activity size={16} />} label="Runtime validation and metrics" />
        </div>
      </aside>

      <main className="chat-workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">Active chat workspace</div>
            <h1>{session?.title || "TCAR Agent Router Chat"}</h1>
          </div>
          <div className="topbar-actions">
            <StatusPill status={activeRun?.status} label={statusText} />
            <button className="icon-button" title="Copy latest answer" onClick={copyAnswer}>
              <Copy size={18} />
            </button>
            <button className="icon-button" title="Export markdown" onClick={exportMarkdown}>
              <Download size={18} />
            </button>
            <button className="icon-button" title="Flag response" onClick={flagResponse}>
              <AlertTriangle size={18} />
            </button>
            <button className="icon-button" title="Regenerate from latest user message" onClick={regenerate}>
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
            <EmptyState
              title="Ask one question. TCAR will route it."
              text="Try: Review a clinic patient newsletter signup flow for consent and patient privacy, suggest health-safe wording, and draft a customer support FAQ."
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
          <button type="button" className="icon-button" title="Upload document" onClick={() => setUploadOpen(true)}>
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
            placeholder="Message TCAR Agent Router Chat..."
            rows={1}
            maxLength={12000}
          />
          <button className="send-button" type="submit" disabled={!draft.trim()}>
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
            onCreateAgent={() => setAgentOpen(true)}
            onCreateDocument={() => setUploadOpen(true)}
            onRefresh={refreshSidebar}
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

      {agentOpen && (
        <AgentDialog
          onClose={() => setAgentOpen(false)}
          onCreated={async () => {
            setAgentOpen(false);
            await refreshSidebar();
          }}
        />
      )}
    </div>
  );
}

function Feature({ icon, label }) {
  return (
    <div className="feature-row">
      {icon}
      <span>{label}</span>
    </div>
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

function GraphPanel({ run, events, routes, sources, agents, documents, runtime, metrics, onCreateAgent, onCreateDocument, onRefresh }) {
  const [nodePositions, setNodePositions] = useState({});
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [validation, setValidation] = useState(null);
  const baseGraph = useMemo(
    () => buildGraphModel({ run, routes, sources, agents, documents, runtime }),
    [run, routes, sources, agents, documents, runtime]
  );
  const graph = useMemo(() => applyNodePositions(baseGraph, nodePositions), [baseGraph, nodePositions]);

  async function runValidation() {
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
      <PanelHeader
        icon={<Network size={18} />}
        title="Execution Graph"
        subtitle={run ? `${graph.activeCount} active nodes · ${graph.edges.length} links` : `${agents.length} agents · ${documents.length} documents`}
      />

      <div className="graph-actions" aria-label="Graph actions">
        <button className="graph-action" title="Create agent" onClick={onCreateAgent}>
          <Plus size={18} />
          <span>Agent</span>
        </button>
        <button className="graph-action" title="Register document agent" onClick={onCreateDocument}>
          <FilePlus size={18} />
          <span>Doc</span>
        </button>
        <button className="graph-action" title="Run validation" onClick={runValidation}>
          <Clipboard size={18} />
          <span>Check</span>
        </button>
      </div>

      <GraphCanvas
        graph={graph}
        hoveredNodeId={hoveredNodeId}
        onHoverNode={setHoveredNodeId}
        onMoveNode={(nodeId, position) => {
          setNodePositions((current) => ({ ...current, [nodeId]: position }));
        }}
        metrics={metrics}
        validation={validation}
        latestEvent={events.at(-1)}
      />

      <div className="graph-legend">
        <span><i className="legend-dot route" />active LoRA</span>
        <span><i className="legend-dot agent" />available agent</span>
        <span><i className="legend-dot document" />document</span>
        <span><i className="legend-dot source" />source</span>
      </div>
    </div>
  );
}

function GraphCanvas({ graph, hoveredNodeId, onHoverNode, onMoveNode, metrics, validation, latestEvent }) {
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const hoveredNode = hoveredNodeId ? graph.nodeMap.get(hoveredNodeId) : null;

  function pointFromEvent(event) {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 360,
      y: ((event.clientY - rect.top) / rect.height) * 560
    };
  }

  function clampNode(node, position) {
    return {
      x: Math.min(344 - node.r, Math.max(16 + node.r, position.x)),
      y: Math.min(544 - node.r, Math.max(16 + node.r, position.y))
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
    <div className="graph-canvas" role="img" aria-label="TCAR route graph">
      <svg
        ref={svgRef}
        viewBox="0 0 360 560"
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3.5" orient="auto">
            <path d="M0,0 L8,3.5 L0,7 Z" />
          </marker>
        </defs>
        {graph.edges.map((edge) => {
          const source = graph.nodeMap.get(edge.source);
          const target = graph.nodeMap.get(edge.target);
          if (!source || !target) return null;
          return (
            <line
              key={`${edge.source}-${edge.target}`}
              className={`graph-edge ${edge.kind || ""}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              markerEnd={edge.directed ? "url(#arrow)" : undefined}
            />
          );
        })}
        {graph.nodes.map((node) => (
          <g
            key={node.id}
            className={`graph-node ${node.type} ${node.status || ""} ${drag?.nodeId === node.id ? "dragging" : ""}`}
            tabIndex="0"
            role="button"
            aria-label={node.label}
            onPointerDown={(event) => startDrag(event, node)}
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
            <circle cx={node.x} cy={node.y} r={node.r} />
            <text x={node.x} y={node.y + 3}>{node.shortLabel}</text>
          </g>
        ))}
      </svg>
      {hoveredNode && (
        <GraphNodePopover
          node={hoveredNode}
          metrics={metrics}
          validation={validation}
          latestEvent={latestEvent}
        />
      )}
    </div>
  );
}

function GraphNodePopover({ node, metrics, validation, latestEvent }) {
  const data = node.data || {};
  const style = {
    left: `${(node.x / 360) * 100}%`,
    top: `${(node.y / 560) * 100}%`
  };
  const edgeClass = [
    node.x > 250 ? "near-right" : "",
    node.x < 110 ? "near-left" : "",
    node.y > 430 ? "near-bottom" : "",
    node.y < 130 ? "near-top" : ""
  ].filter(Boolean).join(" ");

  return (
    <div className={`graph-popover ${edgeClass}`} style={style}>
      <div className="graph-detail-head">
        <span className={`node-chip ${node.type}`}>{node.type}</span>
        <strong>{node.label}</strong>
      </div>

      {node.type === "chat" && (
        <div className="metric-grid">
          <Metric label="Runs" value={metrics?.total_runs ?? 0} />
          <Metric label="p95" value={`${metrics?.p95_end_to_end_latency ?? 0}s`} />
          <Metric label="Flags" value={metrics?.bad_response_flags ?? 0} />
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
          <div><span>vLLM endpoint</span><strong>{data.runtime?.vllm?.base_url}</strong></div>
          <div><span>Manifest</span><strong>{data.runtime?.manifest?.path}</strong></div>
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

  addNode({
    id: "chat",
    type: "chat",
    label: run?.status ? `Chat · ${run.status}` : "Chat",
    shortLabel: "CHAT",
    x: 180,
    y: 178,
    r: 38,
    status: run?.status || "ready",
    data: { run }
  });

  const routeByStep = new Map(routes.map((route) => [route.step_id, route]));
  const planSteps = run?.plan?.steps || [];
  const activeAdapters = new Set(planSteps.map((step) => step.adapter));
  const routeCount = Math.max(planSteps.length, 1);

  planSteps.forEach((step, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / routeCount;
    const route = routeByStep.get(step.id);
    const nodeId = `route:${step.id}`;
    addNode({
      id: nodeId,
      type: "route",
      label: step.adapter,
      shortLabel: shortNodeLabel(step.adapter),
      x: 180 + Math.cos(angle) * 118,
      y: 178 + Math.sin(angle) * 118,
      r: step.adapter === "writing_synthesis_lora" ? 31 : 28,
      status: route?.status || (run?.status === "completed" ? "complete" : "running"),
      data: { step, route }
    });
  });

  for (const step of planSteps) {
    const target = `route:${step.id}`;
    if (step.depends_on?.length) {
      for (const dep of step.depends_on) addEdge(`route:${dep}`, target, "dependency", true);
    } else {
      addEdge("chat", target, "activation", true);
    }
  }

  const agentNodes = agents.filter((agent) => !activeAdapters.has(agent.id));
  const agentCenter = { x: 180, y: 394 };
  const agentRadiusX = 146;
  const agentRadiusY = 102;
  agentNodes.forEach((agent, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(agentNodes.length, 1);
    const nodeId = `agent:${agent.id}`;
    addNode({
      id: nodeId,
      type: "agent",
      label: agent.id,
      shortLabel: shortNodeLabel(agent.id),
      x: agentCenter.x + Math.cos(angle) * agentRadiusX,
      y: agentCenter.y + Math.sin(angle) * agentRadiusY,
      r: 17,
      status: agent.mounted ? "mounted" : "unmounted",
      data: { agent }
    });
    addEdge("chat", nodeId, "catalog", false);
  });

  documents.slice(0, 8).forEach((document, index) => {
    const x = 48 + (index % 4) * 88;
    const y = 520 + Math.floor(index / 4) * 30;
    const nodeId = `doc:${document.document_id}`;
    addNode({
      id: nodeId,
      type: "document",
      label: document.title,
      shortLabel: "DOC",
      x,
      y,
      r: 18,
      data: { document }
    });
    const routeStep = planSteps.find((step) => step.adapter === document.agent_id);
    const agentNode = nodeMap.has(`route:${routeStep?.id}`) ? `route:${routeStep.id}` : `agent:${document.agent_id}`;
    addEdge(nodeMap.has(agentNode) ? agentNode : "chat", nodeId, "source", false);
  });

  sources.slice(0, 6).forEach((source, index) => {
    const x = 52 + index * 51;
    const y = 38;
    const nodeId = `source:${source.citation_id || source.chunk_id || index}`;
    addNode({
      id: nodeId,
      type: "source",
      label: source.title || source.chunk_id,
      shortLabel: "SRC",
      x,
      y,
      r: 15,
      data: { source }
    });
    const routeStep = planSteps.find((step) => step.id === source.step_id || step.adapter === source.agent_id);
    addEdge(nodeMap.has(`route:${routeStep?.id}`) ? `route:${routeStep.id}` : "chat", nodeId, "source", false);
  });

  addNode({
    id: "runtime",
    type: "runtime",
    label: runtime?.vllm?.base_model || "Runtime",
    shortLabel: "RT",
    x: 316,
    y: 178,
    r: 18,
    status: runtime?.ok ? "ready" : "failed",
    data: { runtime }
  });
  addEdge("runtime", "chat", "runtime", false);

  return {
    nodes,
    edges: edges.filter((edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target)),
    nodeMap,
    activeCount: planSteps.length
  };
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

function AgentDialog({ onClose, onCreated }) {
  const [form, setForm] = useState({
    id: "custom_route_lora",
    title: "",
    capability: "",
    boundary: "",
    routing_cues: "",
    produces: "",
    tools: "",
    sources: ""
  });
  const [error, setError] = useState("");

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await api.post("/api/agents", form);
      await onCreated();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="dialog-backdrop">
      <form className="dialog" onSubmit={submit}>
        <PanelHeader icon={<Bot size={18} />} title="Create Custom Route" subtitle="Zero-effect LoRA identity" />
        {error && <div className="field-error">{error}</div>}
        <label>Adapter id<input value={form.id} onChange={(event) => update("id", event.target.value)} /></label>
        <label>Title<input value={form.title} onChange={(event) => update("title", event.target.value)} /></label>
        <label>Capability<textarea value={form.capability} onChange={(event) => update("capability", event.target.value)} /></label>
        <label>Boundary<textarea value={form.boundary} onChange={(event) => update("boundary", event.target.value)} /></label>
        <label>Routing cues<textarea value={form.routing_cues} onChange={(event) => update("routing_cues", event.target.value)} /></label>
        <label>Produces<input value={form.produces} onChange={(event) => update("produces", event.target.value)} /></label>
        <label>Allowed tools<input value={form.tools} onChange={(event) => update("tools", event.target.value)} /></label>
        <label>Approved sources<input value={form.sources} onChange={(event) => update("sources", event.target.value)} /></label>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
          <button className="send-button"><Plus size={16} />Create</button>
        </div>
      </form>
    </div>
  );
}
