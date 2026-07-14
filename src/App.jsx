import {
  AlertCircle,
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AtSign,
  BookOpen,
  Bot,
  Calculator,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  ContactRound,
  Copy,
  Database,
  FilePlus2,
  FileSearch,
  Flag,
  Globe2,
  Github,
  HardDrive,
  Layers3,
  LoaderCircle,
  Menu,
  Mail,
  MessageCircle,
  Network,
  NotebookText,
  Paperclip,
  Pencil,
  Plus,
  Plug,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  Settings2,
  Slack,
  Sparkles,
  Star,
  SquarePen,
  Table2,
  Trash2,
  Upload,
  UserPlus,
  WandSparkles,
  ListTodo,
  X
} from "lucide-react";
import { UserButton, useAuth } from "@clerk/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import LandingPage from "./LandingPage.jsx";
import { AccountPanel, AdminUsersPanel, IdentityPage } from "./IdentityPage.jsx";
import {
  evidenceQuoteIsValid,
  extractBinaryPrediction,
  findEvidenceQuote,
  outcomeIsDue,
  tomorrowDateValue
} from "./outcomeEvidence.js";
import {
  canManageDocument,
  outcomeLifecycleState,
  realityRankHistory,
  realityRankSummary,
  realityRankTieBreak,
  shortRevision
} from "./lifecycleUi.js";

const api = {
  async get(path) {
    return request(path);
  },
  async post(path, body, { idempotencyKey } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    return request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  },
  async patch(path, body) {
    return request(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  },
  async delete(path) {
    return request(path, { method: "DELETE" });
  },
  async postForm(path, body) {
    return request(path, { method: "POST", body });
  }
};

async function request(path, options) {
  const response = await fetch(path, options);
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
    const error = new Error(payload.message || "The request could not be completed.");
    error.status = response.status;
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("virenis:authentication-required"));
    }
    throw error;
  }
  return payload;
}

function friendlyError(error) {
  return String(error?.message || error || "Something went wrong.")
    .replace(/TCAR/gi, "the service")
    .replace(/vLLM/gi, "the model service")
    .replace(/adapter models?/gi, "models")
    .replace(/adapter id/gi, "agent id")
    .replace(/adapter source/gi, "model source")
    .replace(/adapters/gi, "agents")
    .replace(/adapter/gi, "agent");
}

export function availableSessionAgents(agents = []) {
  return agents
    .filter((agent) => agent.enabled !== false)
    .filter((agent) => !agent.document && !agent.resource_for_agent_id);
}

function canManageAgent(agent, auth) {
  return Boolean(auth?.is_admin || (!auth?.is_viewer
    && agent?.visibility === "private"
    && agent?.created_by === auth?.user_id
    && agent?.workspace_id === auth?.workspace_id));
}

function emptyMetrics() {
  return {
    total_runs: 0,
    p95_end_to_end_latency: 0,
    bad_response_flags: 0,
    most_used_agents: [],
    admin_available: false
  };
}

function runStatusLabel(status) {
  if (status === "queued") return "Getting ready";
  if (status === "planning") return "Choosing agents";
  if (status === "running") return "Agents are working";
  if (status === "synthesizing") return "Composing the answer";
  if (status === "completed") return "Complete";
  if (status === "failed") return "Could not complete";
  return "Working";
}

function agentFacingText(value, fallback = "") {
  const cleaned = String(value || "")
    .replace(/\bLoRAs\b/gi, "agents")
    .replace(/\bLoRA\b/gi, "agent")
    .replace(/\badapter models?\b/gi, "models")
    .replace(/\badapters?\b/gi, "models")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

function formatAgentName(agentId, agents) {
  const agent = agents.find((item) => item.id === agentId);
  const title = agentFacingText(agent?.title);
  if (title && title.length <= 58) return title;
  return String(agentId || "Agent")
    .replace(/_lora$/i, "")
    .replace(/^custom_[a-z0-9]+_/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value, { includeTime = false } = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (includeTime) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function initialsFor(auth) {
  return String(auth?.display_name || auth?.user_id || "User")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "U";
}

export default function App() {
  const { isLoaded: clerkLoaded, isSignedIn } = useAuth();
  const [route, setRoute] = useState(() => applicationRoute(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => setRoute(applicationRoute(window.location.pathname));
    const handleAuthenticationRequired = () => {
      window.history.pushState({}, "", "/login");
      setRoute(applicationRoute("/login"));
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("virenis:authentication-required", handleAuthenticationRequired);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("virenis:authentication-required", handleAuthenticationRequired);
    };
  }, []);

  useEffect(() => {
    if (!clerkLoaded) return;
    if (route.legacyIdentity) {
      window.history.replaceState({}, "", "/login");
      setRoute(applicationRoute("/login"));
      return;
    }
    const needsSignIn = route.surface === "workspace" && !isSignedIn;
    const needsWorkspace = route.surface === "identity" && isSignedIn;
    if (!needsSignIn && !needsWorkspace) return;
    const path = needsSignIn ? "/login" : "/app";
    window.history.replaceState({}, "", path);
    setRoute(applicationRoute(path));
  }, [clerkLoaded, isSignedIn, route.legacyIdentity, route.surface]);

  function navigate(next) {
    const path = applicationPath(next);
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setRoute(applicationRoute(path));
    window.scrollTo?.({ top: 0, behavior: "auto" });
  }

  if (!clerkLoaded) {
    return <div className="center-state app-auth-loading" role="status"><LoaderCircle className="spin" size={20} /><span>Opening Virenis</span></div>;
  }
  if (route.surface === "home") {
    return (
      <LandingPage
        isSignedIn={Boolean(isSignedIn)}
        onSignIn={() => navigate("login")}
        onSignUp={() => navigate("register")}
        onWorkspace={() => navigate("workspace")}
      />
    );
  }
  if (route.surface === "identity") {
    if (isSignedIn) return <div className="center-state app-auth-loading" role="status"><LoaderCircle className="spin" size={20} /><span>Opening your workspace</span></div>;
    return (
      <IdentityPage
        mode={route.mode}
        onHome={() => navigate("home")}
      />
    );
  }
  if (!isSignedIn) return <div className="center-state app-auth-loading" role="status"><LoaderCircle className="spin" size={20} /><span>Preparing sign in</span></div>;
  return (
    <Workspace
      onHome={() => navigate("home")}
      onAuthenticationRequired={() => navigate("login")}
      onSignedOut={() => navigate("home")}
    />
  );
}

function applicationRoute(pathname) {
  if (pathname.startsWith("/app")) return { surface: "workspace", mode: null };
  if (pathname.startsWith("/register")) return { surface: "identity", mode: "register" };
  if (pathname.startsWith("/forgot-password")) return { surface: "identity", mode: "login", legacyIdentity: true };
  if (pathname.startsWith("/reset-password")) return { surface: "identity", mode: "login", legacyIdentity: true };
  if (pathname.startsWith("/verify-email")) return { surface: "identity", mode: "login", legacyIdentity: true };
  if (pathname.startsWith("/login")) return { surface: "identity", mode: "login" };
  return { surface: "home", mode: null };
}

function applicationPath(destination) {
  const paths = {
    home: "/",
    workspace: "/app",
    login: "/login",
    register: "/register"
  };
  return paths[destination] || "/";
}

function Workspace({ onHome, onAuthenticationRequired, onSignedOut }) {
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [checkpoints, setCheckpoints] = useState([]);
  const [agents, setAgents] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [chatDocuments, setChatDocuments] = useState([]);
  const [runtime, setRuntime] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [marketplace, setMarketplace] = useState([]);
  const [mcpConnections, setMcpConnections] = useState([]);
  const [mcpTemplates, setMcpTemplates] = useState([]);
  const [mcpApprovals, setMcpApprovals] = useState([]);
  const [auth, setAuth] = useState(null);
  const [runsById, setRunsById] = useState({});
  const [contractsById, setContractsById] = useState({});
  const [activeRun, setActiveRun] = useState(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resourceView, setResourceView] = useState("agents");
  const [detailsRunId, setDetailsRunId] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadScope, setUploadScope] = useState("knowledge");
  const [agentEditor, setAgentEditor] = useState(undefined);
  const [adoptionTarget, setAdoptionTarget] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [deleteAgentTarget, setDeleteAgentTarget] = useState(null);
  const [unpublishTarget, setUnpublishTarget] = useState(null);
  const [deleteDocumentTarget, setDeleteDocumentTarget] = useState(null);
  const [feedbackRunId, setFeedbackRunId] = useState(null);
  const [outcomeEditorRun, setOutcomeEditorRun] = useState(null);
  const [settlementContract, setSettlementContract] = useState(null);
  const [disputeContract, setDisputeContract] = useState(null);
  const [correctionContract, setCorrectionContract] = useState(null);
  const [togglingAgentId, setTogglingAgentId] = useState("");
  const [publishTarget, setPublishTarget] = useState(null);
  const [marketplaceTarget, setMarketplaceTarget] = useState(null);
  const [ratingTarget, setRatingTarget] = useState(null);
  const [focusComposer, setFocusComposer] = useState(0);
  const [workflowBusy, setWorkflowBusy] = useState("");
  const [checkpointBusy, setCheckpointBusy] = useState("");
  const [connectionResumeWorkflowId, setConnectionResumeWorkflowId] = useState("");
  const threadRef = useRef(null);
  const nearBottomRef = useRef(true);
  const eventSourceRef = useRef(null);
  const oauthReturnRef = useRef((() => {
    const parameters = new URLSearchParams(window.location.search);
    return {
      status: parameters.get("mcp_oauth"),
      reason: parameters.get("reason"),
      workflowId: parameters.get("workflow"),
      sessionId: parameters.get("session")
    };
  })());

  const canWrite = Boolean(auth && !auth.is_viewer);
  const detailsRun = detailsRunId ? runsById[detailsRunId] : null;

  useEffect(() => {
    bootstrap();
    return () => eventSourceRef.current?.close();
  }, []);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const oauthStatus = oauthReturnRef.current.status;
    if (!oauthStatus) return;
    if (!oauthReturnRef.current.workflowId) {
      setResourceView("connections");
      setResourcesOpen(true);
    }
    if (oauthStatus === "error") {
      const reason = oauthReturnRef.current.reason;
      setError(reason === "denied"
        ? "The connection was cancelled before access was granted. Your conversation and workflow draft are still available."
        : "The account connection could not be completed. Please try again.");
    }
    parameters.delete("mcp_oauth");
    parameters.delete("provider");
    parameters.delete("reason");
    parameters.delete("workflow");
    parameters.delete("session");
    const search = parameters.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }, []);

  useEffect(() => {
    if (nearBottomRef.current && threadRef.current) {
      threadRef.current.scrollTo({ top: threadRef.current.scrollHeight, behavior: loading ? "auto" : "smooth" });
    }
  }, [messages, activeRun?.status, loading]);

  async function bootstrap() {
    setLoading(true);
    setError("");
    try {
      const [me, sessionList, health, agentList, docList, marketplaceList, connectionList, templateList, approvalList] = await Promise.all([
        api.get("/api/auth/me"),
        api.get("/api/chat/sessions"),
        api.get("/api/runtime/health"),
        api.get("/api/agents"),
        api.get("/api/documents"),
        api.get("/api/marketplace"),
        api.get("/api/mcp/connections"),
        api.get("/api/mcp/templates"),
        api.get("/api/mcp/approvals")
      ]);
      const metricData = me.is_admin ? await api.get("/api/admin/metrics") : emptyMetrics();
      setAuth(me);
      setRuntime(health);
      setAgents(agentList.agents || []);
      setDocuments(docList.documents || []);
      setMarketplace(marketplaceList.items || []);
      setMcpConnections(connectionList.connections || []);
      setMcpTemplates(templateList.templates || []);
      setMcpApprovals(approvalList.approvals || []);
      setMetrics(metricData);
      const oauthSessionId = oauthReturnRef.current.sessionId;
      let nextSession = oauthSessionId
        ? sessionList.sessions?.find((item) => item.session_id === oauthSessionId) || { session_id: oauthSessionId }
        : sessionList.sessions?.[0] || null;
      if (!nextSession && !me.is_viewer) {
        nextSession = await api.post("/api/chat/sessions", { title: "New chat", visibility: "private" });
      }
      setSessions(sessionList.sessions?.length ? sessionList.sessions : nextSession ? [nextSession] : []);
      if (nextSession) await openSession(nextSession.session_id);
    } catch (bootstrapError) {
      if (bootstrapError?.status === 401) {
        onAuthenticationRequired();
        return;
      }
      setError(friendlyError(bootstrapError));
    } finally {
      setLoading(false);
    }
  }

  async function refreshResources() {
    const agentPath = session?.session_id
      ? `/api/agents?session_id=${encodeURIComponent(session.session_id)}`
      : "/api/agents";
    const [me, sessionList, agentList, docList, health, marketplaceList, connectionList, templateList, approvalList] = await Promise.all([
      api.get("/api/auth/me"),
      api.get("/api/chat/sessions"),
      api.get(agentPath),
      api.get("/api/documents"),
      api.get("/api/runtime/health"),
      api.get("/api/marketplace"),
      api.get("/api/mcp/connections"),
      api.get("/api/mcp/templates"),
      api.get("/api/mcp/approvals")
    ]);
    const metricData = me.is_admin ? await api.get("/api/admin/metrics") : emptyMetrics();
    setAuth(me);
    setSessions(sessionList.sessions || []);
    setAgents(agentList.agents || []);
    setDocuments(docList.documents || []);
    setRuntime(health);
    setMarketplace(marketplaceList.items || []);
    setMcpConnections(connectionList.connections || []);
    setMcpTemplates(templateList.templates || []);
    setMcpApprovals(approvalList.approvals || []);
    setMetrics(metricData);
  }

  async function fetchRun(runId, { makeActive = false } = {}) {
    if (!runId) return null;
    const run = await api.get(`/api/chat/runs/${encodeURIComponent(runId)}`);
    setRunsById((current) => ({ ...current, [runId]: run }));
    if (makeActive) setActiveRun(run);
    for (const contract of run.outcome_contracts || []) {
      fetchContract(contract.contract_id).catch(() => undefined);
    }
    return run;
  }

  async function fetchContract(contractId) {
    const contract = await api.get(`/api/outcome-contracts/${encodeURIComponent(contractId)}`);
    setContractsById((current) => ({ ...current, [contractId]: contract }));
    return contract;
  }

  async function openSession(sessionId) {
    setError("");
    const [payload, agentList] = await Promise.all([
      api.get(`/api/chat/sessions/${encodeURIComponent(sessionId)}`),
      api.get(`/api/agents?session_id=${encodeURIComponent(sessionId)}`)
    ]);
    setSession(payload);
    setMessages(payload.messages || []);
    setWorkflows(payload.workflows || []);
    setCheckpoints(payload.checkpoints || []);
    setChatDocuments(payload.chat_documents || []);
    setAgents(agentList.agents || []);
    setHistoryOpen(false);
    nearBottomRef.current = true;
    const assistantRunIds = [...new Set(
      (payload.messages || [])
        .filter((message) => message.role === "assistant" && message.run_id)
        .map((message) => message.run_id)
    )];
    const latestRunId = [...(payload.messages || [])].reverse().find((message) => message.run_id)?.run_id;
    if (latestRunId) {
      await fetchRun(latestRunId, { makeActive: true });
    } else {
      setActiveRun(null);
    }
    assistantRunIds.slice(-12).filter((runId) => runId !== latestRunId).forEach((runId) => {
      fetchRun(runId).catch(() => undefined);
    });
  }

  async function newChat() {
    if (!canWrite) return;
    setError("");
    try {
      eventSourceRef.current?.close();
      const created = await api.post("/api/chat/sessions", { title: "New chat", visibility: "private" });
      await refreshResources();
      await openSession(created.session_id);
      setDraft("");
      setHistoryOpen(false);
      setFocusComposer((value) => value + 1);
    } catch (chatError) {
      setError(friendlyError(chatError));
    }
  }

  async function sendMessage(event) {
    event?.preventDefault();
    const content = draft.trim();
    if (!content || !session || !canWrite) return;
    const optimisticId = `local_${Date.now()}`;
    nearBottomRef.current = true;
    setDraft("");
    setError("");
    setMessages((items) => [...items, {
      message_id: optimisticId,
      role: "user",
      content,
      created_at: new Date().toISOString()
    }]);
    try {
      const queued = await api.post(`/api/chat/sessions/${encodeURIComponent(session.session_id)}/messages`, {
        content,
        attachments: [],
        options: { show_route_details: true }
      });
      setMessages((items) => items.map((message) => message.message_id === optimisticId
        ? { ...message, message_id: queued.message_id, run_id: queued.run_id }
        : message));
      const stub = {
        run_id: queued.run_id,
        session_id: session.session_id,
        query: content,
        status: queued.status || "queued",
        expert_outputs: [],
        sources: [],
        outcome_contracts: [],
        events: []
      };
      setActiveRun(stub);
      setRunsById((current) => ({ ...current, [queued.run_id]: stub }));
      subscribeRun(queued.run_id, session.session_id);
    } catch (sendError) {
      setMessages((items) => items.filter((message) => message.message_id !== optimisticId));
      setDraft(content);
      setError(friendlyError(sendError));
    }
  }

  function subscribeRun(runId, sessionId) {
    eventSourceRef.current?.close();
    const source = new EventSource(`/api/chat/runs/${encodeURIComponent(runId)}/events`);
    eventSourceRef.current = source;
    source.onmessage = async (message) => {
      const event = JSON.parse(message.data);
      const nextStatus = event.type === "planner.started" || event.type === "run.started"
        ? "planning"
        : event.type === "planner.completed" || event.type === "route.started" || event.type === "route.completed"
          ? "running"
          : event.type === "synthesis.started"
            ? "synthesizing"
            : event.type === "final.completed"
              ? "completed"
              : event.type === "run.failed"
                ? "failed"
                : null;
      if (nextStatus) {
        setActiveRun((current) => current?.run_id === runId ? { ...current, status: nextStatus } : current);
        setRunsById((current) => ({
          ...current,
          [runId]: { ...(current[runId] || { run_id: runId }), status: nextStatus }
        }));
      }
      if (["planner.completed", "route.completed", "synthesis.started", "final.completed", "run.failed"].includes(event.type)) {
        await fetchRun(runId, { makeActive: true }).catch(() => undefined);
      }
      if (event.type === "final.completed" || event.type === "run.failed") {
        source.close();
        if (eventSourceRef.current === source) eventSourceRef.current = null;
        await openSession(sessionId).catch((sessionError) => setError(friendlyError(sessionError)));
        await refreshResources().catch(() => undefined);
      }
    };
    source.onerror = () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
      fetchRun(runId, { makeActive: true }).catch(() => undefined);
    };
  }

  async function openRunDetails(runId) {
    setDetailsRunId(runId);
    if (!runsById[runId]?.expert_outputs) {
      await fetchRun(runId).catch((detailsError) => setError(friendlyError(detailsError)));
    } else {
      fetchRun(runId).catch(() => undefined);
    }
  }

  async function retryAnswer(run) {
    if (!canWrite) return;
    setDraft(run?.query || "");
    setFocusComposer((value) => value + 1);
  }

  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError("Copy is not available in this browser.");
    }
  }

  async function waitForWorkflowActivation(workflow) {
    let current = workflow;
    for (let attempt = 0; current?.status === "activating" && attempt < 30; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      current = await api.get(`/api/workflows/${encodeURIComponent(current.workflow_id)}`);
    }
    return current;
  }

  async function decideWorkflowDraft(workflow, decision) {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy(workflow.workflow_id);
    setError("");
    try {
      const updated = await api.post(`/api/workflows/${encodeURIComponent(workflow.workflow_id)}/decision`, {
        decision,
        revision: workflow.revision
      });
      await waitForWorkflowActivation(updated);
      await openSession(workflow.session_id || session.session_id);
      await refreshResources();
    } catch (workflowError) {
      setError(friendlyError(workflowError));
      await openSession(session.session_id).catch(() => undefined);
    } finally {
      setWorkflowBusy("");
    }
  }

  async function resumeWorkflow(workflow) {
    if (!workflow || workflowBusy) return;
    setWorkflowBusy(workflow.workflow_id);
    setError("");
    try {
      const updated = await api.post(`/api/workflows/${encodeURIComponent(workflow.workflow_id)}/resume`, {});
      await waitForWorkflowActivation(updated);
      await openSession(workflow.session_id || session.session_id);
      await refreshResources();
    } catch (workflowError) {
      setError(friendlyError(workflowError));
      await openSession(session.session_id).catch(() => undefined);
    } finally {
      setWorkflowBusy("");
    }
  }

  async function connectWorkflowRequirement(workflow, requirement) {
    if (!workflow || !requirement || workflowBusy) return;
    if (requirement.status === "connected") {
      await resumeWorkflow(workflow);
      return;
    }
    const template = mcpTemplates.find((item) => item.id === requirement.provider_id);
    if (requirement.connection_mode === "managed" && template) {
      if (template.availability !== "available") {
        setError(template.availability_message || `${requirement.name} must be configured by an administrator first.`);
        return;
      }
      setWorkflowBusy(workflow.workflow_id);
      setError("");
      try {
        const started = await api.post("/api/mcp/oauth/start", {
          provider_id: requirement.provider_id,
          workflow_id: workflow.workflow_id
        });
        const authorization = new URL(started.authorization_url);
        if (!/^https?:$/.test(authorization.protocol)) throw new Error("The provider returned an invalid authorization address.");
        window.location.assign(authorization.toString());
      } catch (connectionError) {
        setWorkflowBusy("");
        setError(friendlyError(connectionError));
      }
      return;
    }
    setConnectionResumeWorkflowId(workflow.workflow_id);
    setResourceView("connections");
    setResourcesOpen(true);
  }

  function runWorkflow(workflow) {
    const agentIds = (workflow.activation?.node_agents || []).map((item) => item.agent_id).filter(Boolean);
    const mentions = agentIds.map((agentId) => `@${agentId}`).join(" ");
    setDraft(`${mentions}${mentions ? " " : ""}${workflow.intent}`.trim());
    setFocusComposer((value) => value + 1);
  }

  async function decideToolCheckpoint(checkpoint, approval, decision) {
    if (!checkpoint || !approval || checkpointBusy) return;
    setCheckpointBusy(checkpoint.checkpoint_id);
    setError("");
    try {
      await api.post(`/api/mcp/approvals/${encodeURIComponent(approval.approval_id)}`, { decision });
      await openSession(checkpoint.session_id || session.session_id);
      await refreshResources();
    } catch (approvalError) {
      setError(friendlyError(approvalError));
    } finally {
      setCheckpointBusy("");
    }
  }

  async function retryCheckpoint(checkpoint) {
    if (!checkpoint || checkpointBusy) return;
    setCheckpointBusy(checkpoint.checkpoint_id);
    setError("");
    try {
      await api.post(`/api/conversation/checkpoints/${encodeURIComponent(checkpoint.checkpoint_id)}/resume`, {});
      await openSession(checkpoint.session_id || session.session_id);
    } catch (checkpointError) {
      setError(friendlyError(checkpointError));
    } finally {
      setCheckpointBusy("");
    }
  }

  async function archiveAgent(agent) {
    setError("");
    await api.delete(`/api/agents/${encodeURIComponent(agent.id)}`);
    setArchiveTarget(null);
    await refreshResources();
    setResourcesOpen(true);
    setResourceView("agents");
  }

  async function deleteArchivedAgent(agent) {
    setError("");
    await api.delete(`/api/agents/${encodeURIComponent(agent.id)}/permanent`);
    setDeleteAgentTarget(null);
    await refreshResources();
    setResourcesOpen(true);
    setResourceView("agents");
  }

  async function unpublishAgent(target) {
    const item = target?.item || target;
    const returnView = target?.returnView || "agents";
    setError("");
    await api.delete(`/api/marketplace/items/${encodeURIComponent(item.id)}`);
    setUnpublishTarget(null);
    await refreshResources();
    setResourcesOpen(true);
    setResourceView(returnView);
  }

  async function deleteDocument(document) {
    setError("");
    await api.delete(`/api/documents/${encodeURIComponent(document.document_id)}`);
    setDeleteDocumentTarget(null);
    await refreshResources();
    if (document.scope === "chat") {
      setChatDocuments((items) => items.filter((item) => item.document_id !== document.document_id));
      setResourcesOpen(false);
      setFocusComposer((value) => value + 1);
    } else {
      setResourcesOpen(true);
      setResourceView("knowledge");
    }
  }

  async function toggleAgentForSession(agent, active) {
    if (!session?.session_id || !canWrite) return;
    setTogglingAgentId(agent.id);
    setError("");
    try {
      const result = await api.patch(
        `/api/chat/sessions/${encodeURIComponent(session.session_id)}/agents/${encodeURIComponent(agent.id)}`,
        { active }
      );
      setAgents((items) => items.map((item) => item.id === agent.id ? { ...item, session_active: result.active } : item));
      setSession((current) => current ? { ...current, inactive_agent_ids: result.inactive_agent_ids } : current);
    } catch (toggleError) {
      setError(friendlyError(toggleError));
    } finally {
      setTogglingAgentId("");
    }
  }

  async function setGraphConnection(fromId, toId, connected) {
    if (!canWrite || !fromId || !toId || fromId === toId) return;
    const target = agents.find((agent) => agent.id === toId);
    if (!target) throw new Error("The destination agent is no longer available.");
    setError("");
    try {
      await api.patch(`/api/agents/${encodeURIComponent(toId)}`, {
        consumes: graphConnectionInputs(target.consumes, fromId, connected)
      });
      await refreshResources();
    } catch (connectionError) {
      setError(friendlyError(connectionError));
      throw connectionError;
    }
  }

  function openAgentEditor(agent = null) {
    setResourcesOpen(false);
    setAgentEditor({ agent });
  }

  function openAgentAdoption(agent) {
    setResourcesOpen(false);
    setAdoptionTarget(agent);
  }

  function openKnowledgeUpload() {
    setResourcesOpen(false);
    setUploadScope("knowledge");
    setUploadOpen(true);
  }

  function openChatUpload() {
    if (!session?.session_id) return;
    setUploadScope("chat");
    setUploadOpen(true);
  }

  async function outcomeSaved(runId) {
    setOutcomeEditorRun(null);
    setSettlementContract(null);
    setDisputeContract(null);
    setCorrectionContract(null);
    await fetchRun(runId, { makeActive: activeRun?.run_id === runId });
    await refreshResources();
    setDetailsRunId(runId);
  }

  async function beginSettlement(contractId) {
    try {
      const contract = await fetchContract(contractId);
      setDetailsRunId(null);
      setSettlementContract(contract);
    } catch (contractError) {
      setError(friendlyError(contractError));
    }
  }

  async function beginOutcomeLifecycle(contractId, action) {
    try {
      const contract = await fetchContract(contractId);
      setDetailsRunId(null);
      if (action === "dispute") setDisputeContract(contract);
      if (action === "correct") setCorrectionContract(contract);
    } catch (contractError) {
      setError(friendlyError(contractError));
    }
  }

  async function lifecycleOutcomeSaved(contract) {
    setContractsById((current) => ({ ...current, [contract.contract_id]: contract }));
    await outcomeSaved(contract.run_id);
  }

  function handleThreadScroll(event) {
    const element = event.currentTarget;
    nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  }

  const isBusy = activeRun && !["completed", "failed"].includes(activeRun.status);
  const workflowsById = Object.fromEntries(workflows.map((workflow) => [workflow.workflow_id, workflow]));
  const actionableCheckpoints = checkpoints.filter((checkpoint) =>
    checkpoint.type === "mcp_tool_approval"
    && ["pending", "resuming", "resume_failed"].includes(checkpoint.status)
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-side">
          <IconButton label="Open chat history" onClick={() => setHistoryOpen(true)}>
            <Menu size={20} />
          </IconButton>
          <button className="wordmark" type="button" onClick={onHome} aria-label="Go to Virenis homepage">Virenis</button>
        </div>
        <div className="header-side header-actions">
          <IconButton label="New chat" onClick={newChat} disabled={!canWrite}>
            <SquarePen size={19} />
          </IconButton>
          <button
            className="studio-button"
            type="button"
            aria-label="Open Agent Studio"
            onClick={() => setResourcesOpen(true)}
          >
            <Settings2 size={16} />
            <span>Studio</span>
          </button>
          <span className="clerk-user-control"><UserButton afterSignOutUrl="/" /></span>
        </div>
      </header>

      <main className={`chat-main ${messages.length === 0 ? "is-empty" : ""}`}>
        <section
          className="message-thread"
          ref={threadRef}
          onScroll={handleThreadScroll}
          aria-label="Conversation"
        >
          <div className="thread-inner">
            {loading && (
              <div className="center-state" role="status">
                <LoaderCircle className="spin" size={20} />
                <span>Opening your chats</span>
              </div>
            )}

            {!loading && messages.length === 0 && !isBusy && (
              <div className="empty-chat">
                <h1>{auth?.is_viewer ? "No conversation selected" : "What can I help with?"}</h1>
              </div>
            )}

            {!loading && messages.map((message, index) => (
              <ChatMessage
                key={message.message_id}
                message={message}
                run={message.run_id ? runsById[message.run_id] : null}
                agents={agents}
                canWrite={canWrite}
                previousUser={findPreviousUser(messages, index)}
                workflow={message.workflow_id ? workflowsById[message.workflow_id] : null}
                workflowBusy={workflowBusy === message.workflow_id}
                onWorkflowDecision={decideWorkflowDraft}
                onWorkflowConnect={connectWorkflowRequirement}
                onWorkflowResume={resumeWorkflow}
                onWorkflowRun={runWorkflow}
                onWorkflowGraph={() => {
                  setResourceView("graph");
                  setResourcesOpen(true);
                }}
                onCopy={copyText}
                onRetry={retryAnswer}
                onFeedback={setFeedbackRunId}
                onDetails={openRunDetails}
              />
            ))}

            {actionableCheckpoints.map((checkpoint) => (
              <ToolApprovalCheckpoint
                key={checkpoint.checkpoint_id}
                checkpoint={checkpoint}
                approval={mcpApprovals.find((item) => item.approval_id === checkpoint.approval_id)}
                busy={checkpointBusy === checkpoint.checkpoint_id}
                onDecision={decideToolCheckpoint}
                onRetry={retryCheckpoint}
              />
            ))}

            {isBusy && <RunProgress run={activeRun} />}

            {activeRun?.status === "failed" && !messages.some((message) => message.role === "assistant" && message.run_id === activeRun.run_id) && (
              <div className="inline-error" role="alert">
                <AlertCircle size={17} />
                <span>{activeRun.error?.message || "This answer could not be completed."}</span>
                {canWrite && <button type="button" onClick={() => retryAnswer(activeRun)}>Try again</button>}
              </div>
            )}
          </div>
        </section>

        <div className="composer-zone">
          {runtime?.ok === false && (
            <div className="service-notice" role="status">The service is temporarily unavailable.</div>
          )}
          {error && (
            <div className="global-error" role="alert">
              <span>{error}</span>
              <IconButton label="Dismiss message" onClick={() => setError("")} compact>
                <X size={16} />
              </IconButton>
            </div>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={sendMessage}
            onAttachFile={openChatUpload}
            chatDocuments={chatDocuments}
            onDeleteChatDocument={setDeleteDocumentTarget}
            agents={agents}
            sessionId={session?.session_id}
            canWrite={canWrite}
            focusRequest={focusComposer}
            onOpenAgents={() => {
              setResourceView("agents");
              setResourcesOpen(true);
            }}
            onToggleAgent={toggleAgentForSession}
            togglingAgentId={togglingAgentId}
          />
        </div>
      </main>

      {historyOpen && (
        <HistorySheet
          sessions={sessions}
          activeSessionId={session?.session_id}
          canWrite={canWrite}
          onClose={() => setHistoryOpen(false)}
          onNewChat={newChat}
          onOpenSession={(sessionId) => openSession(sessionId).catch((openError) => setError(friendlyError(openError)))}
        />
      )}

      {resourcesOpen && (
        <ResourcesSheet
          auth={auth}
          agents={agents}
          documents={documents}
          runtime={runtime}
          metrics={metrics}
          marketplace={marketplace}
          mcpConnections={mcpConnections}
          mcpTemplates={mcpTemplates}
          mcpApprovals={mcpApprovals}
          resumeWorkflowId={connectionResumeWorkflowId}
          sessionId={session?.session_id}
          initialView={resourceView}
          togglingAgentId={togglingAgentId}
          onViewChange={setResourceView}
          onClose={() => setResourcesOpen(false)}
          onCreateAgent={() => openAgentEditor(null)}
          onEditAgent={openAgentEditor}
          onAdoptAgent={openAgentAdoption}
          onArchiveAgent={(agent) => {
            setResourcesOpen(false);
            setArchiveTarget(agent);
          }}
          onDeleteAgent={(agent) => {
            setResourcesOpen(false);
            setDeleteAgentTarget(agent);
          }}
          onToggleAgent={toggleAgentForSession}
          onPublish={(agent) => {
            setResourcesOpen(false);
            setPublishTarget(agent);
          }}
          onUnpublish={(agent) => {
            setResourcesOpen(false);
            setUnpublishTarget({ item: agent, returnView: "agents" });
          }}
          onOpenMarketplaceItem={(item) => {
            setResourcesOpen(false);
            setMarketplaceTarget(item);
          }}
          onRate={(item) => {
            if (item.is_self_published) return;
            setResourcesOpen(false);
            setRatingTarget(item);
          }}
          onAddKnowledge={openKnowledgeUpload}
          onDeleteKnowledge={(document) => {
            setResourcesOpen(false);
            setDeleteDocumentTarget(document);
          }}
          onConnectAgents={(fromId, toId) => setGraphConnection(fromId, toId, true)}
          onDisconnectAgents={(fromId, toId) => setGraphConnection(fromId, toId, false)}
          onRefresh={refreshResources}
          onSignedOut={onSignedOut}
          onConnectionChanged={async () => {
            if (!connectionResumeWorkflowId) return;
            const target = workflows.find((item) => item.workflow_id === connectionResumeWorkflowId);
            if (target) await resumeWorkflow(target);
            setConnectionResumeWorkflowId("");
          }}
        />
      )}

      {detailsRunId && (
        <RunDetailsSheet
          run={detailsRun}
          agents={agents}
          contractsById={contractsById}
          canWrite={canWrite}
          onClose={() => setDetailsRunId(null)}
          onCreateOutcome={() => {
            setDetailsRunId(null);
            setOutcomeEditorRun(detailsRun);
          }}
          onSettleOutcome={beginSettlement}
          onDisputeOutcome={(contractId) => beginOutcomeLifecycle(contractId, "dispute")}
          onCorrectOutcome={(contractId) => beginOutcomeLifecycle(contractId, "correct")}
        />
      )}

      {uploadOpen && (
        <DocumentUploadDialog
          scope={uploadScope}
          sessionId={uploadScope === "chat" ? session?.session_id : null}
          onClose={() => setUploadOpen(false)}
          onUploaded={async (uploaded) => {
            setUploadOpen(false);
            await refreshResources();
            if (uploadScope === "chat") {
              setChatDocuments((items) => [
                ...items.filter((item) => item.document_id !== uploaded.document_id),
                uploaded
              ]);
              setFocusComposer((value) => value + 1);
            } else {
              setResourcesOpen(true);
              setResourceView("knowledge");
            }
          }}
        />
      )}

      {agentEditor !== undefined && (
        <AgentDialog
          auth={auth}
          agent={agentEditor.agent || null}
          agents={agents}
          documents={documents}
          mcpConnections={mcpConnections}
          onClose={() => setAgentEditor(undefined)}
          onSaved={async () => {
            setAgentEditor(undefined);
            await refreshResources();
            setResourcesOpen(true);
            setResourceView("agents");
          }}
        />
      )}

      {publishTarget && (
        <PublishDialog
          agent={publishTarget}
          onClose={() => {
            setPublishTarget(null);
            setResourcesOpen(true);
            setResourceView("agents");
          }}
          onSaved={async () => {
            setPublishTarget(null);
            await refreshResources();
            setResourcesOpen(true);
            setResourceView("agents");
          }}
        />
      )}

      {marketplaceTarget && (
        <MarketplaceAgentDialog
          item={marketplaceTarget}
          auth={auth}
          onClose={() => {
            setMarketplaceTarget(null);
            setResourcesOpen(true);
            setResourceView("marketplace");
          }}
          onRate={(item) => {
            if (item.is_self_published) return;
            setMarketplaceTarget(null);
            setRatingTarget(item);
          }}
          onEditDescription={(item) => {
            const sourceAgent = agents.find((agent) => agent.id === item.id);
            if (!sourceAgent) {
              setMarketplaceTarget(null);
              setError("The source agent is no longer available in this workspace.");
              setResourcesOpen(true);
              setResourceView("marketplace");
              return;
            }
            setMarketplaceTarget(null);
            setPublishTarget({
              ...sourceAgent,
              marketplace: {
                ...(sourceAgent.marketplace || {}),
                published: true,
                description: item.description || sourceAgent.marketplace?.description || sourceAgent.capability
              }
            });
          }}
          onUnpublish={(item) => {
            setMarketplaceTarget(null);
            setUnpublishTarget({ item, returnView: "marketplace" });
          }}
          onCopied={async () => {
            setMarketplaceTarget(null);
            await refreshResources();
            setResourcesOpen(true);
            setResourceView("agents");
          }}
        />
      )}

      {ratingTarget && (
        <RatingDialog
          item={ratingTarget}
          onClose={() => {
            setRatingTarget(null);
            setResourcesOpen(true);
            setResourceView("marketplace");
          }}
          onSaved={async () => {
            setRatingTarget(null);
            await refreshResources();
            setResourcesOpen(true);
            setResourceView("marketplace");
          }}
        />
      )}

      {adoptionTarget && (
        <AdoptionDialog
          auth={auth}
          agent={adoptionTarget}
          onClose={() => {
            setAdoptionTarget(null);
            setResourcesOpen(true);
            setResourceView("agents");
          }}
          onSaved={async () => {
            setAdoptionTarget(null);
            await refreshResources();
            setResourcesOpen(true);
            setResourceView("agents");
          }}
        />
      )}

      {archiveTarget && (
        <ConfirmDialog
          title="Archive agent?"
          message={`${archiveTarget.title || "This agent"} will no longer be available for new answers.`}
          confirmLabel="Archive"
          destructive
          onClose={() => {
            setArchiveTarget(null);
            setResourcesOpen(true);
            setResourceView("agents");
          }}
          onConfirm={() => archiveAgent(archiveTarget)}
        />
      )}

      {deleteAgentTarget && (
        <ConfirmDialog
          title="Delete archived agent permanently?"
          message={`${deleteAgentTarget.title || "This archived agent"} and its Marketplace listing will be permanently removed. This cannot be undone.`}
          confirmLabel="Delete permanently"
          destructive
          icon={Trash2}
          onClose={() => {
            setDeleteAgentTarget(null);
            setResourcesOpen(true);
            setResourceView("agents");
          }}
          onConfirm={() => deleteArchivedAgent(deleteAgentTarget)}
        />
      )}

      {unpublishTarget && (
        <ConfirmDialog
          title="Remove from Marketplace?"
          message={`${unpublishTarget.item?.title || "This agent"} will no longer be visible in the Marketplace. The agent will stay in your workspace.`}
          confirmLabel="Unpublish"
          destructive
          icon={Globe2}
          onClose={() => {
            const returnView = unpublishTarget.returnView || "agents";
            setUnpublishTarget(null);
            setResourcesOpen(true);
            setResourceView(returnView);
          }}
          onConfirm={() => unpublishAgent(unpublishTarget)}
        />
      )}


      {deleteDocumentTarget && (
        <ConfirmDialog
          title={deleteDocumentTarget.scope === "chat" ? "Remove file from this chat?" : "Delete knowledge?"}
          message={`${deleteDocumentTarget.title || "This file"} and its searchable contents will be permanently removed.`}
          confirmLabel={deleteDocumentTarget.scope === "chat" ? "Remove" : "Delete"}
          destructive
          icon={Trash2}
          onClose={() => {
            setDeleteDocumentTarget(null);
            if (deleteDocumentTarget.scope !== "chat") {
              setResourcesOpen(true);
              setResourceView("knowledge");
            }
          }}
          onConfirm={() => deleteDocument(deleteDocumentTarget)}
        />
      )}

      {feedbackRunId && (
        <FeedbackDialog
          runId={feedbackRunId}
          onClose={() => setFeedbackRunId(null)}
          onSaved={() => setFeedbackRunId(null)}
        />
      )}

      {outcomeEditorRun && (
        <OutcomeDialog
          run={outcomeEditorRun}
          agents={agents}
          auth={auth}
          onClose={() => {
            const runId = outcomeEditorRun.run_id;
            setOutcomeEditorRun(null);
            setDetailsRunId(runId);
          }}
          onSaved={() => outcomeSaved(outcomeEditorRun.run_id)}
        />
      )}

      {settlementContract && (
        <SettlementDialog
          contract={settlementContract}
          onClose={() => {
            const runId = settlementContract.run_id;
            setSettlementContract(null);
            setDetailsRunId(runId);
          }}
          onSaved={lifecycleOutcomeSaved}
        />
      )}

      {disputeContract && (
        <DisputeDialog
          contract={disputeContract}
          onClose={() => {
            const runId = disputeContract.run_id;
            setDisputeContract(null);
            setDetailsRunId(runId);
          }}
          onSaved={lifecycleOutcomeSaved}
        />
      )}

      {correctionContract && (
        <CorrectionDialog
          contract={correctionContract}
          onClose={() => {
            const runId = correctionContract.run_id;
            setCorrectionContract(null);
            setDetailsRunId(runId);
          }}
          onSaved={lifecycleOutcomeSaved}
        />
      )}
    </div>
  );
}

function findPreviousUser(messages, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === "user") return messages[cursor];
  }
  return null;
}

function IconButton({ label, children, compact = false, className = "", ...props }) {
  return (
    <button
      className={`icon-button tooltip-control ${compact ? "compact" : ""} ${className}`.trim()}
      type="button"
      aria-label={label}
      title={label}
      data-tooltip={label}
      {...props}
    >
      {children}
    </button>
  );
}

function ModalSurface({ title, description, side, onClose, children, className = "" }) {
  const titleId = useId();
  const descriptionId = useId();
  const surfaceRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const surface = surfaceRef.current;
    const focusable = surface?.querySelector("[data-autofocus]")
      || surface?.querySelector("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])");
    (focusable || surface)?.focus();
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !surface) return;
      const items = [...surface.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), details summary, [tabindex]:not([tabindex='-1'])")]
        .filter((element) => element.getClientRects().length > 0);
      if (!items.length) {
        event.preventDefault();
        surface.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  const sheetClass = side ? `sheet sheet-${side}` : "dialog-surface";
  return (
    <div
      className={`overlay ${side ? "sheet-overlay" : "dialog-overlay"}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={surfaceRef}
        className={`${sheetClass} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="surface-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

function HistorySheet({ sessions, activeSessionId, canWrite, onClose, onNewChat, onOpenSession }) {
  const [query, setQuery] = useState("");
  const filtered = sessions.filter((item) => !query || String(item.title).toLowerCase().includes(query.toLowerCase()));
  return (
    <ModalSurface title="Chats" side="left" onClose={onClose}>
      <div className="sheet-body">
        <div className="sheet-toolbar">
          <label className="search-field">
            <Search size={17} aria-hidden="true" />
            <span className="sr-only">Search chats</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" />
          </label>
          <IconButton label="New chat" onClick={onNewChat} disabled={!canWrite}>
            <SquarePen size={18} />
          </IconButton>
        </div>
        <nav className="flat-list chat-list" aria-label="Chat history">
          {filtered.map((item) => (
            <button
              type="button"
              className="chat-row"
              key={item.session_id}
              aria-current={activeSessionId === item.session_id ? "page" : undefined}
              onClick={() => onOpenSession(item.session_id)}
            >
              <span>{item.title}</span>
              <small>{formatDate(item.last_message_at || item.updated_at)}</small>
            </button>
          ))}
          {filtered.length === 0 && <p className="muted-empty">No chats found.</p>}
        </nav>
      </div>
    </ModalSurface>
  );
}

function ChatMessage({
  message,
  run,
  agents,
  canWrite,
  previousUser,
  workflow,
  workflowBusy,
  onWorkflowDecision,
  onWorkflowConnect,
  onWorkflowResume,
  onWorkflowRun,
  onWorkflowGraph,
  onCopy,
  onRetry,
  onFeedback,
  onDetails
}) {
  const isAssistant = message.role === "assistant";
  return (
    <article className={`message ${message.role}`}>
      <div className="message-content">
        {isAssistant ? <FormattedText text={message.content} /> : message.content}
        {message.kind === "workflow_draft" && workflow && (
          <WorkflowDraftCard
            workflow={workflow}
            busy={workflowBusy}
            canWrite={canWrite}
            onDecision={onWorkflowDecision}
            onConnect={onWorkflowConnect}
            onResume={onWorkflowResume}
            onRun={onWorkflowRun}
            onGraph={onWorkflowGraph}
          />
        )}
      </div>
      {isAssistant && (
        <div className="answer-footer">
          {message.run_id && (
            <RunReceipt run={run} agents={agents} onClick={() => onDetails(message.run_id)} />
          )}
          <div className="answer-actions" aria-label="Answer actions">
            <IconButton label="Copy answer" compact onClick={() => onCopy(message.content)}>
              <Copy size={16} />
            </IconButton>
            <IconButton
              label="Try this prompt again"
              compact
              onClick={() => onRetry(run || { query: previousUser?.content || "" })}
              disabled={!canWrite}
            >
              <RotateCcw size={16} />
            </IconButton>
            <IconButton
              label="Report a problem"
              compact
              onClick={() => onFeedback(message.run_id)}
              disabled={!canWrite || !message.run_id}
            >
              <Flag size={16} />
            </IconButton>
          </div>
        </div>
      )}
    </article>
  );
}

export function WorkflowDraftCard({
  workflow,
  busy = false,
  canWrite = true,
  onDecision = () => undefined,
  onConnect = () => undefined,
  onResume = () => undefined,
  onRun = () => undefined,
  onGraph = () => undefined
}) {
  const missingConnections = (workflow.connection_requirements || []).filter((item) => item.status !== "connected");
  const agentNodes = (workflow.nodes || []).filter((node) => node.type === "agent");
  const status = workflowStatusCopy(workflow.status);
  return (
    <section className={`workflow-draft-card status-${workflow.status}`} aria-label={`${workflow.title} workflow proposal`}>
      <header className="workflow-card-head">
        <span className="workflow-card-icon"><WandSparkles size={17} /></span>
        <div><small>{workflow.mode === "agent_team" ? "AGENT TEAM" : "AUTO-COMPOSER"}</small><strong>{workflow.title}</strong></div>
        <i className={status.tone}>{busy || workflow.status === "activating" ? <LoaderCircle className="spin" size={13} /> : status.icon}{status.label}</i>
      </header>

      <WorkflowMiniGraph nodes={workflow.nodes || []} edges={workflow.edges || []} />

      <div className="workflow-agent-sources" aria-label="Selected agents">
        {agentNodes.map((node) => (
          <div key={node.id}>
            <span className={`workflow-source-dot ${node.source}`} />
            <span>
              <strong>{node.title}</strong>
              <small>{workflowSourceLabel(node)}</small>
              {(node.tools || []).length > 0 && <small>Tools: {node.tools.map(workflowToolLabel).join(" · ")}</small>}
            </span>
            {node.status === "blocked_connection" && <i>Needs connection</i>}
          </div>
        ))}
      </div>

      {(workflow.connection_requirements || []).length > 0 && (
        <div className="workflow-connections" aria-label="Required connections">
          <strong>Connections</strong>
          {(workflow.connection_requirements || []).map((requirement) => (
            <div key={requirement.provider_id}>
              <span><Plug size={14} /><i><b>{requirement.name}</b><small>{requirement.reason}</small></i></span>
              {requirement.status === "connected"
                ? <em className="connected"><Check size={12} />Connected</em>
                : <button type="button" disabled={!canWrite || busy} onClick={() => onConnect(workflow, requirement)}>{requirement.connection_mode === "managed" ? `Connect ${requirement.name}` : `Add ${requirement.name} MCP`}</button>}
            </div>
          ))}
        </div>
      )}

      <details className="workflow-review-details">
        <summary>Review permissions and safety</summary>
        <div>
          <section><strong>Permissions</strong><ul>{(workflow.permissions || []).map((item) => <li key={item}>{item}</li>)}</ul></section>
          <section><strong>Safeguards</strong><ul>{(workflow.safety || []).map((item) => <li key={item}>{item}</li>)}</ul></section>
        </div>
      </details>

      <footer className="workflow-card-actions">
        {workflow.status === "awaiting_confirmation" && <>
          <button type="button" className="text-button ghost" disabled={!canWrite || busy} onClick={() => onDecision(workflow, "deny")}>Keep normal chat</button>
          <button type="button" className="text-button primary" disabled={!canWrite || busy} onClick={() => onDecision(workflow, "approve")}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{missingConnections.length ? "Approve plan" : workflow.mode === "agent_team" ? "Create agent team" : "Create workflow"}</button>
        </>}
        {workflow.status === "awaiting_connections" && <>
          <button type="button" className="text-button ghost" disabled={!canWrite || busy} onClick={() => onDecision(workflow, "deny")}>Cancel draft</button>
          <span>{missingConnections.length ? `Waiting for ${missingConnections.map((item) => item.name).join(" and ")}` : "Connections ready"}</span>
        </>}
        {workflow.status === "ready_to_activate" && <button type="button" className="text-button primary" disabled={!canWrite || busy} onClick={() => onResume(workflow)}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Finish setup</button>}
        {workflow.status === "activation_failed" && <>
          <button type="button" className="text-button ghost" disabled={!canWrite || busy} onClick={() => onDecision(workflow, "deny")}>Cancel draft</button>
          <button type="button" className="text-button primary" disabled={!canWrite || busy} onClick={() => onResume(workflow)}><RefreshCw size={14} />Retry setup</button>
        </>}
        {workflow.status === "active" && <>
          <button type="button" className="text-button ghost" onClick={() => onGraph(workflow)}><Network size={14} />View graph</button>
          <button type="button" className="text-button primary" disabled={!canWrite} onClick={() => onRun(workflow)}><ArrowRight size={14} />Run in chat</button>
        </>}
        {workflow.status === "activating" && <span><LoaderCircle className="spin" size={14} />Creating private agents and validated handoffs…</span>}
        {workflow.status === "declined" && <span>Draft closed. No agents or connections were changed.</span>}
      </footer>
      {workflow.error && <div className="workflow-card-error" role="alert"><AlertCircle size={14} />{workflow.error}</div>}
    </section>
  );
}

export function WorkflowMiniGraph({ nodes, edges }) {
  const layout = workflowGraphLayout(nodes, edges);
  const height = Math.max(190, layout.height);
  return (
    <div className="workflow-mini-graph" style={{ height }} role="img" aria-label="Proposed workflow handoff graph">
      <svg viewBox={`0 0 640 ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs><marker id="workflow-card-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" /></marker></defs>
        {edges.map((edge) => {
          const from = layout.positions[edge.source];
          const to = layout.positions[edge.target];
          if (!from || !to) return null;
          const mid = (from.y + to.y) / 2;
          return <path key={`${edge.source}:${edge.target}`} d={`M ${from.x} ${from.y + 21} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${to.y - 21}`} markerEnd="url(#workflow-card-arrow)" />;
        })}
      </svg>
      {nodes.map((node) => {
        const position = layout.positions[node.id];
        if (!position) return null;
        return <div className={`workflow-mini-node ${node.type} ${node.source || "system"} ${node.status || "ready"}`} style={{ left: `${(position.x / 640) * 100}%`, top: position.y }} key={node.id}><strong>{node.title}</strong><small>{node.type === "agent" ? workflowSourceLabel(node) : node.type}</small></div>;
      })}
    </div>
  );
}

export function workflowGraphLayout(nodes = [], edges = []) {
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) if (ids.has(edge.source) && ids.has(edge.target)) incoming.get(edge.target).push(edge.source);
  const depth = new Map();
  function nodeDepth(id, visiting = new Set()) {
    if (depth.has(id)) return depth.get(id);
    if (visiting.has(id)) return 0;
    const nextVisiting = new Set(visiting).add(id);
    const parents = incoming.get(id) || [];
    const value = parents.length ? 1 + Math.max(...parents.map((parent) => nodeDepth(parent, nextVisiting))) : 0;
    depth.set(id, value);
    return value;
  }
  for (const node of nodes) nodeDepth(node.id);
  const levels = new Map();
  for (const node of nodes) {
    const level = depth.get(node.id) || 0;
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(node);
  }
  const positions = {};
  for (const [level, items] of levels) {
    items.forEach((node, index) => {
      positions[node.id] = {
        x: ((index + 1) / (items.length + 1)) * 640,
        y: 36 + level * 92
      };
    });
  }
  return { positions, height: 82 + Math.max(0, ...depth.values()) * 92 };
}

export function ToolApprovalCheckpoint({ checkpoint, approval, busy = false, onDecision, onRetry }) {
  if (checkpoint.status === "resuming") {
    return (
      <section className="tool-checkpoint-card resuming" role="status">
        <LoaderCircle className="spin" size={18} />
        <div><strong>The decision is saved</strong><p>Resuming this answer with the approved or declined action. You can recover it here after a restart.</p></div>
        <button type="button" className="text-button ghost" disabled={busy} onClick={() => onRetry(checkpoint)}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Resume now</button>
      </section>
    );
  }
  if (!approval && checkpoint.status !== "resume_failed") return null;
  if (checkpoint.status === "resume_failed") {
    return (
      <section className="tool-checkpoint-card error" role="status">
        <AlertCircle size={18} />
        <div><strong>The tool decision was saved</strong><p>{checkpoint.resume_error || "The conversation continuation needs to be retried."}</p></div>
        <button type="button" className="text-button primary" disabled={busy} onClick={() => onRetry(checkpoint)}>{busy ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Resume answer</button>
      </section>
    );
  }
  return (
    <section className="tool-checkpoint-card" aria-label="Tool action awaiting approval">
      <header><span><Plug size={16} /></span><div><small>ACTION REQUEST</small><strong>{approval.tool_title || approval.tool_name}</strong><p>{approval.connection_name} · {formatAgentName(approval.agent_id, [])}</p></div></header>
      <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
      <p className="tool-checkpoint-note">Only this exact action will run. Approving or declining will resume the answer in this conversation.</p>
      <footer><button type="button" className="text-button ghost" disabled={busy} onClick={() => onDecision(checkpoint, approval, "deny")}>Decline</button><button type="button" className="text-button primary" disabled={busy} onClick={() => onDecision(checkpoint, approval, "approve")}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Approve and continue</button></footer>
    </section>
  );
}

function workflowSourceLabel(node) {
  if (node.source === "workspace") return "Your workspace";
  if (node.source === "marketplace") return `Marketplace${node.publisher ? ` · ${node.publisher}` : ""}`;
  if (node.source === "generated") return "New private agent";
  return node.type || "Workflow step";
}

function workflowToolLabel(tool) {
  const labels = {
    web_search: "Web search",
    calculator: "Calculator",
    math_solver: "Math solver",
    data_table: "Data table",
    sql_runner: "SQL",
    document_search: "Document search",
    document_read: "Document reader",
    repo_inspector: "Repository inspector"
  };
  return labels[tool] || String(tool || "").replaceAll("_", " ");
}

function workflowStatusCopy(status) {
  if (status === "active") return { label: "Ready", tone: "success", icon: <Check size={12} /> };
  if (status === "declined") return { label: "Closed", tone: "muted", icon: <X size={12} /> };
  if (status === "awaiting_connections") return { label: "Connection needed", tone: "warning", icon: <Plug size={12} /> };
  if (status === "activation_failed") return { label: "Needs attention", tone: "warning", icon: <AlertCircle size={12} /> };
  if (status === "activating") return { label: "Creating", tone: "working", icon: null };
  if (status === "ready_to_activate") return { label: "Ready to finish", tone: "working", icon: <Check size={12} /> };
  return { label: "Draft · review required", tone: "draft", icon: <WandSparkles size={12} /> };
}

export function FormattedText({ text }) {
  return (
    <div className="formatted-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
        rehypePlugins={[rehypeKatex]}
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={{
          a: ({ children, href, node: _node, ...props }) => <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>,
          img: () => null
        }}
      >
        {String(text || "").replace(/\r\n?/g, "\n")}
      </ReactMarkdown>
    </div>
  );
}

function safeMarkdownUrl(url, key) {
  const value = String(url || "").trim();
  if (key === "src") return "";
  if (/^(https?:|mailto:)/i.test(value) || value.startsWith("#")) return value;
  return "";
}

function RunReceipt({ run, onClick }) {
  if (!run) {
    return (
      <button type="button" className="run-receipt" onClick={onClick}>
        View details <ChevronRight size={14} />
      </button>
    );
  }
  const agentCount = run.expert_outputs?.length || run.plan?.steps?.length || 0;
  const sourceCount = run.sources?.length || 0;
  const settled = run.outcome_contracts?.filter((contract) => contract.status === "settled").length || 0;
  const pending = run.outcome_contracts?.filter((contract) => contract.status === "pending").length || 0;
  const parts = [];
  if (!["completed", "failed"].includes(run.status)) parts.push(runStatusLabel(run.status));
  if (agentCount) parts.push(`${agentCount} ${agentCount === 1 ? "agent" : "agents"}`);
  if (sourceCount) parts.push(`${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`);
  if (settled) parts.push(`${settled} recorded result${settled === 1 ? "" : "s"}`);
  else if (pending) parts.push(`${pending} claim${pending === 1 ? "" : "s"} being tracked`);
  if (run.elapsed_sec != null) parts.push(`${Number(run.elapsed_sec).toFixed(1)}s`);
  return (
    <button type="button" className={`run-receipt ${run.status || ""}`} onClick={onClick}>
      <span className="receipt-dot" aria-hidden="true" />
      <span>{parts.join(" · ") || "Answer details"}</span>
      <ChevronRight size={14} />
    </button>
  );
}

function RunProgress({ run }) {
  return (
    <div className="run-progress" role="status" aria-live="polite" aria-atomic="true">
      <LoaderCircle className="spin" size={17} />
      <span>{runStatusLabel(run?.status)}</span>
    </div>
  );
}

function mentionMatchScore(agent, query) {
  if (!query) return 1;
  const title = String(agent.title || "").toLowerCase();
  const id = String(agent.id || "").toLowerCase().replaceAll("_", " ");
  const capability = String(agent.capability || "").toLowerCase();
  const words = `${title} ${id}`.split(/[^a-z0-9]+/).filter(Boolean);
  if (title.startsWith(query) || id.startsWith(query)) return 100;
  if (words.some((word) => word.startsWith(query))) return 80;
  if (title.includes(query) || id.includes(query)) return 50;
  if (capability.includes(query)) return 10;
  return 0;
}

function Composer({
  value,
  onChange,
  onSubmit,
  onAttachFile,
  chatDocuments,
  onDeleteChatDocument,
  agents,
  sessionId,
  canWrite,
  focusRequest,
  onOpenAgents,
  onToggleAgent,
  togglingAgentId
}) {
  const inputRef = useRef(null);
  const listId = useId();
  const [mention, setMention] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const quickAgents = availableSessionAgents(agents);
  const activeAgentCount = quickAgents.filter((agent) => agent.session_active !== false).length;
  const commandMatch = value.match(/^\/([a-z]*)$/i);
  const commandSuggestions = commandMatch ? [
    { command: "workflow", title: "Compose a workflow", detail: "Build a reusable, reviewable automation graph" },
    { command: "agent", title: "Compose an agent team", detail: "Build a manually invoked team of specialists" }
  ].filter((item) => item.command.startsWith(commandMatch[1].toLowerCase())) : [];

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return agents
      .filter((agent) => agent.enabled !== false)
      .filter((agent) => !agent.document && !agent.resource_for_agent_id)
      .filter((agent) => agent.scope !== "chat" || agent.session_id === sessionId)
      .map((agent) => ({ agent, score: mentionMatchScore(agent, query) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score
        || formatAgentName(left.agent.id, agents).localeCompare(formatAgentName(right.agent.id, agents)))
      .map(({ agent }) => agent)
      .slice(0, 6);
  }, [agents, mention, sessionId]);

  useEffect(() => {
    if (focusRequest) inputRef.current?.focus();
  }, [focusRequest]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 176)}px`;
  }, [value]);

  useEffect(() => setActiveIndex(0), [mention?.query]);

  function updateMention(nextValue, caret) {
    const beforeCaret = nextValue.slice(0, caret);
    const match = beforeCaret.match(/(^|\s)@([^\s@"]*)$/);
    if (!match) {
      setMention(null);
      return;
    }
    setMention({
      start: caret - match[2].length - 1,
      end: caret,
      query: match[2]
    });
  }

  function chooseAgent(agent) {
    if (!mention) return;
    const title = agentFacingText(agent.title).replace(/"/g, "");
    const alias = String(agent.id || "agent");
    const token = title && title.length <= 58 ? `@"${title}"` : `@${alias}`;
    const nextValue = `${value.slice(0, mention.start)}${token} ${value.slice(mention.end)}`;
    const nextCaret = mention.start + token.length + 1;
    onChange(nextValue);
    setMention(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function onKeyDown(event) {
    if (mention && suggestions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        chooseAgent(suggestions[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit(event);
    }
  }

  return (
    <form className="composer" onSubmit={onSubmit}>
      {commandSuggestions.length > 0 && !mention && (
        <div className="command-menu" role="listbox" aria-label="Composer commands">
          {commandSuggestions.map((item) => (
            <button type="button" role="option" aria-selected="false" key={item.command} onClick={() => {
              onChange(`/${item.command} `);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}>
              <WandSparkles size={15} />
              <span><strong>/{item.command} · {item.title}</strong><small>{item.detail}</small></span>
            </button>
          ))}
        </div>
      )}
      {mention && suggestions.length > 0 && (
        <div className="mention-menu" id={listId} role="listbox" aria-label="Agent suggestions">
          {suggestions.map((agent, index) => (
            <button
              type="button"
              role="option"
              id={`${listId}-${index}`}
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "active" : ""}
              key={agent.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseAgent(agent)}
            >
              <AtSign size={15} aria-hidden="true" />
              <span>
                <strong>{formatAgentName(agent.id, agents)}</strong>
                <small>{agentFacingText(agent.capability)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {chatDocuments.length > 0 && (
        <div className="chat-file-list" aria-label="Files available in this chat">
          {chatDocuments.map((document) => (
            <span className="chat-file-chip" key={document.document_id}>
              <BookOpen size={14} aria-hidden="true" />
              <span>{document.title}</span>
              <IconButton
                label={`Remove ${document.title || "file"} from this chat`}
                compact
                onClick={() => onDeleteChatDocument(document)}
                disabled={!canWrite}
              >
                <X size={13} />
              </IconButton>
            </span>
          ))}
        </div>
      )}
      <IconButton label="Attach file to this chat" className="composer-control" onClick={onAttachFile} disabled={!canWrite || !sessionId}>
        <Paperclip size={19} />
      </IconButton>
      <IconButton
        label="Choose agents for this chat"
        className={`composer-control agent-trigger ${agentMenuOpen ? "active" : ""}`}
        onClick={() => setAgentMenuOpen((open) => !open)}
        disabled={!sessionId}
        aria-expanded={agentMenuOpen}
      >
        <Network size={18} />
        {activeAgentCount > 0 && <span className="composer-count" aria-hidden="true">{activeAgentCount}</span>}
      </IconButton>
      {agentMenuOpen && (
        <div className="quick-agent-menu" aria-label="Agents active in this chat">
          <div className="quick-menu-heading">
            <span><strong>Agents for this chat</strong><small>Choose which specialists the Router may use.</small></span>
            <button type="button" onClick={() => { setAgentMenuOpen(false); onOpenAgents(); }}>Manage</button>
          </div>
          <div className="quick-agent-list">
            {quickAgents.map((agent) => (
              <label key={agent.id}>
                <span><strong>{formatAgentName(agent.id, agents)}</strong><small>{agentFacingText(agent.capability, "Specialist agent")}</small></span>
                <input
                  type="checkbox"
                  checked={agent.session_active !== false}
                  disabled={!canWrite || togglingAgentId === agent.id}
                  onChange={(event) => onToggleAgent(agent, event.target.checked)}
                />
              </label>
            ))}
            {quickAgents.length === 0 && <p>No agents are ready yet.</p>}
          </div>
        </div>
      )}
      <label className="composer-input">
        <span className="sr-only">Message Virenis</span>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            updateMention(event.target.value, event.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
          placeholder={canWrite ? "Ask anything · /workflow or /agent to compose" : "This conversation is read-only"}
          rows={1}
          maxLength={12000}
          disabled={!canWrite}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={Boolean(mention && suggestions.length)}
          aria-controls={mention && suggestions.length ? listId : undefined}
          aria-activedescendant={mention && suggestions.length ? `${listId}-${activeIndex}` : undefined}
        />
      </label>
      <IconButton
        label="Send message"
        className="send-control"
        type="submit"
        disabled={!canWrite || !value.trim()}
      >
        <ArrowUp size={19} />
      </IconButton>
    </form>
  );
}

function ResourcesSheet({
  auth,
  agents,
  documents,
  runtime,
  metrics,
  marketplace,
  mcpConnections,
  mcpTemplates,
  mcpApprovals,
  resumeWorkflowId,
  sessionId,
  initialView,
  togglingAgentId,
  onViewChange,
  onClose,
  onCreateAgent,
  onEditAgent,
  onAdoptAgent,
  onArchiveAgent,
  onDeleteAgent,
  onToggleAgent,
  onPublish,
  onUnpublish,
  onOpenMarketplaceItem,
  onRate,
  onAddKnowledge,
  onDeleteKnowledge,
  onConnectAgents,
  onDisconnectAgents,
  onRefresh,
  onSignedOut,
  onConnectionChanged
}) {
  const [view, setView] = useState(initialView || "agents");
  const canWrite = !auth?.is_viewer;
  function changeView(next) {
    setView(next);
    onViewChange(next);
  }
  return (
    <ModalSurface title="Agent studio" description="Build, connect, and share specialized intelligence." side="right" onClose={onClose} className="resource-hub-sheet">
      <div className="sheet-body resource-sheet-body">
        <div className="view-switch resource-nav" aria-label="Resource view">
          <button type="button" aria-pressed={view === "agents"} onClick={() => changeView("agents")}>Agents</button>
          <button type="button" aria-pressed={view === "graph"} onClick={() => changeView("graph")}>Graph</button>
          <button type="button" aria-pressed={view === "marketplace"} onClick={() => changeView("marketplace")}>Marketplace</button>
          <button type="button" aria-pressed={view === "connections"} onClick={() => changeView("connections")}>Connections</button>
          <button type="button" aria-pressed={view === "knowledge"} onClick={() => changeView("knowledge")}>Knowledge</button>
          <button type="button" aria-pressed={view === "account"} onClick={() => changeView("account")}>Account</button>
          {auth?.is_admin && <button type="button" aria-pressed={view === "admin"} onClick={() => changeView("admin")}>Admin</button>}
        </div>

        {view === "agents" && (
          <AgentCatalog
            agents={agents}
            auth={auth}
            onCreate={onCreateAgent}
            onEdit={onEditAgent}
            onAdopt={onAdoptAgent}
            onArchive={onArchiveAgent}
            onDelete={onDeleteAgent}
            onToggle={onToggleAgent}
            onPublish={onPublish}
            onUnpublish={onUnpublish}
            togglingAgentId={togglingAgentId}
            sessionId={sessionId}
          />
        )}

        {view === "graph" && (
          <AgentGraph
            agents={agents}
            auth={auth}
            storageKey={`virenis:agent-graph:${auth?.workspace_id || "workspace"}`}
            onConnect={onConnectAgents}
            onDisconnect={onDisconnectAgents}
          />
        )}

        {view === "marketplace" && (
          <MarketplacePanel
            items={marketplace}
            auth={auth}
            onOpen={onOpenMarketplaceItem}
            onRate={onRate}
          />
        )}

        {view === "knowledge" && (
          <KnowledgeList
            documents={documents}
            agents={agents}
            auth={auth}
            canWrite={canWrite}
            onAdd={onAddKnowledge}
            onDelete={onDeleteKnowledge}
          />
        )}

        {view === "connections" && (
          <ConnectionsPanel
            connections={mcpConnections}
            templates={mcpTemplates}
            approvals={mcpApprovals}
            canWrite={canWrite}
            onRefresh={onRefresh}
            resumeWorkflowId={resumeWorkflowId}
            onConnectionChanged={onConnectionChanged}
          />
        )}

        {view === "account" && (
          <AccountPanel auth={auth} onSignedOut={onSignedOut} />
        )}

        {view === "admin" && auth?.is_admin && (
          <AdminPanel runtime={runtime} metrics={metrics} agents={agents} documents={documents} onRefresh={onRefresh} />
        )}

        <footer className="profile-footer">
          <span className="profile-initials" aria-hidden="true">{initialsFor(auth)}</span>
          <span>
            <strong>{auth?.display_name || auth?.user_id || "User"}</strong>
            <small>{auth?.email || (auth?.is_admin ? "Admin" : auth?.is_viewer ? "Viewer" : "Private workspace")}</small>
          </span>
        </footer>
      </div>
    </ModalSurface>
  );
}

export function ConnectionsPanel({
  connections = [],
  templates = [],
  approvals = [],
  canWrite,
  onRefresh,
  resumeWorkflowId = "",
  onConnectionChanged = async () => undefined
}) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ template_id: "custom", name: "", endpoint_url: "", auth_type: "none", token: "", trust_read_annotations: false });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const recentApprovals = approvals.filter((approval) => approval.status !== "pending").slice(-4).reverse();
  const managedProviders = templates.filter((template) => template.connection_mode === "managed");
  const customTemplates = templates.filter((template) => template.connection_mode !== "managed");

  function chooseTemplate(template) {
    setForm((current) => ({
      ...current,
      template_id: template.id,
      name: template.id === "custom" ? current.name : template.name,
      auth_type: template.auth_type || "none"
    }));
  }

  async function connectManaged(provider, connectionId) {
    if (provider.availability !== "available") {
      setError(provider.availability_message || "This managed connection has not been configured by an administrator.");
      return;
    }
    const busyId = connectionId || `provider:${provider.id}`;
    setBusy(busyId);
    setError("");
    setNotice("");
    try {
      const started = await api.post("/api/mcp/oauth/start", {
        provider_id: provider.id,
        ...(connectionId ? { connection_id: connectionId } : {})
      });
      const authorization = new URL(started.authorization_url);
      if (!/^https?:$/.test(authorization.protocol)) throw new Error("The provider returned an invalid authorization address.");
      window.location.assign(authorization.toString());
    } catch (connectionError) {
      setBusy("");
      setError(friendlyError(connectionError));
    }
  }

  async function createConnection(event) {
    event.preventDefault();
    setBusy("create");
    setError("");
    setNotice("");
    try {
      await api.post("/api/mcp/connections", {
        name: form.name,
        template_id: form.template_id,
        endpoint_url: form.endpoint_url,
        trust_read_annotations: form.trust_read_annotations,
        auth: form.auth_type === "bearer" ? { type: "bearer", token: form.token } : { type: "none" }
      });
      setForm({ template_id: "custom", name: "", endpoint_url: "", auth_type: "none", token: "", trust_read_annotations: false });
      setShowForm(false);
      await onRefresh();
      await onConnectionChanged();
    } catch (connectionError) {
      setError(friendlyError(connectionError));
    } finally {
      setBusy("");
    }
  }

  async function refreshConnection(connection) {
    setBusy(connection.connection_id);
    setError("");
    setNotice("");
    try {
      await api.post(`/api/mcp/connections/${encodeURIComponent(connection.connection_id)}/refresh`, {});
      await onRefresh();
    } catch (refreshError) {
      setError(friendlyError(refreshError));
    } finally {
      setBusy("");
    }
  }

  async function deleteConnection(connection) {
    setBusy(connection.connection_id);
    setError("");
    setNotice("");
    try {
      const result = await api.delete(`/api/mcp/connections/${encodeURIComponent(connection.connection_id)}`);
      if (result.revocation_warning) setNotice(result.revocation_warning);
      await onRefresh();
    } catch (deleteError) {
      setError(friendlyError(deleteError));
    } finally {
      setBusy("");
    }
  }

  async function decideApproval(approval, decision) {
    setBusy(approval.approval_id);
    setError("");
    try {
      await api.post(`/api/mcp/approvals/${encodeURIComponent(approval.approval_id)}`, { decision });
      await onRefresh();
    } catch (approvalError) {
      setError(friendlyError(approvalError));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="resource-section connections-section" aria-labelledby="connections-heading">
      <div className="section-heading-row">
        <div>
          <span className="eyebrow">Workspace tools</span>
          <h2 id="connections-heading">Connections</h2>
          <p>Connect an account in a few clicks, then give each agent only the tools it needs.</p>
        </div>
        {canWrite && <button type="button" className="text-button ghost" onClick={() => setShowForm((value) => !value)}><Settings2 size={15} />Custom MCP</button>}
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="connection-notice" role="status">{notice}</div>}
      {resumeWorkflowId && <div className="connection-notice" role="status">This connection will return you to the saved workflow automatically.</div>}

      {managedProviders.length > 0 && (
        <div className="managed-connections-block">
          <div className="connections-subheading"><span><Plug size={15} /></span><div><strong>Connect your accounts</strong><small>No endpoints or tokens to copy. Sign in with the provider and choose what your agents can use.</small></div></div>
          <div className="managed-provider-grid">
            {managedProviders.map((provider) => {
              const providerConnections = connections.filter((connection) => connection.provider_id === provider.id);
              const connecting = busy === `provider:${provider.id}`;
              return (
                <article className={`managed-provider-card provider-${provider.id}`} key={provider.id}>
                  <div className="managed-provider-head">
                    <span className={`managed-provider-icon ${provider.id}`}><ManagedProviderIcon providerId={provider.id} /></span>
                    <div><em>{provider.category || "Integration"}</em><strong>{provider.name}</strong><small>{provider.description}</small></div>
                    <i className={provider.setup_mode === "automatic" ? "automatic" : ""}>{provider.setup_mode === "automatic" ? "Instant setup" : provider.preview ? "Preview" : "OAuth"}</i>
                  </div>
                  <div className="managed-provider-policy"><Check size={14} /><span>{provider.permissions_summary || "Read-only tools can run automatically. Actions still require your approval."}</span></div>
                  <footer>
                    <small>{providerConnections.length
                      ? `${providerConnections.length} account connection${providerConnections.length === 1 ? "" : "s"}`
                      : provider.availability_message}</small>
                    {canWrite && (
                      <button
                        type="button"
                        className="text-button primary"
                        disabled={connecting || provider.availability !== "available" || providerConnections.length > 0}
                        onClick={() => connectManaged(provider)}
                      >
                        {connecting ? <LoaderCircle className="spin" size={14} /> : <Plug size={14} />}
                        {providerConnections.length
                          ? "Connected"
                          : provider.availability !== "available"
                            ? "Admin setup"
                            : provider.connect_label || `Connect ${provider.name}`}
                      </button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {pendingApprovals.length > 0 && (
        <div className="approval-stack" aria-label="Actions waiting for approval">
          <div className="connections-subheading"><span><Check size={15} /></span><div><strong>Waiting for your approval</strong><small>Nothing below runs until you approve the exact action.</small></div></div>
          {pendingApprovals.map((approval) => (
            <article className="approval-card" key={approval.approval_id}>
              <div><strong>{approval.tool_title || approval.tool_name}</strong><small>{approval.connection_name} · {formatAgentName(approval.agent_id, [])}</small></div>
              <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
              <div className="approval-actions">
                <button type="button" className="text-button ghost" disabled={busy === approval.approval_id} onClick={() => decideApproval(approval, "deny")}>Deny</button>
                <button type="button" className="text-button primary" disabled={busy === approval.approval_id} onClick={() => decideApproval(approval, "approve")}>{busy === approval.approval_id ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Approve and run</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {recentApprovals.length > 0 && (
        <details className="recent-connection-activity">
          <summary>Recent approved actions <span>{recentApprovals.length}</span></summary>
          <div>
            {recentApprovals.map((approval) => (
              <article key={approval.approval_id}>
                <span className={approval.status === "executed" ? "success" : "muted"}><Check size={13} /></span>
                <div><strong>{approval.tool_title || approval.tool_name}</strong><small>{approval.status === "executed" ? "Approved and completed" : approval.status} · {formatDate(approval.decided_at, { includeTime: true })}</small>{approval.result && <pre>{JSON.stringify(approval.result, null, 2)}</pre>}</div>
              </article>
            ))}
          </div>
        </details>
      )}

      {showForm && (
        <form className="connection-form" onSubmit={createConnection}>
          <div className="builder-heading"><span>ADVANCED</span><h3>Connect a custom MCP server</h3><p>For servers that do not offer a managed sign-in. Virenis performs a live handshake and imports the current tool schemas.</p></div>
          <div className="connection-template-grid">
            {customTemplates.map((template) => (
              <button type="button" className={form.template_id === template.id ? "selected" : ""} key={template.id} onClick={() => chooseTemplate(template)}>
                <Plug size={16} /><span><strong>{template.name}</strong><small>{template.description}</small></span>{form.template_id === template.id && <Check size={13} />}
              </button>
            ))}
          </div>
          <div className="advanced-builder-grid">
            <div className="builder-field"><label htmlFor="mcp-name">Connection name</label><input id="mcp-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required maxLength={100} placeholder="Product workspace" /></div>
            <div className="builder-field"><label htmlFor="mcp-endpoint">HTTPS endpoint</label><input id="mcp-endpoint" value={form.endpoint_url} onChange={(event) => setForm((current) => ({ ...current, endpoint_url: event.target.value }))} required type="url" placeholder={customTemplates.find((template) => template.id === form.template_id)?.endpoint_placeholder || "https://mcp.example.com/mcp"} /></div>
          </div>
          <fieldset className="connection-auth"><legend>Authentication</legend><label><input type="radio" name="mcp-auth" checked={form.auth_type === "none"} onChange={() => setForm((current) => ({ ...current, auth_type: "none", token: "" }))} />No authentication</label><label><input type="radio" name="mcp-auth" checked={form.auth_type === "bearer"} onChange={() => setForm((current) => ({ ...current, auth_type: "bearer" }))} />Bearer token</label></fieldset>
          {form.auth_type === "bearer" && <div className="builder-field"><label htmlFor="mcp-token">Bearer token</label><input id="mcp-token" type="password" autoComplete="new-password" value={form.token} onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))} required /><small>Encrypted before it is written; never sent to an agent or published.</small></div>}
          <label className="connection-trust-read"><input type="checkbox" checked={form.trust_read_annotations} onChange={(event) => setForm((current) => ({ ...current, trust_read_annotations: event.target.checked }))} /><span><strong>Allow declared read-only tools without approval</strong><small>Enable this only when you trust this MCP server's tool labels. Otherwise every call asks first.</small></span></label>
          <div className="connection-form-actions"><button type="button" className="text-button ghost" onClick={() => setShowForm(false)} disabled={busy === "create"}>Cancel</button><button type="submit" className="text-button primary" disabled={busy === "create"}>{busy === "create" ? <LoaderCircle className="spin" size={14} /> : <Plug size={14} />}Connect and discover tools</button></div>
        </form>
      )}

      <div className="connection-list">
        {connections.map((connection) => (
          <article className={`connection-card ${connection.status !== "ready" ? "connection-needs-attention" : ""}`} key={connection.connection_id}>
            <div className="connection-card-head"><span className={`connection-icon ${connection.provider_id || "custom"}`}>{connection.connection_mode === "managed" ? <ManagedProviderIcon providerId={connection.provider_id} size={17} /> : <Plug size={17} />}</span><div><strong>{connection.name}</strong><small>{connection.connection_mode === "managed" ? "Connected securely with OAuth" : `${connection.endpoint_origin} · ${connection.auth_type === "bearer" ? "Protected" : "No auth"}`}</small></div><i className={connection.status === "ready" ? "connection-ready" : "connection-warning"}><span />{connection.status === "ready" ? "Ready" : "Reconnect"}</i></div>
            <div className="connection-tools">
              {(connection.tools || []).map((tool) => <span className={!tool.requires_approval ? "read" : "write"} key={tool.name}>{tool.title || tool.name}<small>{!tool.requires_approval ? "Read" : "Approval"}</small></span>)}
            </div>
            <footer><small>{connection.tools?.length || 0} discovered tools · {connection.read_policy === "allow_declared_reads" ? "read tools run automatically" : "approval for every call"}</small>{canWrite && <div>{connection.reauthorization_required && <button type="button" className="text-button primary compact" disabled={busy === connection.connection_id} onClick={() => connectManaged(templates.find((template) => template.id === connection.provider_id) || { id: connection.provider_id, availability: "available" }, connection.connection_id)}>{busy === connection.connection_id ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}Reconnect</button>}<IconButton compact label={`Refresh ${connection.name}`} disabled={busy === connection.connection_id || connection.reauthorization_required} onClick={() => refreshConnection(connection)}><RefreshCw className={busy === connection.connection_id ? "spin" : ""} size={15} /></IconButton><IconButton compact label={`Delete ${connection.name}`} disabled={busy === connection.connection_id} onClick={() => deleteConnection(connection)}><Trash2 size={15} /></IconButton></div>}</footer>
          </article>
        ))}
        {!connections.length && !showForm && <div className="empty-resource-state"><span><Plug size={22} /></span><h3>No accounts connected yet</h3><p>Connect a provider above, review its tools, and assign only the ones an agent needs.</p></div>}
      </div>
    </section>
  );
}

function ManagedProviderIcon({ providerId, size = 20 }) {
  const icons = {
    gmail: Mail,
    google_drive: HardDrive,
    google_calendar: CalendarDays,
    google_chat: MessageCircle,
    google_contacts: ContactRound,
    github: Github,
    slack: Slack,
    notion: NotebookText,
    linear: ListTodo
  };
  const ProviderIcon = icons[providerId] || Plug;
  return <ProviderIcon size={size} aria-hidden="true" />;
}

function RealityRank({ rank }) {
  const summary = realityRankSummary(rank);
  const history = realityRankHistory(rank);
  const hasResults = summary.samples > 0;
  return (
    <div className="rank-summary">
      <div className="rank-overview" title="Past verified results are used only when equally relevant agents tie">
        <b>{hasResults ? `Result score ${summary.score_label}` : "No verified results yet"}</b>
        <i>{hasResults ? summary.sample_label : "Starts from a neutral baseline"}</i>
      </div>
      {history.length > 1 && (
        <details
          className="rank-history"
          onToggle={(event) => {
            if (!event.currentTarget.open) return;
            const details = event.currentTarget;
            requestAnimationFrame(() => details.scrollIntoView({ block: "nearest" }));
          }}
        >
          <summary>Past versions</summary>
          <dl>
            {history.map((entry) => {
              const entrySummary = realityRankSummary({ score: entry.score, sample_size: entry.sample_size });
              return (
                <div key={`${entry.agent_revision}-${entry.current}`}>
                  <dt>{entry.current ? "Current" : `Version ${shortRevision(entry.agent_revision)}`}</dt>
                  <dd>{entrySummary.score_label} · {entrySummary.sample_label}</dd>
                </div>
              );
            })}
          </dl>
        </details>
      )}
    </div>
  );
}

export function AgentCatalog({
  agents,
  auth,
  togglingAgentId,
  sessionId,
  onCreate,
  onEdit,
  onAdopt,
  onArchive,
  onDelete,
  onToggle,
  onPublish,
  onUnpublish
}) {
  const [query, setQuery] = useState("");
  const canWrite = !auth?.is_viewer;
  const filtered = agents
    .filter((agent) => !agent.document && !agent.resource_for_agent_id)
    .filter((agent) => !query || `${agent.title || ""} ${agent.capability || ""}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => Number(canManageAgent(right, auth)) - Number(canManageAgent(left, auth))
      || String(left.title || left.id).localeCompare(String(right.title || right.id)));
  return (
    <section className="resource-section" aria-labelledby="agents-heading">
      <div className="section-heading">
        <div>
          <h3 id="agents-heading">Agents</h3>
          <p>Build specialists, choose them with @, or let the Router assemble a team.</p>
        </div>
        <IconButton label="Create agent" onClick={onCreate} disabled={!canWrite}>
          <Plus size={18} />
        </IconButton>
      </div>
      <label className="search-field full-width">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Search agents</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents" />
      </label>
      <div className="flat-list agent-list">
        {filtered.map((agent) => {
          const runtimeOnly = agent.runtime_only === true;
          const archived = agent.enabled === false;
          const manageable = !runtimeOnly && canManageAgent(agent, auth);
          const sessionToggleable = canWrite && !runtimeOnly && !archived && Boolean(sessionId);
          return (
            <div className="agent-row" key={agent.id}>
              <span className={`status-dot ${archived ? "muted" : runtimeOnly ? "pending" : "ready"}`} aria-hidden="true" />
              <div className="row-copy">
                <strong>{formatAgentName(agent.id, agents)}</strong>
                <span>{agentFacingText(agent.capability, "Custom agent")}</span>
                <small>{archived ? "Archived" : runtimeOnly ? "Needs an owner" : `${agent.session_active === false ? "Off in this chat" : "On in this chat"} · ${agent.visibility === "private" ? "Private" : agent.visibility === "team" ? "Team" : "Available"}`}</small>
                <RealityRank rank={agent.reality_rank} />
              </div>
              {runtimeOnly && auth?.is_admin && (
                <div className="row-actions">
                  <IconButton label={`Adopt ${formatAgentName(agent.id, agents)}`} compact onClick={() => onAdopt(agent)}>
                    <UserPlus size={16} />
                  </IconButton>
                </div>
              )}
              {(sessionToggleable || manageable) && (
                <div className="row-actions">
                  {sessionToggleable && (
                    <label className="session-switch" title={`${agent.session_active === false ? "Activate" : "Deactivate"} for this chat`}>
                      <span className="sr-only">Active in this chat</span>
                      <input
                        type="checkbox"
                        checked={agent.session_active !== false}
                        disabled={togglingAgentId === agent.id}
                        onChange={(event) => onToggle(agent, event.target.checked)}
                      />
                      <i aria-hidden="true" />
                    </label>
                  )}
                  {manageable && !archived && <IconButton label={`Edit ${formatAgentName(agent.id, agents)}`} compact onClick={() => onEdit(agent)}>
                    <Pencil size={16} />
                  </IconButton>}
                  {manageable && !archived && (
                    <button
                      type="button"
                      className="agent-publish-action"
                      aria-label={`${agent.marketplace?.published ? "Edit the Marketplace description for" : "Publish"} ${formatAgentName(agent.id, agents)}`}
                      onClick={() => onPublish(agent)}
                    >
                      {agent.marketplace?.published ? <Pencil size={14} /> : <Upload size={14} />}
                      {agent.marketplace?.published ? "Edit description" : "Publish"}
                    </button>
                  )}
                  {manageable && agent.marketplace?.published && (
                    <button
                      type="button"
                      className="agent-unpublish-action"
                      aria-label={`Unpublish ${formatAgentName(agent.id, agents)} from Marketplace`}
                      onClick={() => onUnpublish(agent)}
                    >
                      <Globe2 size={14} />Unpublish
                    </button>
                  )}
                  {manageable && (archived ? agent.system_managed !== true && (
                    <IconButton label={`Permanently delete ${formatAgentName(agent.id, agents)}`} compact onClick={() => onDelete(agent)}>
                      <Trash2 size={16} />
                    </IconButton>
                  ) : (
                    <IconButton label={`Archive ${formatAgentName(agent.id, agents)}`} compact onClick={() => onArchive(agent)}>
                      <Archive size={16} />
                    </IconButton>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <p className="muted-empty">No agents found.</p>}
      </div>
    </section>
  );
}

export function graphConnections(agents) {
  const ids = new Set(agents.map((agent) => agent.id));
  const edges = new Map();
  function connect(from, to, kind) {
    if (!ids.has(from) || !ids.has(to) || from === to) return;
    const key = `${from}:${to}:${kind}`;
    if (!edges.has(key)) edges.set(key, { from, to, kind });
  }
  for (const agent of agents) {
    for (const resource of agent.resources || []) {
      const id = String(resource).match(/^agent:([a-z0-9_]+)$/)?.[1];
      if (id) connect(id, agent.id, "knowledge");
    }
    for (const input of agent.consumes || []) {
      const id = String(input).match(/^agent:([a-z0-9_]+):output$/)?.[1];
      if (id) connect(id, agent.id, "handoff");
    }
  }
  return [...edges.values()].slice(0, 240);
}

export function graphConnectionInputs(inputs = [], sourceId, connected = true) {
  const token = collaboratorToken(sourceId);
  const next = new Set(Array.isArray(inputs) ? inputs : []);
  if (connected) next.add(token);
  else next.delete(token);
  return [...next];
}

export function graphConnectionWouldCycle(edges = [], sourceId, destinationId) {
  if (!sourceId || !destinationId || sourceId === destinationId) return true;
  const downstream = new Map();
  for (const edge of edges) {
    if (!edge?.from || !edge?.to) continue;
    if (!downstream.has(edge.from)) downstream.set(edge.from, new Set());
    downstream.get(edge.from).add(edge.to);
  }
  const pending = [destinationId];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === sourceId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(downstream.get(current) || []));
  }
  return false;
}

export function graphPositionFromPointer(bounds, clientX, clientY) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const x = ((Number(clientX) - Number(bounds.left || 0)) / width) * 900;
  const y = ((Number(clientY) - Number(bounds.top || 0)) / height) * 560;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(64, Math.min(836, x)),
    y: Math.max(44, Math.min(516, y))
  };
}

export function graphEdgePath(from, to) {
  if (!from || !to) return "";
  const direction = to.x >= from.x ? 1 : -1;
  const bend = Math.max(42, Math.min(145, Math.abs(to.x - from.x) * 0.42));
  const verticalOffset = Math.abs(to.x - from.x) < 40 ? 52 : 0;
  return `M ${from.x} ${from.y} C ${from.x + direction * bend + verticalOffset} ${from.y}, ${to.x - direction * bend + verticalOffset} ${to.y}, ${to.x} ${to.y}`;
}

function graphTone(agentId) {
  return [...String(agentId || "agent")]
    .reduce((value, character) => value + character.charCodeAt(0), 0) % 6;
}

export function initialGraphPositions(agents) {
  const centerX = 450;
  const centerY = 278;
  const positions = {};
  if (!agents.length) return positions;
  const connectionCounts = new Map(agents.map((agent) => [agent.id, 0]));
  for (const edge of graphConnections(agents)) {
    connectionCounts.set(edge.from, (connectionCounts.get(edge.from) || 0) + 1);
    connectionCounts.set(edge.to, (connectionCounts.get(edge.to) || 0) + 1);
  }
  const ordered = [...agents].sort((left, right) =>
    (connectionCounts.get(right.id) || 0) - (connectionCounts.get(left.id) || 0)
      || String(left.title || left.id).localeCompare(String(right.title || right.id))
  );
  positions[ordered[0].id] = { x: centerX, y: centerY };
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  ordered.slice(1).forEach((agent, index) => {
    const progress = Math.sqrt((index + 1) / Math.max(1, ordered.length - 1));
    const angle = index * goldenAngle - Math.PI / 2;
    positions[agent.id] = {
      x: centerX + Math.cos(angle) * (90 + 270 * progress),
      y: centerY + Math.sin(angle) * (58 + 162 * progress)
    };
  });
  return positions;
}

export function storedGraphPositions(storageKey) {
  if (typeof window === "undefined" || !storageKey) return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([id, position]) => {
      const x = Number(position?.x);
      const y = Number(position?.y);
      return Number.isFinite(x) && Number.isFinite(y)
        ? [[id, { x: Math.max(64, Math.min(836, x)), y: Math.max(44, Math.min(516, y)) }]]
        : [];
    }));
  } catch {
    return {};
  }
}

export function AgentGraph({ agents, auth, storageKey, onConnect, onDisconnect }) {
  const eligibleGraphAgents = agents
    .filter((agent) => !agent.document && !agent.resource_for_agent_id && agent.enabled !== false);
  const graphAgents = eligibleGraphAgents.slice(0, 120);
  const graphAgentIds = graphAgents.map((agent) => agent.id).join("|");
  const [positions, setPositions] = useState(() => ({
    ...initialGraphPositions(graphAgents),
    ...storedGraphPositions(storageKey)
  }));
  const [focusedId, setFocusedId] = useState(null);
  const [connectMode, setConnectMode] = useState(false);
  const [connectFromId, setConnectFromId] = useState(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [graphError, setGraphError] = useState("");
  const canvasRef = useRef(null);
  const dragStateRef = useRef(null);
  const draggedRef = useRef(false);
  const edges = graphConnections(graphAgents);
  const focusedAgent = graphAgents.find((agent) => agent.id === focusedId);
  const focusedEdges = focusedId
    ? edges.filter((edge) => edge.from === focusedId || edge.to === focusedId)
    : [];

  useEffect(() => {
    setPositions((current) => ({ ...initialGraphPositions(graphAgents), ...current }));
  }, [agents.length]);

  useEffect(() => {
    if (typeof window === "undefined" || !storageKey) return;
    const visibleIds = new Set(graphAgentIds.split("|").filter(Boolean));
    const persisted = Object.fromEntries(Object.entries(positions).filter(([id]) => visibleIds.has(id)));
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(persisted));
    } catch {
      // Storage may be disabled or full; dragging remains functional in-memory.
    }
  }, [graphAgentIds, positions, storageKey]);

  function beginNodeDrag(event, agentId) {
    if (connectMode || connectionBusy) return;
    draggedRef.current = false;
    dragStateRef.current = {
      agentId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveNode(event) {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!draggedRef.current && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 4) {
      return;
    }
    draggedRef.current = true;
    const nextPosition = graphPositionFromPointer(
      canvasRef.current?.getBoundingClientRect(),
      event.clientX,
      event.clientY
    );
    if (!nextPosition) return;
    setPositions((current) => ({
      ...current,
      [drag.agentId]: nextPosition
    }));
  }

  function endNodeDrag(event) {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragStateRef.current = null;
  }

  function resetLayout() {
    setPositions(initialGraphPositions(graphAgents));
    setFocusedId(null);
    setConnectFromId(null);
    setGraphError("");
  }

  function toggleConnectMode() {
    setConnectMode((current) => !current);
    setConnectFromId(null);
    setGraphError("");
  }

  async function chooseNode(agent) {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    if (!connectMode) {
      setFocusedId((current) => current === agent.id ? null : agent.id);
      return;
    }
    if (!connectFromId) {
      setConnectFromId(agent.id);
      setFocusedId(agent.id);
      return;
    }
    if (connectFromId === agent.id) {
      setConnectFromId(null);
      setGraphError("Choose a different destination agent.");
      return;
    }
    if (!canManageAgent(agent, auth)) {
      setGraphError("Choose an agent you can edit as the destination.");
      return;
    }
    if (edges.some((edge) => edge.from === connectFromId && edge.to === agent.id && edge.kind === "handoff")) {
      setGraphError("Those agents already have a handoff connection.");
      return;
    }
    if (graphConnectionWouldCycle(edges, connectFromId, agent.id)) {
      setGraphError("That handoff would create a circular workflow. Choose another direction.");
      return;
    }
    setConnectionBusy(true);
    setGraphError("");
    try {
      await onConnect?.(connectFromId, agent.id);
      setFocusedId(agent.id);
      setConnectMode(false);
      setConnectFromId(null);
    } catch {
      setGraphError("The connection could not be saved.");
    } finally {
      setConnectionBusy(false);
    }
  }

  async function removeConnection(edge) {
    if (edge.kind !== "handoff" || connectionBusy) return;
    const target = graphAgents.find((agent) => agent.id === edge.to);
    if (!canManageAgent(target, auth)) {
      setGraphError("You can remove connections only from agents you can edit.");
      return;
    }
    setConnectionBusy(true);
    setGraphError("");
    try {
      await onDisconnect?.(edge.from, edge.to);
    } catch {
      setGraphError("The connection could not be removed.");
    } finally {
      setConnectionBusy(false);
    }
  }

  return (
    <section className="resource-section graph-section" aria-labelledby="graph-heading">
      <div className="graph-heading-row">
        <div className="section-heading graph-title">
          <div><span className="section-eyebrow">TEAM MAP</span><h3 id="graph-heading">Connect how agents think together.</h3><p>Arrange the map, then draw a handoff from one specialist to the next.</p></div>
          <span className="graph-count">{graphAgents.length}{eligibleGraphAgents.length > graphAgents.length ? ` of ${eligibleGraphAgents.length}` : ""} agents · {edges.length} connections</span>
        </div>
        <div className="graph-toolbar" aria-label="Graph tools">
          <button type="button" className={connectMode ? "active" : ""} onClick={toggleConnectMode} disabled={auth?.is_viewer || graphAgents.length < 2 || connectionBusy}>
            <Network size={15} />{connectMode ? "Cancel connection" : "Connect agents"}
          </button>
          <button type="button" onClick={resetLayout} disabled={!graphAgents.length || connectionBusy}><RefreshCw size={15} />Reset layout</button>
        </div>
      </div>
      <div className={`graph-guidance ${connectMode ? "active" : ""}`} role="status" aria-live="polite">
        <span>{connectMode ? connectFromId ? "Now choose the destination agent." : "Choose the agent that will send its work." : "Drag agents to organize the map. Select an agent to inspect its connections."}</span>
        {connectFromId && <strong>From: {formatAgentName(connectFromId, agents)}</strong>}
        {graphError && <em>{graphError}</em>}
      </div>
      <div className={`graph-workspace ${focusedAgent && !connectMode ? "has-inspector" : ""}`}>
        <div className={`agent-graph ${connectMode ? "is-connecting" : ""}`} ref={canvasRef}>
        <svg viewBox="0 0 900 560" preserveAspectRatio="none" role="img" aria-label="Interactive agent mind map">
          <defs>
            <marker id="graph-arrow-handoff" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" />
            </marker>
            <marker id="graph-arrow-knowledge" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const path = graphEdgePath(positions[edge.from], positions[edge.to]);
            if (!path) return null;
            const related = focusedId && (edge.from === focusedId || edge.to === focusedId);
            return (
              <g className={`graph-edge ${edge.kind} ${related ? "related" : ""}`} key={`${edge.from}-${edge.to}-${edge.kind}`}>
                <path className="edge-line" d={path} markerEnd={`url(#graph-arrow-${edge.kind})`} vectorEffect="non-scaling-stroke" />
                <path
                  className="edge-hit"
                  d={path}
                  vectorEffect="non-scaling-stroke"
                  role="button"
                  tabIndex="0"
                  aria-label={`${formatAgentName(edge.from, agents)} sends work to ${formatAgentName(edge.to, agents)}`}
                  onClick={() => setFocusedId(edge.to)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setFocusedId(edge.to);
                  }}
                />
              </g>
            );
          })}
        </svg>
        {graphAgents.map((agent) => {
          const position = positions[agent.id] || { x: 450, y: 278 };
          const connectionCount = edges.filter((edge) => edge.from === agent.id || edge.to === agent.id).length;
          return (
            <button
              type="button"
              className={`graph-node tone-${graphTone(agent.id)} ${focusedId === agent.id ? "focused" : ""} ${connectFromId === agent.id ? "connection-source" : ""} ${agent.session_active === false ? "inactive" : ""}`}
              style={{ left: `${(position.x / 900) * 100}%`, top: `${(position.y / 560) * 100}%` }}
              key={agent.id}
              onPointerDown={(event) => beginNodeDrag(event, agent.id)}
              onPointerMove={moveNode}
              onPointerUp={endNodeDrag}
              onPointerCancel={endNodeDrag}
              onClick={() => chooseNode(agent)}
              title={agentFacingText(agent.capability || agent.title)}
            >
              <span>{formatAgentName(agent.id, agents)}</span>
              <small>{connectionCount ? `${connectionCount} connection${connectionCount === 1 ? "" : "s"}` : "Ready to connect"}</small>
            </button>
          );
        })}
        {graphAgents.length === 0 && <p className="graph-empty">Create an agent to start mapping your team.</p>}
        </div>
        {focusedAgent && !connectMode && (
          <aside className="graph-inspector" aria-label={`${formatAgentName(focusedId, agents)} connections`}>
            <header><span>SELECTED AGENT</span><button type="button" aria-label="Close agent details" onClick={() => setFocusedId(null)}><X size={14} /></button></header>
            <strong>{formatAgentName(focusedId, agents)}</strong>
            <p>{agentFacingText(focusedAgent.capability, "No capability description yet.")}</p>
            <div className="graph-relations">
              {focusedEdges.map((edge) => {
                const incoming = edge.to === focusedId;
                const otherId = incoming ? edge.from : edge.to;
                const removable = edge.kind === "handoff" && canManageAgent(graphAgents.find((agent) => agent.id === edge.to), auth);
                return (
                  <div key={`${edge.from}-${edge.to}-${edge.kind}`}>
                    <span><small>{incoming ? "Receives from" : "Sends to"}</small><b>{formatAgentName(otherId, agents)}</b><i>{edge.kind === "handoff" ? "Handoff" : "Knowledge"}</i></span>
                    {removable && <button type="button" onClick={() => removeConnection(edge)} disabled={connectionBusy} aria-label={`Remove connection with ${formatAgentName(otherId, agents)}`}><X size={13} /></button>}
                  </div>
                );
              })}
              {focusedEdges.length === 0 && <span className="graph-no-relations">No connections yet. Choose “Connect agents” to add the first handoff.</span>}
            </div>
          </aside>
        )}
      </div>
      <div className="graph-legend">
        <span className="palette"><i /><i /><i /></span><span>Color distinguishes agents</span>
        <span><i className="handoff" />Editable handoff</span><span><i className="knowledge" />Knowledge link</span>
      </div>
    </section>
  );
}

export function MarketplacePanel({ items, auth, onOpen = () => undefined, onRate = () => undefined }) {
  const [query, setQuery] = useState("");
  const filtered = items.filter((item) =>
    !query || `${item.title} ${item.description} ${item.capability} ${item.publisher_display_name || ""} ${item.published_by}`.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <section className="resource-section marketplace-section" aria-labelledby="marketplace-heading">
      <div className="marketplace-hero">
        <span><Sparkles size={15} /> COMMUNITY LIBRARY</span>
        <h3 id="marketplace-heading">Shared agents, ready to make your own.</h3>
        <p>Inspect how an agent works, see who published it, rate it, or copy an independent version into your workspace.</p>
      </div>
      <div className="marketplace-toolbar">
        <label className="search-field full-width"><Search size={16} /><span className="sr-only">Search marketplace</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents or publishers" /></label>
      </div>
      <div className="marketplace-grid">
        {filtered.map((item) => (
          <article className="market-card" key={item.listing_id || item.id}>
            <button type="button" className="market-card-open" onClick={() => onOpen(item)} aria-label={`View ${agentFacingText(item.title, "community agent")}`}>
              <header><span className="market-type agent"><Bot size={13} />agent</span><ChevronRight size={15} /></header>
              <h4>{agentFacingText(item.title, "Community agent")}</h4>
              <p>{agentFacingText(item.description || item.capability)}</p>
              <small className="market-author">Published by {item.publisher_display_name || item.publisher?.user_id || item.published_by || "Virenis"}</small>
              {item.workspace_copy && <span className="market-copy-state"><Check size={12} />Copied as {item.workspace_copy.title}</span>}
            </button>
            <footer>
              <span className="market-rating"><Star size={14} fill="currentColor" />{item.rating_count ? item.rating_average.toFixed(1) : "New"}<small>{item.rating_count ? `(${item.rating_count})` : ""}</small></span>
              {item.is_self_published
                ? <span className="market-own-listing"><Check size={12} />Your listing</span>
                : <button type="button" onClick={() => onRate(item)} disabled={auth?.is_viewer}>{item.my_rating ? "Update rating" : "Rate"}</button>}
            </footer>
          </article>
        ))}
        {filtered.length === 0 && <div className="market-empty"><Sparkles size={22} /><strong>No matches yet</strong><span>Try a broader search or publish an agent from the Agents tab.</span></div>}
      </div>
    </section>
  );
}

export function PublishDialog({ agent, onClose, onSaved }) {
  const existing = agent.marketplace || {};
  const [description, setDescription] = useState(agentFacingText(existing.description || existing.summary || agent.capability));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/marketplace/items/${encodeURIComponent(agent.id)}`, {
        item_type: "agent",
        description
      });
      await onSaved();
    } catch (publishError) {
      setError(friendlyError(publishError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalSurface title={existing.published ? "Edit Marketplace description" : "Publish to Marketplace"} description="Share a clear description. People can inspect the agent before copying it." onClose={onClose} className="form-dialog">
      <form className="dialog-form publish-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="publish-subject"><span className="market-type agent"><Bot size={13} />agent</span><strong>{formatAgentName(agent.id, [agent])}</strong></div>
        <label><span>Agent description</span><textarea data-autofocus value={description} onChange={(event) => setDescription(event.target.value)} required maxLength={1200} placeholder="Explain what this agent helps with and when someone should use it." /></label>
        <div className="publish-note"><Bot size={16} /><span><strong>Safe sharing</strong><small>Private notes, uploaded knowledge, and workspace-only agent connections are not included.</small></span></div>
        <div className="dialog-actions"><button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="text-button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : existing.published ? <Pencil size={16} /> : <Upload size={16} />}{existing.published ? "Save description" : "Publish"}</button></div>
      </form>
    </ModalSurface>
  );
}

export function RatingDialog({ item, onClose, onSaved }) {
  const [score, setScore] = useState(item.my_rating?.score || 5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/marketplace/items/${encodeURIComponent(item.id)}/ratings`, { score });
      await onSaved();
    } catch (ratingError) {
      setError(friendlyError(ratingError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalSurface title={`Rate ${agentFacingText(item.title, "agent")}`} description="Select a star rating from 1 to 5." onClose={onClose} className="small-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <fieldset className="star-picker"><legend>Your rating</legend>{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} aria-label={`${value} star${value === 1 ? "" : "s"}`} aria-pressed={score === value} onClick={() => setScore(value)}><Star size={25} fill={value <= score ? "currentColor" : "none"} /></button>)}</fieldset>
        <div className="dialog-actions"><button type="button" className="text-button ghost" onClick={onClose}>Cancel</button><button type="submit" className="text-button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Star size={16} />}Save rating</button></div>
      </form>
    </ModalSurface>
  );
}

export function MarketplaceAgentDialog({ item, auth, onClose, onRate, onCopied, onEditDescription = () => undefined, onUnpublish = () => undefined }) {
  const [detail, setDetail] = useState(item);
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get(`/api/marketplace/items/${encodeURIComponent(item.id)}`)
      .then((payload) => {
        if (active) setDetail(payload);
      })
      .catch((detailError) => {
        if (active) setError(friendlyError(detailError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [item.id]);

  async function copyToWorkspace() {
    if (copying) return;
    setCopying(true);
    setError("");
    try {
      const result = await api.post(`/api/marketplace/items/${encodeURIComponent(item.id)}/copy`, {});
      await onCopied(result.agent);
    } catch (copyError) {
      setError(friendlyError(copyError));
    } finally {
      setCopying(false);
    }
  }

  const agent = detail.agent || {};
  const publisher = detail.publisher_display_name || detail.publisher?.user_id || detail.published_by || "Virenis";
  const exclusions = agent.exclusions || {};
  const tools = agent.tools || [];
  const consumes = agent.consumes || [];
  const produces = agent.produces || [];
  const cues = agent.routing_cues || [];
  const connectorRequirements = agent.connector_requirements || [];
  return (
    <ModalSurface
      title={agentFacingText(detail.title, "Marketplace agent")}
      description={`Published by ${publisher}`}
      onClose={onClose}
      className="agent-builder-dialog marketplace-agent-dialog"
    >
      <div className="marketplace-detail-body">
        {error && <div className="form-error" role="alert">{error}</div>}
        {loading && <div className="marketplace-detail-loading"><LoaderCircle className="spin" size={18} />Loading agent details</div>}
        <div className="marketplace-detail-layout">
          <main className="marketplace-detail-content">
            <section className="builder-panel marketplace-detail-intro">
              <div className="builder-heading">
                <span>MARKETPLACE DESCRIPTION</span>
                <h3>{agentFacingText(detail.description || detail.capability)}</h3>
                <p>Published by <strong>{publisher}</strong>{detail.published_at ? ` on ${formatDate(detail.published_at)}` : ""}.</p>
              </div>
            </section>

            <section className="builder-panel marketplace-detail-section" aria-labelledby="marketplace-purpose-heading">
              <div className="builder-heading"><span>AGENT BASICS</span><h3 id="marketplace-purpose-heading">Purpose and instructions</h3></div>
              <dl className="marketplace-spec-list">
                <div><dt>What it does</dt><dd>{agentFacingText(agent.capability, "No purpose provided.")}</dd></div>
                <div><dt>Instructions and limits</dt><dd>{agentFacingText(agent.boundary, "No additional limits provided.")}</dd></div>
              </dl>
            </section>

            <section className="builder-panel marketplace-detail-section" aria-labelledby="marketplace-workflow-heading">
              <div className="builder-heading"><span>TOOLS &amp; TEAMWORK</span><h3 id="marketplace-workflow-heading">How it works</h3></div>
              <dl className="marketplace-spec-list compact">
                <div><dt>Tools</dt><dd>{tools.length ? tools.map((value) => <span className="marketplace-spec-chip" key={value}>{value.replaceAll("_", " ")}</span>) : "No tools required"}</dd></div>
                <div><dt>Connections</dt><dd>{connectorRequirements.length ? connectorRequirements.flatMap((requirement) => requirement.tools.map((tool) => <span className="marketplace-spec-chip" key={`${requirement.connection_name}:${tool.name}`}>{requirement.connection_name} · {tool.title || tool.name}</span>)) : "No external connection required"}</dd></div>
                <div><dt>Receives</dt><dd>{consumes.length ? consumes.map((value) => <span className="marketplace-spec-chip" key={value}>{value.replaceAll("_", " ")}</span>) : "User request"}</dd></div>
                <div><dt>Produces</dt><dd>{produces.length ? produces.map((value) => <span className="marketplace-spec-chip" key={value}>{value.replaceAll("_", " ")}</span>) : "Domain output"}</dd></div>
                <div><dt>Router cues</dt><dd>{cues.length ? cues.join(", ") : "Uses its name and purpose"}</dd></div>
              </dl>
            </section>

            {(exclusions.private_knowledge || exclusions.agent_connections || exclusions.mcp_credentials_and_bindings) && (
              <div className="marketplace-sharing-boundary">
                <AlertCircle size={16} />
                <span><strong>Workspace-safe copy</strong><small>{[exclusions.private_knowledge ? "Private knowledge" : null, exclusions.agent_connections ? "workspace agent connections" : null, exclusions.mcp_credentials_and_bindings ? "live MCP credentials and bindings" : null].filter(Boolean).join(", ")} will not be copied. Connection requirements remain visible so you can bind your own workspace tools.</small></span>
              </div>
            )}
          </main>

          <aside className="builder-preview marketplace-detail-preview" aria-label="Marketplace agent summary">
            <div className="preview-badge"><Bot size={18} /><span>SHARED AGENT</span></div>
            <h4>{agentFacingText(detail.title, "Marketplace agent")}</h4>
            <p>{agentFacingText(detail.description || detail.capability)}</p>
            <dl>
              <div><dt>Publisher</dt><dd>{publisher}</dd></div>
              <div><dt>Tools</dt><dd>{tools.length || "None"}</dd></div>
              <div><dt>Connections</dt><dd>{connectorRequirements.length || "None"}</dd></div>
              <div><dt>Outputs</dt><dd>{produces.length || "Default"}</dd></div>
              <div><dt>Rating</dt><dd>{detail.rating_count ? `${detail.rating_average.toFixed(1)} / 5` : "Not rated"}</dd></div>
            </dl>
            <div className="marketplace-detail-rating"><Star size={17} fill="currentColor" /><strong>{detail.rating_count ? detail.rating_average.toFixed(1) : "New"}</strong><span>{detail.rating_count ? `${detail.rating_count} rating${detail.rating_count === 1 ? "" : "s"}` : detail.is_self_published ? "Your published agent" : "Be the first to rate"}</span></div>
            {detail.workspace_copy && <div className="preview-status"><Check size={14} /><div><strong>Already in your workspace</strong><small>{detail.workspace_copy.title}</small></div></div>}
          </aside>
        </div>

        <footer className="builder-actions marketplace-detail-actions">
          <button type="button" className="text-button ghost" onClick={onClose}>Close</button>
          <span>Published by {publisher}</span>
          <div>
            {detail.can_manage && <button type="button" className="text-button ghost marketplace-edit-action" onClick={() => onEditDescription(detail)} disabled={loading}><Pencil size={15} />Edit description</button>}
            {detail.can_manage && <button type="button" className="text-button danger marketplace-unpublish-action" onClick={() => onUnpublish(detail)} disabled={loading}><Globe2 size={15} />Unpublish</button>}
            {!detail.is_self_published && <button type="button" className="text-button ghost marketplace-rate-action" onClick={() => onRate(detail)} disabled={auth?.is_viewer || loading}><Star size={15} />{detail.my_rating ? "Update rating" : "Rate"}</button>}
            {detail.is_self_published && <span className="market-own-listing"><Check size={12} />Your listing</span>}
            <button type="button" className="text-button primary" onClick={copyToWorkspace} disabled={auth?.is_viewer || loading || copying}>{copying ? <LoaderCircle className="spin" size={16} /> : <Copy size={16} />}{copying ? "Copying" : detail.workspace_copy ? "Copy another" : "Copy to my workspace"}</button>
          </div>
        </footer>
      </div>
    </ModalSurface>
  );
}

function KnowledgeList({ documents, agents, auth, canWrite, onAdd, onDelete }) {
  return (
    <section className="resource-section" aria-labelledby="knowledge-heading">
      <div className="section-heading">
        <div>
          <h3 id="knowledge-heading">Knowledge</h3>
          <p>Reusable files available to your agents in every chat.</p>
        </div>
        <IconButton label="Add knowledge" onClick={onAdd} disabled={!canWrite}>
          <FilePlus2 size={18} />
        </IconButton>
      </div>
      <div className="flat-list knowledge-list">
        {documents.map((document) => {
          const parentAgent = agents.find((item) => item.id === document.resource_for_agent_id);
          return (
            <div className="knowledge-row" key={document.document_id}>
              <BookOpen size={18} aria-hidden="true" />
              <div className="row-copy">
                <strong>{document.title}</strong>
                <span>{document.chunks ? `${document.chunks} indexed sections` : "Ready to search"}</span>
                <small>{parentAgent ? `Used by ${formatAgentName(parentAgent.id, agents)}` : document.visibility === "private" ? "Private · All chats" : `${document.visibility || "Available"} · All chats`}</small>
              </div>
              {canManageDocument(document, agents, auth) && (
                <div className="row-actions">
                  <IconButton label={`Delete ${document.title || "knowledge"}`} compact onClick={() => onDelete(document)}>
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              )}
            </div>
          );
        })}
        {documents.length === 0 && <p className="muted-empty">No knowledge files yet.</p>}
      </div>
    </section>
  );
}

function AdminPanel({ runtime, metrics, agents, documents, onRefresh }) {
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);
  async function runChecks() {
    setChecking(true);
    try {
      const queued = await api.post("/api/admin/validation/run", { suite: "mock_smoke", case_filter: "patient_newsletter_faq" });
      let result = queued;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        result = await api.get(`/api/admin/validation/runs/${queued.validation_run_id}`);
        if (["completed", "failed"].includes(result.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      setCheckResult(result);
      await onRefresh();
    } catch (validationError) {
      setCheckResult({ status: "failed", message: friendlyError(validationError) });
    } finally {
      setChecking(false);
    }
  }
  const readyAgents = agents.filter((agent) => agent.enabled !== false).length;
  return (
    <section className="resource-section" aria-labelledby="admin-heading">
      <div className="section-heading">
        <div>
          <h3 id="admin-heading">Admin</h3>
          <p>Service health and workspace checks.</p>
        </div>
        <IconButton label="Refresh status" onClick={onRefresh}>
          <RefreshCw size={18} />
        </IconButton>
      </div>
      <dl className="stat-list">
        <div><dt>Service</dt><dd>{runtime?.ok === false ? "Needs attention" : "Ready"}</dd></div>
        <div><dt>Available agents</dt><dd>{readyAgents}</dd></div>
        <div><dt>Knowledge files</dt><dd>{documents.length}</dd></div>
        <div><dt>Completed runs</dt><dd>{metrics?.total_runs ?? 0}</dd></div>
        <div><dt>p95 response time</dt><dd>{metrics?.p95_end_to_end_latency ?? 0}s</dd></div>
      </dl>
      <button className="text-button secondary" type="button" onClick={runChecks} disabled={checking}>
        {checking ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
        Run workspace checks
      </button>
      {checkResult && (
        <p className={`check-result ${checkResult.status === "completed" && checkResult.ok !== false ? "success" : ""}`} role="status">
          {checkResult.status === "completed" && checkResult.ok !== false ? "Checks passed." : checkResult.message || `Check status: ${checkResult.status}`}
        </p>
      )}
      <AdminUsersPanel />
    </section>
  );
}

function RankTieBreakNote({ tieBreak, adapter, agents }) {
  const selectedName = formatAgentName(adapter, agents);
  const alternatives = tieBreak.tied_candidates.slice(0, 2);
  const comparison = alternatives.length
    ? `${selectedName} was preferred after equally relevant agents were compared using their verified result history.`
    : `The capability match was tied, so ${selectedName}'s verified result history was used as the final tie-break.`;
  const sampleText = tieBreak.sample_size === 1
    ? "1 verified result informed this choice."
    : tieBreak.sample_size > 1
      ? `${tieBreak.sample_size} verified results informed this choice.`
      : "No verified sample count was available for this comparison.";
  return (
    <div className="rank-route-note">
      <Scale size={16} aria-hidden="true" />
      <div>
        <strong>Past results broke a tie</strong>
        <span>{comparison} {sampleText}</span>
      </div>
    </div>
  );
}

function RunDetailsSheet({
  run,
  agents,
  contractsById,
  canWrite,
  onClose,
  onCreateOutcome,
  onSettleOutcome,
  onDisputeOutcome,
  onCorrectOutcome
}) {
  const [view, setView] = useState("agents");
  const routeSelections = new Map((run?.plan?.routing?.selected || []).map((item) => [item.adapter, item]));
  const contracts = run?.outcome_contracts || [];
  const hasOutcome = contracts.length > 0;
  return (
    <ModalSurface title="Answer details" description={run ? runStatusLabel(run.status) : "Loading details"} side="right" onClose={onClose}>
      <div className="sheet-body details-sheet-body">
        {!run && <div className="center-state"><LoaderCircle className="spin" size={19} />Loading details</div>}
        {run && (
          <>
            <div className="view-switch four-up" aria-label="Answer detail view">
              <button type="button" aria-pressed={view === "agents"} onClick={() => setView("agents")}>Agents</button>
              <button type="button" aria-pressed={view === "sources"} onClick={() => setView("sources")}>Sources</button>
              <button type="button" aria-pressed={view === "outcomes"} onClick={() => setView("outcomes")}>Results</button>
              <button type="button" aria-pressed={view === "activity"} onClick={() => setView("activity")}>Activity</button>
            </div>

            {view === "agents" && (
              <section className="detail-section" aria-labelledby="used-agents-heading">
                <div className="section-heading compact-heading">
                  <div><h3 id="used-agents-heading">Agents used</h3><p>{run.expert_outputs?.length || 0} contributors to this answer.</p></div>
                </div>
                <div className="detail-list">
                  {(run.expert_outputs || []).map((route) => {
                    const selection = routeSelections.get(route.adapter);
                    const tieBreak = realityRankTieBreak(run?.plan?.routing, route.adapter);
                    return (
                      <details className="detail-row" key={route.step_id || route.adapter}>
                        <summary>
                          <span className="status-dot ready" aria-hidden="true" />
                          <span>
                            <strong>{formatAgentName(route.adapter, agents)}</strong>
                            <small>{selection?.reason || route.task || "Completed its part of the answer"}</small>
                          </span>
                          {tieBreak
                            ? <em>Past results</em>
                            : selection?.confidence != null && <em>{Math.round(selection.confidence * 100)}%</em>}
                        </summary>
                        <div className="detail-row-content">
                          {tieBreak && <RankTieBreakNote tieBreak={tieBreak} adapter={route.adapter} agents={agents} />}
                          {route.task && <p><strong>Task</strong>{route.task}</p>}
                          {route.domain_answer && <p><strong>Contribution</strong>{route.domain_answer}</p>}
                          {route.boundary_check && <p><strong>Checks</strong>{route.boundary_check}</p>}
                        </div>
                      </details>
                    );
                  })}
                  {!run.expert_outputs?.length && <p className="muted-empty">No agent details are available.</p>}
                </div>
              </section>
            )}

            {view === "sources" && (
              <section className="detail-section" aria-labelledby="sources-heading">
                <div className="section-heading compact-heading">
                  <div><h3 id="sources-heading">Sources</h3><p>Evidence returned with this answer.</p></div>
                </div>
                <div className="detail-list">
                  {(run.sources || []).map((source, index) => (
                    <div className="source-row" key={source.citation_id || source.chunk_id || index}>
                      <div>
                        <strong>{source.title || "Source"}</strong>
                        <span>{[source.page ? `Page ${source.page}` : "", source.chunk_id].filter(Boolean).join(" · ")}</span>
                      </div>
                      {source.verified === true && <small className="verified-label"><Check size={13} />Verified</small>}
                      {source.excerpt && <p>{source.excerpt}</p>}
                    </div>
                  ))}
                  {!run.sources?.length && <p className="muted-empty">No external sources were used.</p>}
                </div>
              </section>
            )}

            {view === "outcomes" && (
              <section className="detail-section" aria-labelledby="outcomes-heading">
                <div className="section-heading compact-heading">
                  <div><h3 id="outcomes-heading">Result tracking</h3><p>Choose a claim now, then record what happened later.</p></div>
                  {canWrite && run.status === "completed" && !hasOutcome && (
                    <IconButton label="Track a claim" onClick={onCreateOutcome}><Plus size={18} /></IconButton>
                  )}
                </div>
                <div className="detail-list">
                  {contracts.map((summary) => {
                    const contract = contractsById[summary.contract_id];
                    const current = contract || summary;
                    const lifecycle = outcomeLifecycleState(current, canWrite);
                    const status = current.status || summary.status;
                    const latestDispute = contract?.disputes?.at(-1);
                    return (
                      <div className="outcome-row" key={summary.contract_id}>
                        <div className="outcome-heading">
                          <span className={`status-dot ${status === "settled" ? "ready" : "pending"}`} aria-hidden="true" />
                          <div>
                            <strong>{summary.title}</strong>
                            <span>{status === "settled" ? "Settled" : status === "disputed" ? "Disputed" : summary.due_at ? `Due ${formatDate(summary.due_at)}` : "Pending"}</span>
                          </div>
                          {contract && (lifecycle.can_dispute || lifecycle.can_correct) && (
                            <div className="outcome-actions">
                              {lifecycle.can_dispute && (
                                <IconButton label="Dispute result" compact onClick={() => onDisputeOutcome(summary.contract_id)}>
                                  <Flag size={15} />
                                </IconButton>
                              )}
                              {lifecycle.can_correct && (
                                <IconButton label="Correct result" compact onClick={() => onCorrectOutcome(summary.contract_id)}>
                                  <RotateCcw size={15} />
                                </IconButton>
                              )}
                            </div>
                          )}
                        </div>
                        {contract?.claim && <p>{contract.claim}</p>}
                        {contract?.settlement && ["settled", "disputed"].includes(contract.status) && (
                          <dl className="outcome-result">
                            <div><dt>Actual result</dt><dd>{String(contract.settlement?.actual_value ?? "Recorded")}</dd></div>
                            <div><dt>Settled</dt><dd>{formatDate(contract.settled_at, { includeTime: true })}</dd></div>
                            <div><dt>Verification</dt><dd>{contract.settlement?.verified_for_rank === true ? "Verified result" : "Personal tracking"}</dd></div>
                          </dl>
                        )}
                        {status === "disputed" && latestDispute && (
                          <div className="dispute-note">
                            <Flag size={14} aria-hidden="true" />
                            <span>{latestDispute.reason}</span>
                          </div>
                        )}
                        {status === "settled" && contract?.settlement?.correction_reason && (
                          <div className="correction-note">
                            <RotateCcw size={14} aria-hidden="true" />
                            <span>{contract.settlement.correction_reason}</span>
                          </div>
                        )}
                        {status === "pending" && canWrite && (
                          <button type="button" className="text-button secondary" onClick={() => onSettleOutcome(summary.contract_id)} disabled={!lifecycle.can_settle}>
                            {lifecycle.can_settle ? <Check size={16} /> : <Clock3 size={16} />}
                            {lifecycle.can_settle ? "Record result" : `Available ${formatDate(contract?.resolution?.due_at || summary.due_at, { includeTime: true })}`}
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {contracts.length === 0 && (
                    <div className="empty-detail">
                      <Clock3 size={20} />
                      <p>No claim is being followed for this answer.</p>
                      {canWrite && run.status === "completed" && (
                        <button type="button" className="text-button secondary" onClick={onCreateOutcome}>
                          <Plus size={16} />Track a claim
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

            {view === "activity" && (
              <section className="detail-section" aria-labelledby="activity-heading">
                <div className="section-heading compact-heading">
                  <div><h3 id="activity-heading">Activity</h3><p>How the answer was assembled.</p></div>
                </div>
                <ol className="activity-list">
                  {(run.events || []).map((event, index) => (
                    <li key={`${event.type}-${event.at || event.ts || index}`}>
                      <span className="activity-marker" aria-hidden="true" />
                      <div><strong>{eventLabel(event.type)}</strong><small>{formatDate(event.at || event.ts, { includeTime: true })}</small></div>
                    </li>
                  ))}
                </ol>
                {run.execution && (
                  <details className="provenance-details">
                    <summary>Execution record</summary>
                    <dl>
                      <div><dt>Recorded</dt><dd>{run.execution.execution_id}</dd></div>
                      <div><dt>Integrity</dt><dd>{run.execution.record_hash}</dd></div>
                    </dl>
                  </details>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </ModalSurface>
  );
}

function eventLabel(type) {
  const labels = {
    "run.started": "Started",
    "planner.started": "Choosing agents",
    "planner.completed": "Agents selected",
    "runtime.requested": "Request accepted",
    "route.started": "Agent started",
    "route.completed": "Agent finished",
    "synthesis.started": "Composing answer",
    "final.completed": "Answer completed",
    "run.failed": "Answer failed"
  };
  return labels[type] || String(type || "Update").replaceAll(".", " ");
}

const AGENT_TEMPLATES = [
  {
    id: "research",
    label: "Research & explain",
    icon: FileSearch,
    capability: "Research a question, compare the available evidence, explain what is known, and make uncertainty clear.",
    tools: ["web_search"],
    consumes: ["user_request", "source_context"],
    produces: ["evidence_summary"]
  },
  {
    id: "monitor",
    label: "Monitor a source",
    icon: Globe2,
    capability: "Check an approved source for relevant updates, summarize what changed, and flag anything that needs attention.",
    tools: ["web_search"],
    consumes: ["user_request", "shared_memory"],
    produces: ["monitoring_update"]
  },
  {
    id: "analysis",
    label: "Analyze data",
    icon: Table2,
    capability: "Analyze supplied data, verify the calculations, surface patterns, and explain the practical meaning of the results.",
    tools: ["data_table", "calculator"],
    consumes: ["user_request", "table_context"],
    produces: ["analysis", "calculation_trace"]
  },
  {
    id: "writing",
    label: "Write & edit",
    icon: WandSparkles,
    capability: "Turn source material and instructions into clear, concise writing for the intended audience.",
    tools: [],
    consumes: ["user_request", "upstream_route_outputs"],
    produces: ["final_answer"]
  },
  {
    id: "coordinate",
    label: "Coordinate agents",
    icon: Network,
    capability: "Coordinate work from other agents, resolve overlaps, preserve important constraints, and prepare a unified handoff.",
    tools: [],
    consumes: ["user_request", "upstream_route_outputs"],
    produces: ["agent_handoff"]
  }
];

const RESPONSE_STYLES = [
  {
    id: "direct",
    title: "Direct",
    detail: "Lead with the answer and keep it concise.",
    boundary: "Lead with the useful answer, keep it concise, stay within this agent's purpose, and state uncertainty when it matters."
  },
  {
    id: "thorough",
    title: "Thorough",
    detail: "Explain the reasoning and important tradeoffs.",
    boundary: "Explain the reasoning, assumptions, and important tradeoffs. Use only approved tools and knowledge, and stay within this agent's purpose."
  },
  {
    id: "careful",
    title: "Careful",
    detail: "Prioritize evidence, limits, and uncertainty.",
    boundary: "Prioritize verified evidence, identify important limits, state uncertainty clearly, and do not go beyond this agent's purpose."
  }
];

const TOOL_OPTIONS = [
  { id: "web", title: "Web research", detail: "Find current public information", icon: Globe2, values: ["web_search"] },
  { id: "calculate", title: "Calculations", detail: "Check arithmetic and formulas", icon: Calculator, values: ["calculator"] },
  { id: "tables", title: "Data tables", detail: "Read and analyze tabular data", icon: Table2, values: ["data_table"] },
  { id: "documents", title: "Documents", detail: "Search attached files", icon: FileSearch, values: ["document_search", "document_read"] },
  { id: "code", title: "Code & repositories", detail: "Inspect approved project files", icon: Code2, values: ["repo_inspector"] },
  { id: "data", title: "Workspace data", detail: "Run approved read-only queries", icon: Database, values: ["sql_runner"] }
];

const CONTEXT_OPTIONS = [
  { value: "upstream_route_outputs", title: "Other agents' work", detail: "Use verified handoffs from earlier steps", icon: Network },
  { value: "shared_memory", title: "Conversation context", detail: "Use relevant context from the current work", icon: Layers3 },
  { value: "table_context", title: "Structured data", detail: "Receive tables or structured records", icon: Table2 }
];

const OUTPUT_OPTIONS = [
  { value: "domain_outputs", title: "Working answer" },
  { value: "evidence_summary", title: "Research notes" },
  { value: "recommendations", title: "Recommendations" },
  { value: "structured_data", title: "Structured data" },
  { value: "agent_handoff", title: "Handoff to another agent" },
  { value: "final_answer", title: "Final response" }
];

function resourceToken(agentId) {
  return `agent:${agentId}`;
}

function collaboratorToken(agentId) {
  return `agent:${agentId}:output`;
}

function createAgentForm(agent) {
  if (agent) {
    return {
      id: agent.id,
      title: agentFacingText(agent.title),
      capability: agentFacingText(agent.capability),
      boundary: agent.boundary || "",
      response_style: "thorough",
      routing_cues: (agent.routing_cues || []).join(", "),
      consumes: agent.consumes?.length ? [...agent.consumes] : ["user_request"],
      produces: agent.produces?.length ? [...agent.produces] : ["domain_outputs"],
      tools: (agent.tools || []).filter((tool) => !/^mcp_[a-f0-9]{8}_[a-z0-9_]+_[a-f0-9]{6}$/.test(tool)),
      mcp_bindings: (agent.mcp_bindings || []).map((binding) => ({
        connection_id: binding.connection_id,
        tool_names: (binding.tools || []).map((tool) => tool.name)
      })),
      resources: [...(agent.resources || [])],
      sources: (agent.sources || []).join(", "),
      source_text: "",
      item_type: "agent"
    };
  }
  const suffix = Date.now().toString(36).slice(-7);
  return {
    id: `custom_${suffix}`,
    title: "",
    capability: "",
    boundary: RESPONSE_STYLES[0].boundary,
    response_style: "direct",
    routing_cues: "",
    consumes: ["user_request"],
    produces: ["domain_outputs"],
    tools: [],
    mcp_bindings: [],
    resources: [],
    sources: "",
    source_text: "",
    item_type: "agent"
  };
}

function AgentDialog({ auth, agent, agents, documents, mcpConnections = [], onClose, onSaved }) {
  const editing = Boolean(agent);
  const [form, setForm] = useState(() => createAgentForm(agent));
  const [step, setStep] = useState(0);
  const [newFiles, setNewFiles] = useState([]);
  const [uploadedFileKeys, setUploadedFileKeys] = useState([]);
  const [createdAgentId, setCreatedAgentId] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputId = useId();
  const knowledgeDocuments = (documents || []).filter((document) => document.scope !== "chat" && document.enabled !== false);
  const collaboratorAgents = (agents || [])
    .filter((candidate) => candidate.id !== agent?.id && candidate.enabled !== false && !candidate.document && !candidate.resource_for_agent_id)
    .slice(0, 24);
  const selectedDocumentCount = knowledgeDocuments.filter((document) => form.resources.includes(resourceToken(document.agent_id))).length;

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleValue(key, value, checked) {
    setForm((current) => {
      const values = new Set(current[key] || []);
      if (checked) values.add(value);
      else values.delete(value);
      return { ...current, [key]: [...values] };
    });
  }

  function toggleTool(option) {
    const selected = option.values.every((value) => form.tools.includes(value));
    setForm((current) => {
      const values = new Set(current.tools);
      for (const value of option.values) {
        if (selected) values.delete(value);
        else values.add(value);
      }
      return { ...current, tools: [...values] };
    });
  }

  function toggleMcpTool(connectionId, toolName, checked) {
    setForm((current) => {
      const bindings = (current.mcp_bindings || []).map((binding) => ({
        connection_id: binding.connection_id,
        tool_names: [...binding.tool_names]
      }));
      let binding = bindings.find((item) => item.connection_id === connectionId);
      if (!binding && checked) {
        binding = { connection_id: connectionId, tool_names: [] };
        bindings.push(binding);
      }
      if (binding) {
        const names = new Set(binding.tool_names);
        if (checked) names.add(toolName);
        else names.delete(toolName);
        binding.tool_names = [...names];
      }
      return { ...current, mcp_bindings: bindings.filter((item) => item.tool_names.length) };
    });
  }

  function applyTemplate(template) {
    setForm((current) => ({
      ...current,
      capability: template.capability,
      tools: [...template.tools],
      consumes: [...new Set(["user_request", ...template.consumes])],
      produces: [...template.produces]
    }));
  }

  function changeResponseStyle(style) {
    setForm((current) => ({ ...current, response_style: style.id, boundary: style.boundary }));
  }

  function addFiles(fileList) {
    const accepted = Array.from(fileList || []).filter((file) => /\.(pdf|md|markdown|txt)$/i.test(file.name));
    if (!accepted.length && fileList?.length) {
      setError("Add a PDF, Markdown, or text file.");
      return;
    }
    setError("");
    setNewFiles((current) => {
      const keys = new Set(current.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
      return [...current, ...accepted.filter((file) => !keys.has(`${file.name}:${file.size}:${file.lastModified}`))].slice(0, 8);
    });
  }

  function removeFile(target) {
    setNewFiles((current) => current.filter((file) => file !== target));
  }

  async function uploadResource(file, parentAgentId) {
    const body = new FormData();
    body.append("file", file);
    body.append("title", file.name.replace(/\.[^.]+$/, ""));
    body.append("routing_cues", [form.title, parentAgentId, file.name].filter(Boolean).join(", "));
    body.append("visibility", "private");
    body.append("scope", "knowledge");
    body.append("resource_for_agent_id", parentAgentId);
    body.append("capability", `Provides approved source material to ${form.title}.`);
    return api.postForm("/api/documents", body);
  }

  async function submit(event) {
    event.preventDefault();
    if (step < 2) {
      setStep((current) => current + 1);
      return;
    }
    setBusy(true);
    setError("");
    const activeAgentId = agent?.id || createdAgentId || form.id;
    const hasDocumentResources = form.resources.some((value) => value.startsWith("agent:")) || newFiles.length > 0;
    const payload = {
      item_type: form.item_type,
      title: form.title.trim(),
      capability: form.capability.trim(),
      boundary: form.boundary.trim() || RESPONSE_STYLES.find((style) => style.id === form.response_style)?.boundary || RESPONSE_STYLES[0].boundary,
      routing_cues: form.routing_cues || `${form.title}, ${form.capability}`,
      consumes: [...new Set(["user_request", ...form.consumes, ...(hasDocumentResources ? ["document_context"] : [])])],
      produces: form.produces.length ? form.produces : ["domain_outputs"],
      tools: [...new Set([...form.tools, ...(hasDocumentResources ? ["document_search", "document_read"] : [])])],
      mcp_bindings: form.mcp_bindings || [],
      resources: form.resources,
      source_text: form.source_text,
      ...(auth?.is_admin ? { sources: form.sources } : {})
    };
    let newAgentPersisted = Boolean(createdAgentId);
    try {
      if (editing || createdAgentId) {
        if (!payload.source_text) delete payload.source_text;
        await api.patch(`/api/agents/${encodeURIComponent(activeAgentId)}`, payload);
      } else {
        await api.post("/api/agents", { id: form.id, ...payload });
        setCreatedAgentId(form.id);
        newAgentPersisted = true;
      }

      let resources = [...payload.resources];
      const completed = new Set(uploadedFileKeys);
      for (const file of newFiles) {
        const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
        if (completed.has(fileKey)) continue;
        const uploaded = await uploadResource(file, activeAgentId);
        resources = [...new Set([...resources, resourceToken(uploaded.agent_id)])];
        setForm((current) => ({ ...current, resources }));
        completed.add(fileKey);
        setUploadedFileKeys([...completed]);
        await api.patch(`/api/agents/${encodeURIComponent(activeAgentId)}`, {
          resources,
          consumes: [...new Set([...payload.consumes, "document_context"])],
          tools: [...new Set([...payload.tools, "document_search", "document_read"])]
        });
      }
      await onSaved();
    } catch (saveError) {
      const prefix = !editing && newAgentPersisted
        ? "The agent was saved, but its setup is not finished. "
        : "";
      setError(`${prefix}${friendlyError(saveError)}`);
    } finally {
      setBusy(false);
    }
  }

  const steps = [
    { label: "Basics", detail: "Name and purpose" },
    { label: "Tools & teamwork", detail: "Abilities and handoffs" },
    { label: "Knowledge", detail: "Files and review" }
  ];
  const canContinue = step === 0 ? form.title.trim() && form.capability.trim() : step === 1 ? form.produces.length > 0 : true;

  return (
    <ModalSurface
      title={editing ? "Edit agent" : "Create an agent"}
      description={editing ? "Update how this agent works in future answers." : "Describe the role. Virenis will handle the API-backed technical setup."}
      onClose={onClose}
      className="agent-builder-dialog"
    >
      <form className="agent-builder" onSubmit={submit}>
        <nav className="builder-steps" aria-label="Agent setup progress">
          {steps.map((item, index) => (
            <button
              type="button"
              key={item.label}
              aria-current={step === index ? "step" : undefined}
              className={step === index ? "active" : index < step ? "complete" : ""}
              onClick={() => index <= step && setStep(index)}
              disabled={busy || index > step}
            >
              <span>{index < step ? <Check size={13} /> : index + 1}</span>
              <i><strong>{item.label}</strong><small>{item.detail}</small></i>
            </button>
          ))}
        </nav>

        <div className="builder-content">
          <div className="builder-main">
            {error && <div className="form-error" role="alert">{error}</div>}

            {step === 0 && (
              <section className="builder-panel" aria-labelledby="agent-basics-heading">
                <div className="builder-heading">
                  <span>STEP 1 OF 3</span>
                  <h3 id="agent-basics-heading">Start with the job, not the settings.</h3>
                  <p>A clear name and purpose are enough to create a useful first version.</p>
                </div>
                <div className="builder-field">
                  <label htmlFor="agent-name">Agent name</label>
                  <input id="agent-name" data-autofocus value={form.title} onChange={(event) => update("title", event.target.value)} required maxLength={160} placeholder="Launch risk analyst" />
                  <small>Use a name people will recognize when they call it with @.</small>
                </div>
                <div className="builder-field">
                  <label htmlFor="agent-purpose">What will this agent do?</label>
                  <textarea id="agent-purpose" value={form.capability} onChange={(event) => update("capability", event.target.value)} required maxLength={2400} placeholder="Review launch plans, find operational and market risks, and turn them into practical recommendations..." />
                  <small>Describe its expertise, how it should think, and what a good result looks like.</small>
                </div>
                <div className="template-picker">
                  <span>Or start from a common role</span>
                  <div>
                    {AGENT_TEMPLATES.map((template) => {
                      const Icon = template.icon;
                      return <button type="button" key={template.id} onClick={() => applyTemplate(template)}><Icon size={15} />{template.label}</button>;
                    })}
                  </div>
                </div>
                <fieldset className="choice-fieldset response-style-fieldset">
                  <legend>How should it respond?</legend>
                  <div className="response-style-grid">
                    {RESPONSE_STYLES.map((style) => (
                      <label className={form.response_style === style.id ? "selected" : ""} key={style.id}>
                        <input type="radio" name="response-style" checked={form.response_style === style.id} onChange={() => changeResponseStyle(style)} />
                        <span><strong>{style.title}</strong><small>{style.detail}</small></span>
                        <i>{form.response_style === style.id && <Check size={13} />}</i>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <details className="builder-details">
                  <summary><Settings2 size={15} /> Add specific guardrails</summary>
                  <div className="builder-field"><label htmlFor="agent-boundary">Instructions and limits</label><textarea id="agent-boundary" value={form.boundary} onChange={(event) => update("boundary", event.target.value)} /></div>
                </details>
              </section>
            )}

            {step === 1 && (
              <section className="builder-panel" aria-labelledby="agent-tools-heading">
                <div className="builder-heading">
                  <span>STEP 2 OF 3</span>
                  <h3 id="agent-tools-heading">Give it only the abilities it needs.</h3>
                  <p>Choose tools and decide how this agent fits into work done by other agents.</p>
                </div>
                <fieldset className="choice-fieldset">
                  <legend>Tools <small>optional</small></legend>
                  <p>Virenis will allow only the tools you select here.</p>
                  <div className="tool-choice-grid">
                    {TOOL_OPTIONS.map((option) => {
                      const Icon = option.icon;
                      const selected = option.values.every((value) => form.tools.includes(value));
                      return (
                        <label className={selected ? "selected" : ""} key={option.id}>
                          <input type="checkbox" checked={selected} onChange={() => toggleTool(option)} />
                          <Icon size={18} />
                          <span><strong>{option.title}</strong><small>{option.detail}</small></span>
                          <i>{selected && <Check size={13} />}</i>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <fieldset className="choice-fieldset mcp-tool-fieldset">
                  <legend>Connected tools <small>optional</small></legend>
                  <p>Only selected tools enter this agent's allowlist. Tools marked as actions always pause for your approval.</p>
                  {agent?.connector_requirements_pending?.length > 0 && (
                    <div className="connector-requirements-note">
                      <AlertCircle size={16} />
                      <span><strong>This Marketplace copy needs your own connections</strong><small>{agent.connector_requirements_pending.flatMap((requirement) => requirement.tools.map((tool) => `${requirement.connection_name}: ${tool.title || tool.name}`)).join(" · ")}</small></span>
                    </div>
                  )}
                  {mcpConnections.length > 0 ? (
                    <div className="mcp-agent-connections">
                      {mcpConnections.map((connection) => (
                        <details key={connection.connection_id} open={(form.mcp_bindings || []).some((binding) => binding.connection_id === connection.connection_id)}>
                          <summary><Plug size={15} /><span><strong>{connection.name}</strong><small>{connection.status === "ready" ? `${connection.tools?.length || 0} tools available` : "Reconnect this account in Connections"}</small></span></summary>
                          <div>
                            {(connection.tools || []).map((tool) => {
                              const selected = (form.mcp_bindings || []).some((binding) => binding.connection_id === connection.connection_id && binding.tool_names.includes(tool.name));
                              return (
                                <label className={selected ? "selected" : ""} key={tool.name}>
                                  <input type="checkbox" checked={selected} disabled={connection.status !== "ready" && !selected} onChange={(event) => toggleMcpTool(connection.connection_id, tool.name, event.target.checked)} />
                                  <span><strong>{tool.title || tool.name}</strong><small>{tool.description}</small></span>
                                  <i className={!tool.requires_approval ? "read" : "write"}>{!tool.requires_approval ? "Read" : "Approval"}</i>
                                </label>
                              );
                            })}
                          </div>
                        </details>
                      ))}
                    </div>
                  ) : <div className="inline-empty-connection"><Plug size={17} /><span><strong>No workspace connections</strong><small>Add one from Agent Studio → Connections, then return here.</small></span></div>}
                </fieldset>
                <fieldset className="choice-fieldset">
                  <legend>What context can it receive?</legend>
                  <p>The user's request is always included.</p>
                  <div className="compact-choice-grid">
                    {CONTEXT_OPTIONS.map((option) => {
                      const Icon = option.icon;
                      const selected = form.consumes.includes(option.value);
                      return (
                        <label className={selected ? "selected" : ""} key={option.value}>
                          <input type="checkbox" checked={selected} onChange={(event) => toggleValue("consumes", option.value, event.target.checked)} />
                          <Icon size={16} /><span><strong>{option.title}</strong><small>{option.detail}</small></span><i>{selected && <Check size={12} />}</i>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                {collaboratorAgents.length > 0 && (
                  <details className="builder-details collaborator-details">
                    <summary><Network size={15} /> Connect specific agents <span>{form.consumes.filter((value) => /^agent:.+:output$/.test(value)).length || "Optional"}</span></summary>
                    <p>Select agents whose completed work this agent may receive as a handoff.</p>
                    <div className="collaborator-list">
                      {collaboratorAgents.map((candidate) => {
                        const token = collaboratorToken(candidate.id);
                        return (
                          <label key={candidate.id}>
                            <input type="checkbox" checked={form.consumes.includes(token)} onChange={(event) => toggleValue("consumes", token, event.target.checked)} />
                            <Bot size={15} /><span><strong>{formatAgentName(candidate.id, agents)}</strong><small>{candidate.capability || "Agent"}</small></span>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                )}
                <fieldset className="choice-fieldset output-fieldset">
                  <legend>What should it produce?</legend>
                  <div className="output-chips">
                    {OUTPUT_OPTIONS.map((option) => {
                      const selected = form.produces.includes(option.value);
                      return <label className={selected ? "selected" : ""} key={option.value}><input type="checkbox" checked={selected} onChange={(event) => toggleValue("produces", option.value, event.target.checked)} />{selected && <Check size={12} />}{option.title}</label>;
                    })}
                  </div>
                </fieldset>
              </section>
            )}

            {step === 2 && (
              <section className="builder-panel" aria-labelledby="agent-knowledge-heading">
                <div className="builder-heading">
                  <span>STEP 3 OF 3</span>
                  <h3 id="agent-knowledge-heading">Add knowledge it can rely on.</h3>
                  <p>Attach a PDF or Markdown file here. It will become a resource for this agent, not another agent you need to manage.</p>
                </div>
                <div
                  className={`agent-dropzone ${dragActive ? "dragging" : ""}`}
                  onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }}
                  onDrop={(event) => { event.preventDefault(); setDragActive(false); addFiles(event.dataTransfer.files); }}
                >
                  <div className="dropzone-icon"><Upload size={19} /></div>
                  <strong>Drop reference files here</strong>
                  <span>PDF, Markdown, or text · up to 8 files</span>
                  <label htmlFor={fileInputId}>Choose files</label>
                  <input id={fileInputId} type="file" accept=".pdf,.md,.markdown,.txt" multiple onChange={(event) => addFiles(event.target.files)} />
                </div>
                {newFiles.length > 0 && (
                  <div className="pending-files" aria-label="Files to add">
                    {newFiles.map((file) => (
                      <div key={`${file.name}:${file.size}:${file.lastModified}`}><FilePlus2 size={16} /><span><strong>{file.name}</strong><small>{Math.max(1, Math.round(file.size / 1024))} KB</small></span><button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(file)}><X size={14} /></button></div>
                    ))}
                  </div>
                )}
                {knowledgeDocuments.length > 0 && (
                  <details className="builder-details existing-knowledge" open={selectedDocumentCount > 0}>
                    <summary><BookOpen size={15} /> Use existing knowledge <span>{selectedDocumentCount ? `${selectedDocumentCount} selected` : "Optional"}</span></summary>
                    <div className="knowledge-choice-list">
                      {knowledgeDocuments.map((document) => {
                        const token = resourceToken(document.agent_id);
                        const selected = form.resources.includes(token);
                        return (
                          <label className={selected ? "selected" : ""} key={document.document_id}>
                            <input type="checkbox" checked={selected} onChange={(event) => toggleValue("resources", token, event.target.checked)} />
                            <BookOpen size={16} /><span><strong>{document.title}</strong><small>{document.chunks ? `${document.chunks} indexed sections` : "Ready to search"}</small></span><i>{selected && <Check size={12} />}</i>
                          </label>
                        );
                      })}
                    </div>
                  </details>
                )}
                <details className="builder-details">
                  <summary><Sparkles size={15} /> Paste short notes <span>Optional</span></summary>
                  <div className="builder-field"><label htmlFor="agent-notes">Private notes and rules</label><textarea id="agent-notes" value={form.source_text} onChange={(event) => update("source_text", event.target.value)} placeholder="Paste facts, terminology, or rules this agent should use..." /></div>
                </details>
                <details className="builder-details">
                  <summary><Settings2 size={15} /> Advanced setup</summary>
                  <div className="advanced-builder-grid">
                    <div className="builder-field"><label htmlFor="agent-cues">When should Virenis use it?</label><textarea id="agent-cues" value={form.routing_cues} onChange={(event) => update("routing_cues", event.target.value)} placeholder={`${form.title || "Agent name"}, related topics, common requests`} /></div>
                    {auth?.is_admin && <div className="builder-field"><label htmlFor="agent-sources">Approved source paths</label><input id="agent-sources" value={form.sources} onChange={(event) => update("sources", event.target.value)} /></div>}
                  </div>
                </details>
              </section>
            )}
          </div>

          <aside className="builder-preview" aria-label="Agent summary">
            <div className="preview-badge"><Bot size={18} /><span>AGENT PREVIEW</span></div>
            <h4>{form.title || "Untitled agent"}</h4>
            <p>{form.capability || "Describe what this agent will do to see a summary here."}</p>
            <dl>
              <div><dt>Style</dt><dd>{RESPONSE_STYLES.find((style) => style.id === form.response_style)?.title || "Custom"}</dd></div>
              <div><dt>Tools</dt><dd>{form.tools.length + (form.mcp_bindings || []).reduce((total, binding) => total + binding.tool_names.length, 0) || "None"}</dd></div>
              <div><dt>Agent links</dt><dd>{form.consumes.filter((value) => /^agent:.+:output$/.test(value)).length || "None"}</dd></div>
              <div><dt>Knowledge</dt><dd>{selectedDocumentCount + newFiles.length || "None"}</dd></div>
            </dl>
            <div className="preview-status"><span /><div><strong>Private workspace</strong><small>Ready after setup completes</small></div></div>
          </aside>
        </div>

        <footer className="builder-actions">
          <button type="button" className="text-button ghost" onClick={step === 0 ? onClose : () => setStep((current) => current - 1)} disabled={busy}>
            {step === 0 ? "Cancel" : <><ArrowLeft size={15} /> Back</>}
          </button>
          <span>Step {step + 1} of 3</span>
          <button type="submit" className="text-button primary" disabled={busy || !canContinue}>
            {busy ? <LoaderCircle className="spin" size={16} /> : step < 2 ? <ArrowRight size={16} /> : editing ? <Check size={16} /> : <Plus size={16} />}
            {busy ? "Saving" : step < 2 ? "Continue" : editing ? "Save changes" : "Create agent"}
          </button>
        </footer>
      </form>
    </ModalSurface>
  );
}

function AdoptionDialog({ auth, agent, onClose, onSaved }) {
  const [owner, setOwner] = useState(auth?.user_id || "");
  const [visibility, setVisibility] = useState("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/admin/runtime-agents/${encodeURIComponent(agent.id)}/adopt`, {
        created_by: owner.trim(),
        visibility
      });
      await onSaved();
    } catch (adoptionError) {
      setError(friendlyError(adoptionError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSurface
      title="Adopt agent"
      description="Assign ownership before this runtime agent can be edited or archived."
      onClose={onClose}
      className="form-dialog"
    >
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="adoption-agent">
          <UserPlus size={18} aria-hidden="true" />
          <div><strong>{formatAgentName(agent.id, [agent])}</strong><small>Runtime agent</small></div>
        </div>
        <label>
          <span>Owner</span>
          <input data-autofocus value={owner} onChange={(event) => setOwner(event.target.value)} required maxLength={200} />
        </label>
        <label>
          <span>Access</span>
          <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
            <option value="private">Private to owner</option>
            <option value="team">Workspace</option>
            <option value="global">Everyone</option>
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="text-button primary" disabled={busy || !owner.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <UserPlus size={16} />}
            Adopt
          </button>
        </div>
      </form>
    </ModalSurface>
  );
}

function DocumentUploadDialog({ scope = "knowledge", sessionId = null, onClose, onUploaded }) {
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
      form.append("scope", scope);
      if (scope === "chat" && sessionId) form.append("session_id", sessionId);
      const uploaded = await api.postForm("/api/documents", form);
      await onUploaded(uploaded);
    } catch (uploadError) {
      setError(friendlyError(uploadError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalSurface
      title={scope === "chat" ? "Attach file to this chat" : "Add to Knowledge"}
      description={scope === "chat"
        ? "This file will be available only in this chat."
        : "This file will be available to your agents across all chats."}
      onClose={onClose}
      className="form-dialog"
    >
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label className="file-field">
          <span>File</span>
          <input data-autofocus type="file" accept=".pdf,.md,.markdown,.txt" onChange={(event) => setFile(event.target.files?.[0] || null)} required />
        </label>
        <label>
          <span>Name <small>optional</small></span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={file?.name?.replace(/\.[^.]+$/, "") || "Annual report"} />
        </label>
        <details className="advanced-fields">
          <summary><Settings2 size={15} />Advanced</summary>
          <div>
            <label><span>When to use this file</span><textarea value={routingCues} onChange={(event) => setRoutingCues(event.target.value)} placeholder="annual report, 2026 financial data" /></label>
          </div>
        </details>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="text-button primary" disabled={busy || !file}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
            {busy ? "Adding" : scope === "chat" ? "Attach" : "Add to Knowledge"}
          </button>
        </div>
      </form>
    </ModalSurface>
  );
}

function FeedbackDialog({ runId, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/chat/runs/${encodeURIComponent(runId)}/feedback`, { rating: "bad", reason });
      onSaved();
    } catch (feedbackError) {
      setError(friendlyError(feedbackError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalSurface title="Report a problem" description="Tell us what was wrong with this answer." onClose={onClose} className="small-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label><span>What happened?</span><textarea data-autofocus value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} /></label>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="text-button primary" disabled={busy || !reason.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Flag size={16} />}Send</button>
        </div>
      </form>
    </ModalSurface>
  );
}

function ConfirmDialog({ title, message, confirmLabel, destructive, icon: Icon, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ConfirmIcon = Icon || (destructive ? Archive : Check);
  return (
    <ModalSurface title={title} description={message} onClose={onClose} className="small-dialog">
      <div className="confirmation-body">
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="dialog-actions confirmation-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={`text-button ${destructive ? "danger" : "primary"}`}
            disabled={busy}
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              setError("");
              try {
                await onConfirm();
              } catch (confirmError) {
                setError(friendlyError(confirmError));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <ConfirmIcon size={16} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalSurface>
  );
}

function normalizedPredictionValue(value, outcomeType) {
  if (outcomeType === "categorical") return String(value || "").trim();
  if (String(value ?? "").trim() === "") return Number.NaN;
  return outcomeType === "binary" ? Number(value) / 100 : Number(value);
}

function initialOutcomePredictions(participants, outcomeType) {
  return Object.fromEntries(participants.map((participant) => {
    const inferred = outcomeType === "binary" ? extractBinaryPrediction(participant.domain_answer) : null;
    return [participant.step_id, inferred ? {
      value: inferred.percent,
      confidence: "50",
      abstained: false,
      evidence_quote: inferred.evidenceQuote
    } : {
      value: "",
      confidence: "50",
      abstained: true,
      evidence_quote: ""
    }];
  }));
}

function predictionEvidenceIsValid(participant, prediction, outcomeType) {
  if (prediction?.abstained) return true;
  return evidenceQuoteIsValid(
    participant.domain_answer,
    prediction?.evidence_quote,
    normalizedPredictionValue(prediction?.value, outcomeType),
    outcomeType
  );
}

function OutcomeDialog({ run, agents, auth, onClose, onSaved }) {
  const participants = run?.expert_outputs || [];
  const minimumDueDate = tomorrowDateValue();
  const [form, setForm] = useState(() => ({
    title: "",
    claim: "",
    domain: "general",
    task_type: "decision",
    outcome_type: "binary",
    metric: "Whether the claim happened",
    unit: "",
    due_at: "",
    error_scale: "1",
    allowed_values: "",
    resolver_type: "human",
    authority: auth?.user_id || "owner",
    reference: "",
    predictions: initialOutcomePredictions(participants, "binary")
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const predictionsAreValid = participants.length > 0 && participants.every((participant) => (
    predictionEvidenceIsValid(participant, form.predictions[participant.step_id], form.outcome_type)
  ));

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateOutcomeType(outcomeType) {
    setForm((current) => ({
      ...current,
      outcome_type: outcomeType,
      metric: outcomeType === "binary" ? "Whether the claim happened" : outcomeType === "numeric" ? "The final measured value" : "The final category",
      predictions: initialOutcomePredictions(participants, outcomeType)
    }));
  }

  function updatePrediction(stepId, key, value) {
    setForm((current) => ({
      ...current,
      predictions: {
        ...current.predictions,
        [stepId]: { ...current.predictions[stepId], [key]: value }
      }
    }));
  }

  function updatePredictionValue(participant, value) {
    setForm((current) => {
      const prediction = current.predictions[participant.step_id];
      const normalizedValue = normalizedPredictionValue(value, current.outcome_type);
      const existingEvidenceIsValid = evidenceQuoteIsValid(
        participant.domain_answer,
        prediction.evidence_quote,
        normalizedValue,
        current.outcome_type
      );
      const evidenceQuote = existingEvidenceIsValid
        ? prediction.evidence_quote
        : findEvidenceQuote(participant.domain_answer, normalizedValue, current.outcome_type);
      return {
        ...current,
        predictions: {
          ...current.predictions,
          [participant.step_id]: { ...prediction, value, evidence_quote: evidenceQuote }
        }
      };
    });
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (!predictionsAreValid) {
      setError("Each active prediction needs an exact passage from that agent's recorded answer containing the prediction value.");
      return;
    }
    setBusy(true);
    try {
      const outcomeType = form.outcome_type;
      const predictions = participants.map((participant) => {
        const prediction = form.predictions[participant.step_id];
        return {
          step_id: participant.step_id,
          value: prediction.abstained ? undefined : normalizedPredictionValue(prediction.value, outcomeType),
          confidence: prediction.abstained ? 0 : Number(prediction.confidence) / 100,
          abstained: prediction.abstained,
          evidence_quote: prediction.abstained ? undefined : prediction.evidence_quote.trim(),
          rationale: participant.domain_answer || participant.task || "Recorded from this answer."
        };
      });
      const resolution = {
        metric: form.metric,
        unit: form.unit || undefined,
        due_at: new Date(`${form.due_at}T23:59:59.999`).toISOString()
      };
      if (outcomeType === "numeric") resolution.error_scale = Number(form.error_scale);
      if (outcomeType === "categorical" && form.allowed_values.trim()) {
        resolution.allowed_values = form.allowed_values.split(",").map((value) => value.trim()).filter(Boolean);
      }
      await api.post(`/api/chat/runs/${encodeURIComponent(run.run_id)}/outcome-contracts`, {
        title: form.title.trim() || form.claim.trim().slice(0, 80),
        claim: form.claim,
        domain: slugifyValue(form.domain),
        task_type: slugifyValue(form.task_type || "decision"),
        outcome_type: outcomeType,
        resolver: {
          type: form.resolver_type,
          authority: form.authority,
          reference: form.reference
        },
        resolution,
        predictions
      });
      await onSaved();
    } catch (outcomeError) {
      setError(friendlyError(outcomeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSurface title="Track a claim" description="Set the question now. Record what actually happened when the date arrives." onClose={onClose} className="wide-dialog simple-tracking-dialog">
      <form className="dialog-form simple-tracking-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="tracking-form-intro">
          <Clock3 size={18} />
          <p><strong>One claim, one check-in.</strong><span>Virenis will keep this with the answer and remind you when a result can be recorded.</span></p>
        </div>
        <label className="claim-field">
          <span>What do you want to check?</span>
          <textarea data-autofocus value={form.claim} onChange={(event) => update("claim", event.target.value)} required placeholder="Trial conversion will exceed 12% by the end of September." />
          <small>Write a statement that will clearly be true, false, or measurable later.</small>
        </label>
        <fieldset className="tracking-type-fieldset">
          <legend>What kind of result will you record?</legend>
          <div>
            {[
              { value: "binary", title: "Yes or no", detail: "Did it happen?" },
              { value: "numeric", title: "A number", detail: "What was the value?" },
              { value: "categorical", title: "A category", detail: "Which result occurred?" }
            ].map((type) => (
              <label className={form.outcome_type === type.value ? "selected" : ""} key={type.value}>
                <input type="radio" name="result-type" checked={form.outcome_type === type.value} onChange={() => updateOutcomeType(type.value)} />
                <span><strong>{type.title}</strong><small>{type.detail}</small></span>
                <i>{form.outcome_type === type.value && <Check size={13} />}</i>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field-grid two-column tracking-essentials">
          <label><span>When should it be checked?</span><input type="date" min={minimumDueDate} value={form.due_at} onChange={(event) => update("due_at", event.target.value)} required /></label>
          <label><span>Where will the result come from?</span><input value={form.reference} onChange={(event) => update("reference", event.target.value)} required maxLength={1000} placeholder="Analytics report, public URL, review note..." /><small>This makes the final check easy to verify.</small></label>
          {form.outcome_type === "numeric" && <label><span>Unit <small>optional</small></span><input value={form.unit} onChange={(event) => update("unit", event.target.value)} placeholder="%, USD, users..." /></label>}
          {form.outcome_type === "numeric" && <label><span>Acceptable margin <small>optional</small></span><input type="number" min="0.000001" step="any" value={form.error_scale} onChange={(event) => update("error_scale", event.target.value)} /></label>}
          {form.outcome_type === "categorical" && <label className="span-two"><span>Possible results <small>optional, comma separated</small></span><input value={form.allowed_values} onChange={(event) => update("allowed_values", event.target.value)} placeholder="Approved, delayed, cancelled" /></label>}
        </div>
        <details className="advanced-fields prediction-details">
          <summary><Bot size={15} /> Agent estimates <span>{Object.values(form.predictions).filter((prediction) => !prediction.abstained).length} found in this answer</span></summary>
          <div>
            <p className="advanced-explainer">Virenis keeps any clear estimate already stated in the answer. Agents without a recorded estimate are skipped.</p>
            <fieldset className="prediction-fieldset">
              {participants.map((participant) => {
                const prediction = form.predictions[participant.step_id];
                const evidenceIsValid = predictionEvidenceIsValid(participant, prediction, form.outcome_type);
                return (
                  <div className="prediction-row" key={participant.step_id}>
                    <strong>{formatAgentName(participant.adapter, agents)}</strong>
                    <label>
                      <span>{form.outcome_type === "binary" ? "Chance (%)" : "Estimate"}</span>
                      <input type={form.outcome_type === "categorical" ? "text" : "number"} min={form.outcome_type === "binary" ? "0" : undefined} max={form.outcome_type === "binary" ? "100" : undefined} step={form.outcome_type === "numeric" ? "any" : undefined} value={prediction.value} onChange={(event) => updatePredictionValue(participant, event.target.value)} disabled={prediction.abstained} required={!prediction.abstained} />
                    </label>
                    <label><span>Confidence (%)</span><input type="number" min="0" max="100" value={prediction.confidence} onChange={(event) => updatePrediction(participant.step_id, "confidence", event.target.value)} disabled={prediction.abstained} required={!prediction.abstained} /></label>
                    <label className="check-label"><input type="checkbox" checked={prediction.abstained} onChange={(event) => updatePrediction(participant.step_id, "abstained", event.target.checked)} /><span>Skip</span></label>
                    {!prediction.abstained && (
                      <label className="prediction-evidence"><span>Exact passage from the answer</span><textarea value={prediction.evidence_quote} onChange={(event) => updatePrediction(participant.step_id, "evidence_quote", event.target.value)} required maxLength={500} /><small className={`evidence-status ${evidenceIsValid ? "valid" : "invalid"}`}>{evidenceIsValid ? "Passage matched" : "Use a passage containing this value"}</small></label>
                    )}
                  </div>
                );
              })}
            </fieldset>
          </div>
        </details>
        <details className="advanced-fields">
          <summary><Settings2 size={15} /> More details</summary>
          <div className="field-grid two-column">
            <label><span>Short name <small>optional</small></span><input value={form.title} onChange={(event) => update("title", event.target.value)} placeholder="September conversion" /></label>
            <label><span>Topic</span><input value={form.domain} onChange={(event) => update("domain", event.target.value)} required placeholder="general" /></label>
            <label className="span-two"><span>What is being measured?</span><input value={form.metric} onChange={(event) => update("metric", event.target.value)} required /></label>
            <label><span>Source type</span><select value={form.resolver_type} onChange={(event) => update("resolver_type", event.target.value)}><option value="human">Human review</option><option value="api">API</option><option value="document">Document</option></select></label>
            <label><span>Source owner</span><input value={form.authority} onChange={(event) => update("authority", event.target.value)} required maxLength={240} /></label>
          </div>
        </details>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="text-button primary" disabled={busy || !form.claim.trim() || !form.due_at || !form.reference.trim() || !predictionsAreValid}>{busy ? <LoaderCircle className="spin" size={16} /> : <Clock3 size={16} />}Start tracking</button>
        </div>
      </form>
    </ModalSurface>
  );
}

function mutationIdempotencyKey(scope) {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${scope}_${random}`;
}

function parseActualResult(contract, value) {
  if (contract.outcome_type === "binary") return value === "true";
  if (contract.outcome_type === "numeric") return Number(value);
  return value;
}

function ActualResultField({ contract, value, onChange, disabled = false, autofocus = false }) {
  const allowedValues = contract.outcome_type === "categorical" ? contract.resolution?.allowed_values || [] : [];
  return (
    <label>
      <span>Actual result</span>
      {contract.outcome_type === "binary" ? (
        <select data-autofocus={autofocus || undefined} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} required>
          <option value="" disabled>Choose result</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : allowedValues.length > 0 ? (
        <select data-autofocus={autofocus || undefined} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} required>
          <option value="" disabled>Choose result</option>
          {allowedValues.map((allowedValue) => <option value={allowedValue} key={allowedValue}>{allowedValue}</option>)}
        </select>
      ) : (
        <input
          data-autofocus={autofocus || undefined}
          type={contract.outcome_type === "numeric" ? "number" : "text"}
          step={contract.outcome_type === "numeric" ? "any" : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          required
        />
      )}
    </label>
  );
}

function FrozenResolver({ resolver }) {
  const sourceType = resolver?.type === "api" ? "API" : resolver?.type === "document" ? "Document" : "Human review";
  return (
    <div className="frozen-resolver">
      <span>Frozen result source</span>
      <strong>{sourceType} · {resolver?.authority}</strong>
      <code>{resolver?.reference}</code>
    </div>
  );
}

function SettlementDialog({ contract, onClose, onSaved }) {
  const dueAt = contract.resolution?.due_at;
  const [now, setNow] = useState(Date.now());
  const [actualValue, setActualValue] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const idempotencyKeyRef = useRef(null);
  const isDue = outcomeIsDue(contract, now);

  useEffect(() => {
    const dueTime = Date.parse(String(dueAt || ""));
    if (!Number.isFinite(dueTime) || dueTime <= now) return undefined;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(dueTime - now + 25, 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [dueAt, now]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!outcomeIsDue(contract)) {
      setNow(Date.now());
      setError("The result cannot be recorded before its check date.");
      return;
    }
    setBusy(true);
    try {
      const idempotencyKey = idempotencyKeyRef.current
        || mutationIdempotencyKey(`settlement_${contract.contract_id}`);
      idempotencyKeyRef.current = idempotencyKey;
      const settled = await api.post(`/api/outcome-contracts/${encodeURIComponent(contract.contract_id)}/settlements`, {
        actual_value: parseActualResult(contract, actualValue),
        source: {
          type: contract.resolver.type,
          authority: contract.resolver.authority,
          reference: contract.resolver.reference
        },
        notes
      }, { idempotencyKey });
      await onSaved(settled);
    } catch (settlementError) {
      setError(friendlyError(settlementError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSurface title="Record the result" description={contract.title} onClose={onClose} className="form-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className={`due-notice ${isDue ? "ready" : ""}`}>
          <Clock3 size={17} />
          <div>
            <strong>{isDue ? "Ready to settle" : `Available ${formatDate(dueAt, { includeTime: true })}`}</strong>
            <span>{isDue ? "The contract's due time has passed." : "Results cannot be recorded before this time."}</span>
          </div>
        </div>
        <ActualResultField
          contract={contract}
          value={actualValue}
          onChange={(value) => {
            idempotencyKeyRef.current = null;
            setActualValue(value);
          }}
          disabled={!isDue}
          autofocus={isDue}
        />
        <FrozenResolver resolver={contract.resolver} />
        <label><span>Notes <small>optional</small></span><textarea value={notes} onChange={(event) => {
          idempotencyKeyRef.current = null;
          setNotes(event.target.value);
        }} disabled={!isDue} /></label>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="text-button primary" disabled={busy || !isDue || !String(actualValue).trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : isDue ? <Check size={16} /> : <Clock3 size={16} />}{isDue ? "Record result" : "Not available yet"}</button>
        </div>
      </form>
    </ModalSurface>
  );
}

function DisputeDialog({ contract, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isDue = outcomeIsDue(contract);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (contract.status !== "settled" || !isDue) {
      setError("Only a settled result can be disputed after its due time.");
      return;
    }
    setBusy(true);
    try {
      const disputed = await api.post(`/api/outcome-contracts/${encodeURIComponent(contract.contract_id)}/disputes`, {
        reason: reason.trim()
      });
      await onSaved(disputed);
    } catch (disputeError) {
      setError(friendlyError(disputeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSurface title="Dispute result" description={contract.title} onClose={onClose} className="form-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <dl className="outcome-result dispute-result">
          <div><dt>Recorded result</dt><dd>{String(contract.settlement?.actual_value ?? "Recorded")}</dd></div>
          <div><dt>Recorded</dt><dd>{formatDate(contract.settled_at, { includeTime: true })}</dd></div>
        </dl>
        <FrozenResolver resolver={contract.resolver} />
        <label>
          <span>Why is this result incorrect?</span>
          <textarea data-autofocus value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={2000} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="text-button danger" disabled={busy || !reason.trim() || !isDue}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Flag size={16} />}
            Dispute
          </button>
        </div>
      </form>
    </ModalSurface>
  );
}

function CorrectionDialog({ contract, onClose, onSaved }) {
  const dueAt = contract.resolution?.due_at;
  const [now, setNow] = useState(Date.now());
  const [actualValue, setActualValue] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const idempotencyKeyRef = useRef(null);
  const isDue = outcomeIsDue(contract, now);

  useEffect(() => {
    const dueTime = Date.parse(String(dueAt || ""));
    if (!Number.isFinite(dueTime) || dueTime <= now) return undefined;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(dueTime - now + 25, 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [dueAt, now]);

  function change(setter, value) {
    idempotencyKeyRef.current = null;
    setter(value);
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!["settled", "disputed"].includes(contract.status) || !outcomeIsDue(contract)) {
      setNow(Date.now());
      setError("This result cannot be corrected before its due time.");
      return;
    }
    setBusy(true);
    try {
      const idempotencyKey = idempotencyKeyRef.current
        || mutationIdempotencyKey(`correction_${contract.contract_id}`);
      idempotencyKeyRef.current = idempotencyKey;
      const corrected = await api.post(`/api/outcome-contracts/${encodeURIComponent(contract.contract_id)}/corrections`, {
        supersedes_settlement_id: contract.settlement.settlement_id,
        actual_value: parseActualResult(contract, actualValue),
        reason: reason.trim(),
        source: {
          type: contract.resolver.type,
          authority: contract.resolver.authority,
          reference: contract.resolver.reference
        },
        notes
      }, { idempotencyKey });
      await onSaved(corrected);
    } catch (correctionError) {
      setError(friendlyError(correctionError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSurface title="Correct result" description={contract.title} onClose={onClose} className="form-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className={`due-notice ${isDue ? "ready" : ""}`}>
          <Clock3 size={17} />
          <div>
            <strong>{isDue ? "Ready to correct" : `Available ${formatDate(dueAt, { includeTime: true })}`}</strong>
            <span>{isDue ? "This correction will supersede the current result." : "Results cannot be corrected before this time."}</span>
          </div>
        </div>
        <dl className="outcome-result previous-result">
          <div><dt>Current result</dt><dd>{String(contract.settlement?.actual_value ?? "Recorded")}</dd></div>
        </dl>
        <ActualResultField contract={contract} value={actualValue} onChange={(value) => change(setActualValue, value)} disabled={!isDue} autofocus={isDue} />
        <FrozenResolver resolver={contract.resolver} />
        <label><span>Reason for correction</span><textarea value={reason} onChange={(event) => change(setReason, event.target.value)} disabled={!isDue} required maxLength={2000} /></label>
        <label><span>Notes <small>optional</small></span><textarea value={notes} onChange={(event) => change(setNotes, event.target.value)} disabled={!isDue} maxLength={2000} /></label>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="text-button primary" disabled={busy || !isDue || !String(actualValue).trim() || !reason.trim()}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}
            Correct result
          </button>
        </div>
      </form>
    </ModalSurface>
  );
}

function slugifyValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}
