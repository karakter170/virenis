import {
  AlertCircle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AtSign,
  BookOpen,
  Bot,
  Calculator,
  CalendarDays,
  Check,
  ChevronDown,
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
  ShieldCheck,
  Slack,
  Sparkles,
  Star,
  SquarePen,
  Table2,
  Trash2,
  Upload,
  UserPlus,
  WalletCards,
  WandSparkles,
  ListTodo,
  X
} from "lucide-react";
import { UserButton, useAuth, useClerk } from "@clerk/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import LandingPage from "./LandingPage.jsx";
import { AccountPanel, AdminUsersPanel, IdentityPage, SessionRecoveryPage } from "./IdentityPage.jsx";
import {
  AUTHENTICATION_REQUIRED_EVENT,
  authenticationFailureDetails,
  notifyAuthenticationRequired,
  resetAuthenticationNotification,
  shouldOpenWorkspaceFromIdentity
} from "./authRecovery.js";
import {
  evidenceQuoteIsValid,
  extractBinaryPrediction,
  findEvidenceQuote,
  outcomeIsDue,
  tomorrowDateValue
} from "./outcomeEvidence.js";
import {
  canManageDocument,
  missingOutcomeContractIds,
  outcomeLifecycleState,
  realityRankHistory,
  realityRankSummary,
  realityRankTieBreak,
  shortRevision
} from "./lifecycleUi.js";
import { loadAuthenticatedResourceBatch } from "./workspaceBootstrap.js";

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
  const response = await fetch(path, { credentials: "same-origin", ...options });
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
    error.code = payload.error;
    error.details = payload.details;
    error.requestId = payload.request_id;
    error.authReason = response.headers.get("x-clerk-auth-reason") || "";
    if (response.status === 401) notifyAuthenticationRequired(error);
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
    .filter((agent) => agent.runtime_only !== true)
    .filter((agent) => agent.runtime_sync_pending !== true)
    .filter((agent) => !agent.document && !agent.resource_for_agent_id);
}

export function agentsForWorkspace(agents = [], workspace = null) {
  if (!workspace || !Array.isArray(workspace.agent_ids)) return [];
  const memberIds = new Set(workspace.agent_ids.map((agentId) => String(agentId || "")).filter(Boolean));
  return agents.filter((agent) => memberIds.has(String(agent?.id || "")));
}

function workflowRequirementConnectionCandidates(requirement, connections = []) {
  const aliases = {
    email: "gmail",
    mail: "gmail",
    mailbox: "gmail",
    inbox: "gmail",
    drive: "google_drive",
    calendar: "google_calendar",
    gchat: "google_chat",
    contacts: "google_contacts",
    people: "google_contacts"
  };
  const providerKey = (value) => {
    const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
    return aliases[normalized] || normalized;
  };
  const expected = providerKey(requirement?.provider_id);
  const expectedTokens = expected.split(/[_-]+/).filter((token) => token.length >= 3);
  return connections
    .filter((connection) => {
      if ([connection.provider_id, connection.template_id].some((value) => providerKey(value) === expected)) return true;
      if (requirement?.connection_mode !== "custom" || connection.connection_mode !== "custom" || !expectedTokens.length) return false;
      const nameTokens = providerKey(connection.name).split(/[_-]+/).filter(Boolean);
      return expectedTokens.every((token) => nameTokens.includes(token));
    })
    .sort((left, right) => String(left.name || left.connection_id).localeCompare(String(right.name || right.connection_id)));
}

export function workflowRequirementConnections(requirement, connections = []) {
  return workflowRequirementConnectionCandidates(requirement, connections)
    .filter((connection) => connection.status === "ready");
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

function formatCreditDisplay(value) {
  if (value === undefined || value === null || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(numeric)} credits`;
}

function formatTokenCount(value) {
  const numeric = Number(value || 0);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Number.isFinite(numeric) ? numeric : 0);
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
  const { getToken, isLoaded: clerkLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const [route, setRoute] = useState(() => applicationRoute(window.location.pathname));
  const [authenticationFailure, setAuthenticationFailure] = useState(null);
  const [authenticationBusy, setAuthenticationBusy] = useState("");
  const [authenticationError, setAuthenticationError] = useState("");

  useEffect(() => {
    const handlePopState = () => setRoute(applicationRoute(window.location.pathname));
    const handleAuthenticationRequired = (event) => {
      setAuthenticationFailure(event?.detail || authenticationFailureDetails());
      setAuthenticationError("");
      if (window.location.pathname !== "/login") window.history.replaceState({}, "", "/login");
      setRoute(applicationRoute("/login"));
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener(AUTHENTICATION_REQUIRED_EVENT, handleAuthenticationRequired);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener(AUTHENTICATION_REQUIRED_EVENT, handleAuthenticationRequired);
    };
  }, []);

  useEffect(() => {
    if (!clerkLoaded || isSignedIn) return;
    setAuthenticationFailure(null);
    setAuthenticationError("");
    resetAuthenticationNotification();
  }, [clerkLoaded, isSignedIn]);

  useEffect(() => {
    if (!clerkLoaded) return;
    if (route.legacyIdentity) {
      window.history.replaceState({}, "", "/login");
      setRoute(applicationRoute("/login"));
      return;
    }
    const needsSignIn = route.surface === "workspace" && !isSignedIn;
    const needsRecovery = route.surface === "workspace" && isSignedIn && authenticationFailure;
    const needsWorkspace = route.surface === "identity" && shouldOpenWorkspaceFromIdentity({
      isSignedIn,
      authenticationFailure
    });
    if (!needsSignIn && !needsRecovery && !needsWorkspace) return;
    const path = needsSignIn || needsRecovery ? "/login" : "/app";
    window.history.replaceState({}, "", path);
    setRoute(applicationRoute(path));
  }, [authenticationFailure, clerkLoaded, isSignedIn, route.legacyIdentity, route.surface]);

  function navigate(next) {
    const path = applicationPath(next);
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    setRoute(applicationRoute(path));
    window.scrollTo?.({ top: 0, behavior: "auto" });
  }

  async function retryAuthentication() {
    setAuthenticationBusy("retry");
    setAuthenticationError("");
    try {
      const token = await getToken({ skipCache: true });
      if (!token) throw new Error("Clerk did not return a refreshed session. Sign out and sign in again.");
      resetAuthenticationNotification();
      setAuthenticationFailure(null);
      const path = applicationPath("workspace");
      window.history.replaceState({}, "", path);
      setRoute(applicationRoute(path));
    } catch (error) {
      setAuthenticationError(friendlyError(error));
    } finally {
      setAuthenticationBusy("");
    }
  }

  async function signOutAfterAuthenticationFailure() {
    setAuthenticationBusy("signout");
    setAuthenticationError("");
    try {
      await signOut({ redirectUrl: "/login" });
      resetAuthenticationNotification();
      setAuthenticationFailure(null);
      setRoute(applicationRoute("/login"));
    } catch (error) {
      setAuthenticationError(friendlyError(error));
    } finally {
      setAuthenticationBusy("");
    }
  }

  const recoveryPage = authenticationFailure ? (
    <SessionRecoveryPage
      failure={authenticationFailure}
      busy={authenticationBusy}
      error={authenticationError}
      onRetry={retryAuthentication}
      onSignOut={signOutAfterAuthenticationFailure}
      onHome={() => navigate("home")}
    />
  ) : null;

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
    if (isSignedIn && recoveryPage) return recoveryPage;
    if (isSignedIn) return <div className="center-state app-auth-loading" role="status"><LoaderCircle className="spin" size={20} /><span>Opening your workspace</span></div>;
    return (
      <IdentityPage
        mode={route.mode}
        onHome={() => navigate("home")}
      />
    );
  }
  if (!isSignedIn) return <div className="center-state app-auth-loading" role="status"><LoaderCircle className="spin" size={20} /><span>Preparing sign in</span></div>;
  if (recoveryPage) return recoveryPage;
  return (
    <Workspace
      onHome={() => navigate("home")}
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

function Workspace({ onHome, onSignedOut }) {
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [checkpoints, setCheckpoints] = useState([]);
  const [agents, setAgents] = useState([]);
  const [agentWorkspaces, setAgentWorkspaces] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [chatDocuments, setChatDocuments] = useState([]);
  const [runtime, setRuntime] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [marketplace, setMarketplace] = useState([]);
  const [mcpConnections, setMcpConnections] = useState([]);
  const [mcpTemplates, setMcpTemplates] = useState([]);
  const [mcpApprovals, setMcpApprovals] = useState([]);
  const [auth, setAuth] = useState(null);
  const [billing, setBilling] = useState(null);
  const [runsById, setRunsById] = useState({});
  const [contractsById, setContractsById] = useState({});
  const [activeRun, setActiveRun] = useState(null);
  const [progressiveRunId, setProgressiveRunId] = useState(null);
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
  const [workspaceEditor, setWorkspaceEditor] = useState(undefined);
  const [workspaceMembersTarget, setWorkspaceMembersTarget] = useState(null);
  const [workspaceDeleteTarget, setWorkspaceDeleteTarget] = useState(null);
  const [workflowWorkspacePrompt, setWorkflowWorkspacePrompt] = useState(null);
  const [teamNotice, setTeamNotice] = useState("");
  const threadRef = useRef(null);
  const nearBottomRef = useRef(true);
  const eventSourceRef = useRef(null);
  const sendInFlightRef = useRef(false);
  const sendRetryRef = useRef(null);
  const progressivelyRenderedRunIdsRef = useRef(new Set());
  const workflowWorkspaceConfirmedRef = useRef(false);
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
  const activeAgentWorkspace = agentWorkspaces.find((workspace) => (
    workspace.agent_workspace_id === session?.agent_workspace_id
  )) || agentWorkspaces.find((workspace) => workspace.is_general) || agentWorkspaces[0] || null;
  const activeAgentWorkspaceAgents = agentsForWorkspace(agents, activeAgentWorkspace);

  useEffect(() => {
    bootstrap();
    return () => eventSourceRef.current?.close();
  }, []);

  useEffect(() => {
    if (!teamNotice) return undefined;
    const timer = window.setTimeout(() => setTeamNotice(""), 5200);
    return () => window.clearTimeout(timer);
  }, [teamNotice]);

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

  const activatingWorkflowSignature = workflows
    .filter((workflow) => workflow.status === "activating")
    .map((workflow) => workflow.workflow_id)
    .sort()
    .join(":");

  useEffect(() => {
    if (!activatingWorkflowSignature || !session?.session_id) return undefined;
    let refreshInFlight = false;
    const timer = window.setInterval(() => {
      if (refreshInFlight) return;
      refreshInFlight = true;
      openSession(session.session_id, { hydrateRuns: false })
        .catch(() => undefined)
        .finally(() => {
          refreshInFlight = false;
        });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [activatingWorkflowSignature, session?.session_id]);

  async function bootstrap() {
    setLoading(true);
    setError("");
    try {
      const { identity: me, resources: results } = await loadAuthenticatedResourceBatch(api, [
        "/api/chat/sessions",
        "/api/runtime/health",
        "/api/agents",
        "/api/documents",
        "/api/marketplace",
        "/api/mcp/connections",
        "/api/mcp/templates",
        "/api/mcp/approvals",
        "/api/billing/account",
        "/api/agent-workspaces"
      ]);
      resetAuthenticationNotification();
      const required = (index) => {
        if (results[index].status === "rejected") throw results[index].reason;
        return results[index].value;
      };
      const optional = (index, fallback) => results[index].status === "fulfilled"
        ? results[index].value
        : fallback;
      const sessionList = required(0);
      const health = optional(1, { ok: false, ready: false });
      const agentList = optional(2, { agents: [] });
      const docList = optional(3, { documents: [] });
      const marketplaceList = optional(4, { items: [] });
      const connectionList = optional(5, { connections: [] });
      const templateList = optional(6, { templates: [] });
      const approvalList = optional(7, { approvals: [] });
      const billingData = required(8);
      const agentWorkspaceList = required(9);
      let optionalLoadFailed = results.slice(1, 8).some((result) => result.status === "rejected");
      let metricData = emptyMetrics();
      if (me.is_admin) {
        try {
          metricData = await api.get("/api/admin/metrics");
        } catch {
          optionalLoadFailed = true;
        }
      }
      setAuth(me);
      setRuntime(health);
      setAgents(agentList.agents || []);
      setDocuments(docList.documents || []);
      setMarketplace(marketplaceList.items || []);
      setMcpConnections(connectionList.connections || []);
      setMcpTemplates(templateList.templates || []);
      setMcpApprovals(approvalList.approvals || []);
      setBilling(billingData);
      setAgentWorkspaces(agentWorkspaceList.workspaces || []);
      setMetrics(metricData);
      const oauthSessionId = oauthReturnRef.current.sessionId;
      let nextSession = oauthSessionId
        ? sessionList.sessions?.find((item) => item.session_id === oauthSessionId) || { session_id: oauthSessionId }
        : sessionList.sessions?.[0] || null;
      if (!nextSession && !me.is_viewer) {
        const generalWorkspace = (agentWorkspaceList.workspaces || []).find((workspace) => workspace.is_general)
          || agentWorkspaceList.workspaces?.[0];
        nextSession = await api.post("/api/chat/sessions", {
          title: "New chat",
          visibility: "private",
          ...(generalWorkspace ? { agent_workspace_id: generalWorkspace.agent_workspace_id } : {})
        });
      } else if (nextSession && !nextSession.agent_workspace_id && !me.is_viewer) {
        const generalWorkspace = (agentWorkspaceList.workspaces || []).find((workspace) => workspace.is_general)
          || agentWorkspaceList.workspaces?.[0];
        if (generalWorkspace) {
          const switched = await api.patch(
            `/api/chat/sessions/${encodeURIComponent(nextSession.session_id)}/agent-workspace`,
            { agent_workspace_id: generalWorkspace.agent_workspace_id }
          );
          nextSession = { ...nextSession, agent_workspace_id: switched.agent_workspace_id };
        }
      }
      setSessions(sessionList.sessions?.length ? sessionList.sessions : nextSession ? [nextSession] : []);
      if (nextSession) await openSession(nextSession.session_id);
      if (optionalLoadFailed) {
        setError("Chat is available, but some Studio resources could not be loaded. Refresh to try those resources again.");
      }
    } catch (bootstrapError) {
      if (bootstrapError?.status === 401) {
        notifyAuthenticationRequired(bootstrapError);
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
    const { identity: me, resources: results } = await loadAuthenticatedResourceBatch(api, [
      "/api/chat/sessions",
      agentPath,
      "/api/documents",
      "/api/runtime/health",
      "/api/marketplace",
      "/api/mcp/connections",
      "/api/mcp/templates",
      "/api/mcp/approvals",
      "/api/billing/account",
      "/api/agent-workspaces"
    ]);
    resetAuthenticationNotification();
    const required = (index) => {
      if (results[index].status === "rejected") throw results[index].reason;
      return results[index].value;
    };
    const fulfilled = (index) => results[index].status === "fulfilled" ? results[index].value : null;
    const sessionList = required(0);
    const agentList = fulfilled(1);
    const docList = fulfilled(2);
    const health = fulfilled(3);
    const marketplaceList = fulfilled(4);
    const connectionList = fulfilled(5);
    const templateList = fulfilled(6);
    const approvalList = fulfilled(7);
    const billingData = required(8);
    const agentWorkspaceList = required(9);
    let optionalLoadFailed = results.slice(1, 8).some((result) => result.status === "rejected");
    let metricData = me.is_admin ? null : emptyMetrics();
    if (me.is_admin) {
      try {
        metricData = await api.get("/api/admin/metrics");
      } catch {
        optionalLoadFailed = true;
      }
    }
    setAuth(me);
    setSessions(sessionList.sessions || []);
    if (agentList) setAgents(agentList.agents || []);
    if (docList) setDocuments(docList.documents || []);
    if (health) setRuntime(health);
    if (marketplaceList) setMarketplace(marketplaceList.items || []);
    if (connectionList) setMcpConnections(connectionList.connections || []);
    if (templateList) setMcpTemplates(templateList.templates || []);
    if (approvalList) setMcpApprovals(approvalList.approvals || []);
    setBilling(billingData);
    setAgentWorkspaces(agentWorkspaceList.workspaces || []);
    if (metricData) setMetrics(metricData);
    if (optionalLoadFailed) {
      setError("Some Studio resources could not be refreshed. Your current chat data was preserved.");
    }
  }

  async function refreshStudioResources(scopes = []) {
    const requested = [...new Set(scopes)];
    if (!requested.length) return;
    const agentPath = session?.session_id
      ? `/api/agents?session_id=${encodeURIComponent(session.session_id)}`
      : "/api/agents";
    const loaders = {
      agents: [agentPath, (payload) => setAgents(payload.agents || [])],
      documents: ["/api/documents", (payload) => setDocuments(payload.documents || [])],
      health: ["/api/runtime/health", setRuntime],
      marketplace: ["/api/marketplace", (payload) => setMarketplace(payload.items || [])],
      connections: ["/api/mcp/connections", (payload) => setMcpConnections(payload.connections || [])],
      templates: ["/api/mcp/templates", (payload) => setMcpTemplates(payload.templates || [])],
      approvals: ["/api/mcp/approvals", (payload) => setMcpApprovals(payload.approvals || [])],
      agentWorkspaces: ["/api/agent-workspaces", (payload) => setAgentWorkspaces(payload.workspaces || [])],
      billing: ["/api/billing/account", setBilling],
      metrics: ["/api/admin/metrics", setMetrics]
    };
    const selected = requested
      .filter((scope) => loaders[scope])
      .filter((scope) => scope !== "metrics" || auth?.is_admin)
      .map((scope) => ({ scope, path: loaders[scope][0], apply: loaders[scope][1] }));
    const results = await Promise.allSettled(selected.map((item) => api.get(item.path)));
    results.forEach((result, index) => {
      if (result.status === "fulfilled") selected[index].apply(result.value);
    });
    if (results.some((result) => result.status === "rejected")) {
      setError("Some Studio resources could not be refreshed. Existing data was preserved.");
    }
  }

  async function fetchRun(runId, { makeActive = false, hydrateContracts = false } = {}) {
    if (!runId) return null;
    const run = await api.get(`/api/chat/runs/${encodeURIComponent(runId)}`);
    setRunsById((current) => ({ ...current, [runId]: run }));
    applyRunBilling(run.billing);
    if (makeActive) setActiveRun(run);
    if (hydrateContracts) {
      await Promise.allSettled(
        missingOutcomeContractIds(run, contractsById).map((contractId) => fetchContract(contractId))
      );
    }
    return run;
  }

  function applyRunBilling(runBilling) {
    const incomingRevision = Number(runBilling?.account_revision);
    if (!Number.isSafeInteger(incomingRevision)) return;
    setBilling((current) => {
      const currentRevision = Number(current?.account?.revision || 0);
      if (current?.account && incomingRevision < currentRevision) return current;
      return {
        ...current,
        account: {
          ...(current?.account || {}),
          revision: incomingRevision,
          balance_micros: runBilling.balance_after_micros,
          balance_credits: runBilling.balance_after_credits,
          reserved_micros: runBilling.reserved_after_micros,
          reserved_credits: runBilling.reserved_after_credits,
          updated_at: new Date().toISOString()
        }
      };
    });
  }

  async function refreshBilling() {
    try {
      const payload = await api.get("/api/billing/account");
      setBilling(payload);
      return payload;
    } catch (billingError) {
      setError(friendlyError(billingError));
      return null;
    }
  }

  async function fetchContract(contractId) {
    const contract = await api.get(`/api/outcome-contracts/${encodeURIComponent(contractId)}`);
    setContractsById((current) => ({ ...current, [contractId]: contract }));
    return contract;
  }

  async function openSession(sessionId, { hydrateRuns = true } = {}) {
    setError("");
    const [payload, agentList] = await Promise.all([
      api.get(`/api/chat/sessions/${encodeURIComponent(sessionId)}`),
      api.get(`/api/agents?session_id=${encodeURIComponent(sessionId)}`)
    ]);
    setSession(payload);
    if (payload.agent_workspace) {
      setAgentWorkspaces((items) => {
        const exists = items.some((workspace) => workspace.agent_workspace_id === payload.agent_workspace.agent_workspace_id);
        return exists
          ? items.map((workspace) => workspace.agent_workspace_id === payload.agent_workspace.agent_workspace_id ? payload.agent_workspace : workspace)
          : [...items, payload.agent_workspace];
      });
    }
    setMessages(payload.messages || []);
    for (const message of payload.messages || []) applyRunBilling(message.billing);
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
    if (latestRunId && hydrateRuns) {
      await fetchRun(latestRunId, { makeActive: true });
    } else if (!latestRunId) {
      setActiveRun(null);
    }
    if (hydrateRuns) {
      assistantRunIds.slice(-12).filter((runId) => runId !== latestRunId).forEach((runId) => {
        fetchRun(runId).catch(() => undefined);
      });
    }
  }

  async function newChat() {
    if (!canWrite) return;
    setError("");
    try {
      eventSourceRef.current?.close();
      const created = await api.post("/api/chat/sessions", {
        title: "New chat",
        visibility: "private",
        ...(activeAgentWorkspace ? { agent_workspace_id: activeAgentWorkspace.agent_workspace_id } : {})
      });
      setSessions((current) => [created, ...current.filter((item) => item.session_id !== created.session_id)]);
      await openSession(created.session_id);
      setDraft("");
      setHistoryOpen(false);
      setFocusComposer((value) => value + 1);
    } catch (chatError) {
      setError(friendlyError(chatError));
    }
  }

  async function switchAgentWorkspace(agentWorkspaceId, { refresh = true } = {}) {
    if (!session?.session_id || !agentWorkspaceId || !canWrite) return null;
    const result = await api.patch(
      `/api/chat/sessions/${encodeURIComponent(session.session_id)}/agent-workspace`,
      { agent_workspace_id: agentWorkspaceId }
    );
    setSession((current) => current ? {
      ...current,
      agent_workspace_id: result.agent_workspace_id,
      agent_workspace: result.agent_workspace
    } : current);
    setSessions((items) => items.map((item) => item.session_id === session.session_id
      ? { ...item, agent_workspace_id: result.agent_workspace_id }
      : item));
    if (refresh) await openSession(session.session_id, { hydrateRuns: false });
    return result;
  }

  async function sendMessage(event, contentOverride = null) {
    event?.preventDefault();
    const content = String(contentOverride ?? draft).trim();
    if (!content || !session || !canWrite || sendInFlightRef.current) return;
    const workflowCommand = /^\/(workflow|agent)\s+\S/i.test(content);
    if (workflowCommand && !workflowWorkspaceConfirmedRef.current) {
      setWorkflowWorkspacePrompt({ content });
      return;
    }
    workflowWorkspaceConfirmedRef.current = false;
    const previousSubmission = sendRetryRef.current;
    const submission = previousSubmission?.content === content
      && previousSubmission?.sessionId === session.session_id
      ? previousSubmission
      : {
          content,
          sessionId: session.session_id,
          idempotencyKey: mutationIdempotencyKey("message")
        };
    sendInFlightRef.current = true;
    sendRetryRef.current = submission;
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
      }, { idempotencyKey: submission.idempotencyKey });
      sendRetryRef.current = null;
      setMessages((items) => items.map((message) => message.message_id === optimisticId
        ? { ...message, message_id: queued.message_id, run_id: queued.run_id }
        : message));
      const stub = {
        run_id: queued.run_id,
        session_id: session.session_id,
        agent_workspace_id: session.agent_workspace_id || null,
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
    } finally {
      sendInFlightRef.current = false;
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
      if (["final.completed", "run.failed"].includes(event.type)) {
        if (event.type === "final.completed" && !progressivelyRenderedRunIdsRef.current.has(runId)) {
          progressivelyRenderedRunIdsRef.current.add(runId);
          setProgressiveRunId(runId);
        }
        await fetchRun(runId, { makeActive: true }).catch(() => undefined);
      }
      if (event.type === "final.completed" || event.type === "run.failed") {
        source.close();
        if (eventSourceRef.current === source) eventSourceRef.current = null;
        await openSession(sessionId, { hydrateRuns: false }).catch((sessionError) => setError(friendlyError(sessionError)));
      }
    };
    source.onerror = () => {
      // Native EventSource retries transient disconnects. Keep it alive and
      // refresh once so the visible state progresses while reconnection occurs.
      fetchRun(runId, { makeActive: true }).catch(() => undefined);
    };
  }

  async function openRunDetails(runId) {
    setDetailsRunId(runId);
    if (!runsById[runId]?.expert_outputs) {
      await fetchRun(runId, { hydrateContracts: true }).catch((detailsError) => setError(friendlyError(detailsError)));
    } else {
      fetchRun(runId, { hydrateContracts: true }).catch(() => undefined);
    }
  }

  async function retryAnswer(run) {
    if (!canWrite) return;
    setDraft(run?.query || "");
    setFocusComposer((value) => value + 1);
  }

  async function rerunTrackedAnswer(run, { runFresh = false } = {}) {
    const content = String(run?.query || "").trim();
    if (!content || !session || !canWrite || sendInFlightRef.current) return false;
    sendInFlightRef.current = true;
    setError("");
    nearBottomRef.current = true;
    const optimisticId = `local_${runFresh ? "fresh" : "selective"}_${Date.now()}`;
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
        options: {
          ...(run?.execution_options || {}),
          show_route_details: true,
          run_fresh: runFresh
        }
      }, { idempotencyKey: mutationIdempotencyKey(runFresh ? "fresh-message" : "selective-message") });
      setDetailsRunId(null);
      setMessages((items) => items.map((message) => message.message_id === optimisticId
        ? { ...message, message_id: queued.message_id, run_id: queued.run_id }
        : message));
      const stub = {
        run_id: queued.run_id,
        session_id: session.session_id,
        agent_workspace_id: session.agent_workspace_id || null,
        query: content,
        status: queued.status || "queued",
        expert_outputs: [],
        sources: [],
        outcome_contracts: [],
        world_graph: { kept: 0, refreshed: 0, total: 0, decisions: [] },
        events: []
      };
      setActiveRun(stub);
      setRunsById((current) => ({ ...current, [queued.run_id]: stub }));
      subscribeRun(queued.run_id, session.session_id);
      return true;
    } catch (rerunError) {
      setMessages((items) => items.filter((message) => message.message_id !== optimisticId));
      setError(friendlyError(rerunError));
      return false;
    } finally {
      sendInFlightRef.current = false;
    }
  }

  function refreshTrackedAnswer(run) {
    return rerunTrackedAnswer(run, { runFresh: false });
  }

  function runEveryAgentFresh(run) {
    return rerunTrackedAnswer(run, { runFresh: true });
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
    } catch (workflowError) {
      setError(friendlyError(workflowError));
      await openSession(session.session_id).catch(() => undefined);
    } finally {
      setWorkflowBusy("");
    }
  }

  async function connectWorkflowRequirement(workflow, requirement, connectionId = null) {
    if (!workflow || !requirement || workflowBusy) return;
    if (requirement.status === "connected") {
      await resumeWorkflow(workflow);
      return;
    }
    const selectedConnection = connectionId
      ? mcpConnections.find((connection) => connection.connection_id === connectionId)
      : null;
    const reconnectManaged = selectedConnection
      && selectedConnection.status !== "ready"
      && selectedConnection.connection_mode === "managed";
    if (connectionId && !reconnectManaged) {
      setWorkflowBusy(workflow.workflow_id);
      setError("");
      try {
        const updated = await api.post(
          `/api/workflows/${encodeURIComponent(workflow.workflow_id)}/connections/${encodeURIComponent(requirement.provider_id)}`,
          { connection_id: connectionId, revision: workflow.revision }
        );
        await waitForWorkflowActivation(updated);
        await openSession(workflow.session_id || session.session_id);
      } catch (connectionError) {
        setError(friendlyError(connectionError));
        await openSession(session.session_id).catch(() => undefined);
      } finally {
        setWorkflowBusy("");
      }
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
          workflow_id: workflow.workflow_id,
          ...(reconnectManaged ? { connection_id: selectedConnection.connection_id } : {})
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

  async function runWorkflow(workflow) {
    try {
      if (workflow.agent_workspace_id && workflow.agent_workspace_id !== session?.agent_workspace_id) {
        await switchAgentWorkspace(workflow.agent_workspace_id, { refresh: false });
      }
    } catch (workspaceError) {
      setError(friendlyError(workspaceError));
      return;
    }
    const agentIds = (workflow.activation?.node_agents || []).map((item) => item.agent_id).filter(Boolean);
    const mentions = agentIds.map((agentId) => `@${agentId}`).join(" ");
    await sendMessage(null, `${mentions}${mentions ? " " : ""}${workflow.intent}`.trim());
  }

  async function decideToolCheckpoint(checkpoint, approval, decision) {
    if (!checkpoint || !approval || checkpointBusy) return;
    setCheckpointBusy(checkpoint.checkpoint_id);
    setError("");
    try {
      if (decision === "acknowledge_uncertain") {
        await api.post(`/api/mcp/approvals/${encodeURIComponent(approval.approval_id)}/acknowledge-uncertain`, {});
      } else {
        await api.post(`/api/mcp/approvals/${encodeURIComponent(approval.approval_id)}`, { decision });
      }
      await openSession(checkpoint.session_id || session.session_id);
      await refreshStudioResources(["approvals", "connections"]);
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
    await refreshStudioResources(["agents", "agentWorkspaces", "marketplace"]);
    setResourcesOpen(true);
    setResourceView("agents");
  }

  async function deleteArchivedAgent(agent) {
    setError("");
    await api.delete(`/api/agents/${encodeURIComponent(agent.id)}/permanent`);
    setDeleteAgentTarget(null);
    await refreshStudioResources(["agents", "agentWorkspaces", "marketplace"]);
    setResourcesOpen(true);
    setResourceView("agents");
  }

  async function unpublishAgent(target) {
    const item = target?.item || target;
    const returnView = target?.returnView || "agents";
    setError("");
    await api.delete(`/api/marketplace/items/${encodeURIComponent(item.id)}`);
    setUnpublishTarget(null);
    await refreshStudioResources(["agents", "agentWorkspaces", "marketplace"]);
    setResourcesOpen(true);
    setResourceView(returnView);
  }

  async function deleteDocument(document) {
    setError("");
    await api.delete(`/api/documents/${encodeURIComponent(document.document_id)}`);
    setDeleteDocumentTarget(null);
    await refreshStudioResources(["agents", "documents"]);
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
      const updated = await api.patch(`/api/agents/${encodeURIComponent(toId)}`, {
        consumes: graphConnectionInputs(target.consumes, fromId, connected)
      });
      setAgents((items) => items.map((item) => item.id === toId ? { ...item, ...updated } : item));
    } catch (connectionError) {
      setError(friendlyError(connectionError));
      throw connectionError;
    }
  }

  async function deleteAgentWorkspaceSelection(workspace) {
    setError("");
    const result = await api.delete(`/api/agent-workspaces/${encodeURIComponent(workspace.agent_workspace_id)}`);
    setWorkspaceDeleteTarget(null);
    await refreshStudioResources(["agentWorkspaces", "agents", "marketplace"]);
    if (session?.agent_workspace_id === workspace.agent_workspace_id && result.fallback_agent_workspace_id) {
      await openSession(session.session_id, { hydrateRuns: false });
    }
    setResourcesOpen(true);
    setResourceView("agents");
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
    await fetchRun(runId, {
      makeActive: activeRun?.run_id === runId,
      hydrateContracts: true
    });
    await refreshStudioResources(["metrics"]);
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
          <button
            className="balance-pill"
            type="button"
            onClick={() => {
              setResourceView("account");
              setResourcesOpen(true);
              void refreshBilling();
            }}
            title={billing?.account?.reserved_micros > 0
              ? `${billing.account.reserved_credits} credits are reserved for active requests`
              : "Open balance details"}
          >
            <span className="balance-pill-icon" aria-hidden="true"><WalletCards size={14} /></span>
            <span className="balance-pill-copy">
              <span>Balance</span>
              <strong>{formatCreditDisplay(billing?.account?.balance_credits)}</strong>
            </span>
          </button>
          <IconButton label="New chat" onClick={newChat} disabled={!canWrite}>
            <SquarePen size={19} />
          </IconButton>
          <button
            className="studio-button"
            type="button"
            aria-label="Open your team studio"
            onClick={() => setResourcesOpen(true)}
          >
            <Layers3 size={16} />
            <span>My team</span>
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
              <EmptyTeamWelcome
                readOnly={auth?.is_viewer}
                workspace={activeAgentWorkspace}
                agents={activeAgentWorkspaceAgents}
                onStart={() => setFocusComposer((value) => value + 1)}
                onBuildWorkflow={() => {
                  setDraft("/workflow ");
                  setFocusComposer((value) => value + 1);
                }}
                onOpenTeam={() => {
                  setResourceView("agents");
                  setResourcesOpen(true);
                }}
              />
            )}

            {!loading && messages.map((message, index) => (
              <ChatMessage
                key={message.message_id}
                message={message}
                run={message.run_id ? runsById[message.run_id] : null}
                agents={agents}
                connections={mcpConnections}
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
                progressivelyRender={message.run_id === progressiveRunId}
                onProgressiveRenderComplete={() => setProgressiveRunId((current) => current === message.run_id ? null : current)}
                onProgressiveRenderProgress={() => {
                  if (nearBottomRef.current && threadRef.current) {
                    threadRef.current.scrollTop = threadRef.current.scrollHeight;
                  }
                }}
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
                <span>
                  {activeRun.error?.message || "This answer could not be completed."}
                  <small>Run {activeRun.run_id}</small>
                </span>
                <button type="button" onClick={() => openRunDetails(activeRun.run_id)}>Details</button>
                {canWrite && activeRun.error?.action !== "contact_support" && (
                  <button type="button" onClick={() => retryAnswer(activeRun)}>
                    {activeRun.error?.action === "reduce_context" ? "Edit request" : "Try again"}
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        <div className="composer-zone">
          {!auth?.is_viewer && activeAgentWorkspace && (
            <button
              type="button"
              className="active-team-control"
              aria-label={`Manage ${activeAgentWorkspace.name || "active team"}`}
              onClick={() => {
                setResourceView("agents");
                setResourcesOpen(true);
              }}
            >
              <span className="active-team-icon"><Layers3 size={14} /></span>
              <span>
                <strong>{activeAgentWorkspace.name || "General team"}</strong>
                <small>{activeAgentWorkspaceAgents.filter((agent) => agent.enabled !== false && agent.session_active !== false).length} available for this chat</small>
              </span>
              <ChevronDown size={14} />
            </button>
          )}
          {teamNotice && (
            <div className="team-notice" role="status">
              <span><Check size={15} /></span>
              <strong>{teamNotice}</strong>
              <button type="button" aria-label="Dismiss team update" onClick={() => setTeamNotice("")}><X size={14} /></button>
            </div>
          )}
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
            agents={activeAgentWorkspaceAgents}
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
          billing={billing}
          agents={agents}
          agentWorkspaces={agentWorkspaces}
          activeAgentWorkspace={activeAgentWorkspace}
          documents={documents}
          runtime={runtime}
          metrics={metrics}
          marketplace={marketplace}
          mcpConnections={mcpConnections}
          mcpTemplates={mcpTemplates}
          mcpApprovals={mcpApprovals}
          resumeWorkflowId={connectionResumeWorkflowId}
          sessionId={session?.session_id}
          latestRun={activeRun}
          initialView={resourceView}
          togglingAgentId={togglingAgentId}
          onViewChange={setResourceView}
          onClose={() => setResourcesOpen(false)}
          onCreateAgent={() => openAgentEditor(null)}
          onSelectAgentWorkspace={(workspaceId) => switchAgentWorkspace(workspaceId).catch((workspaceError) => setError(friendlyError(workspaceError)))}
          onCreateAgentWorkspace={() => {
            setResourcesOpen(false);
            setWorkspaceEditor({ workspace: null });
          }}
          onEditAgentWorkspace={(workspace) => {
            setResourcesOpen(false);
            setWorkspaceEditor({ workspace });
          }}
          onManageAgentWorkspace={(workspace) => {
            setResourcesOpen(false);
            setWorkspaceMembersTarget(workspace);
          }}
          onDeleteAgentWorkspace={(workspace) => {
            setResourcesOpen(false);
            setWorkspaceDeleteTarget(workspace);
          }}
          onPublishAgentWorkspace={(workspace) => {
            setResourcesOpen(false);
            setPublishTarget({ ...workspace, title: workspace.name, item_type: "workspace", id: workspace.agent_workspace_id });
          }}
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
          onRefreshBilling={refreshBilling}
          onRefreshConnections={() => refreshStudioResources(["connections", "templates", "approvals", "agents"])}
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
          onRefreshTracked={refreshTrackedAnswer}
          onRunFresh={runEveryAgentFresh}
        />
      )}

      {uploadOpen && (
        <DocumentUploadDialog
          scope={uploadScope}
          sessionId={uploadScope === "chat" ? session?.session_id : null}
          onClose={() => setUploadOpen(false)}
          onUploaded={async (uploaded) => {
            setUploadOpen(false);
            await refreshStudioResources(["agents", "documents"]);
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
          runtime={runtime}
          agent={agentEditor.agent || null}
          agents={activeAgentWorkspaceAgents}
          documents={documents}
          mcpConnections={mcpConnections}
          agentWorkspaceId={activeAgentWorkspace?.agent_workspace_id || null}
          teamName={activeAgentWorkspace?.name || "General team"}
          onClose={() => setAgentEditor(undefined)}
          onSaved={async (savedAgent = {}) => {
            const teammateName = agentFacingText(savedAgent.title || agentEditor.agent?.title || "Your new teammate");
            const wasEditing = savedAgent.editing ?? Boolean(agentEditor.agent);
            setAgentEditor(undefined);
            await refreshStudioResources(["agents", "documents", "agentWorkspaces"]);
            setTeamNotice(wasEditing
              ? `${teammateName} is updated and ready for future work.`
              : `${teammateName} joined ${activeAgentWorkspace?.name || "your team"}.`);
            setResourcesOpen(true);
            setResourceView("agents");
          }}
        />
      )}

      {workspaceEditor !== undefined && (
        <AgentWorkspaceDialog
          workspace={workspaceEditor.workspace}
          onClose={() => {
            setWorkspaceEditor(undefined);
            setResourcesOpen(true);
            setResourceView("agents");
          }}
          onSaved={async (saved) => {
            setWorkspaceEditor(undefined);
            await refreshStudioResources(["agentWorkspaces", "agents"]);
            await switchAgentWorkspace(saved.agent_workspace_id, { refresh: true });
            setResourcesOpen(true);
            setResourceView("agents");
          }}
        />
      )}

      {workspaceMembersTarget && (
        <AgentWorkspaceMembersDialog
          workspace={workspaceMembersTarget}
          agents={agents}
          onClose={() => {
            setWorkspaceMembersTarget(null);
            setResourcesOpen(true);
            setResourceView("agents");
          }}
          onSaved={async () => {
            setWorkspaceMembersTarget(null);
            await refreshStudioResources(["agentWorkspaces", "agents"]);
            if (session?.session_id) await openSession(session.session_id, { hydrateRuns: false });
            setResourcesOpen(true);
            setResourceView("agents");
          }}
        />
      )}

      {workflowWorkspacePrompt && (
        <WorkflowWorkspaceDialog
          workspaces={agentWorkspaces}
          activeWorkspaceId={activeAgentWorkspace?.agent_workspace_id || ""}
          onClose={() => setWorkflowWorkspacePrompt(null)}
          onConfirm={async (workspaceId) => {
            await switchAgentWorkspace(workspaceId, { refresh: false });
            workflowWorkspaceConfirmedRef.current = true;
            setWorkflowWorkspacePrompt(null);
            await sendMessage();
          }}
          onCreated={async (workspace) => {
            setAgentWorkspaces((items) => [...items, workspace]);
            await switchAgentWorkspace(workspace.agent_workspace_id, { refresh: false });
            workflowWorkspaceConfirmedRef.current = true;
            setWorkflowWorkspacePrompt(null);
            await sendMessage();
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
            await refreshStudioResources(["agents", "agentWorkspaces", "marketplace"]);
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
            if (item.item_type === "workspace") {
              const sourceWorkspace = agentWorkspaces.find((workspace) => workspace.agent_workspace_id === item.id);
              if (!sourceWorkspace) {
                setMarketplaceTarget(null);
                setError("The source workspace is no longer available.");
                setResourcesOpen(true);
                setResourceView("marketplace");
                return;
              }
              setMarketplaceTarget(null);
              setPublishTarget({
                ...sourceWorkspace,
                id: sourceWorkspace.agent_workspace_id,
                title: sourceWorkspace.name,
                item_type: "workspace",
                marketplace: {
                  ...(sourceWorkspace.marketplace || {}),
                  published: true,
                  description: item.description || sourceWorkspace.description
                }
              });
              return;
            }
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
          agentWorkspaces={agentWorkspaces}
          activeAgentWorkspaceId={activeAgentWorkspace?.agent_workspace_id || ""}
          onCopied={async (result) => {
            setMarketplaceTarget(null);
            await refreshStudioResources(["agents", "agentWorkspaces", "marketplace"]);
            if (result?.agent_workspace?.agent_workspace_id) {
              await switchAgentWorkspace(result.agent_workspace.agent_workspace_id, { refresh: true });
            }
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
            await refreshStudioResources(["marketplace"]);
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
            await refreshStudioResources(["agents"]);
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

      {workspaceDeleteTarget && (
        <ConfirmDialog
          title="Delete workspace?"
          message={`${workspaceDeleteTarget.name} will be removed. Its agents remain available and chats using it will switch to General.`}
          confirmLabel="Delete workspace"
          destructive
          icon={Trash2}
          onClose={() => {
            setWorkspaceDeleteTarget(null);
            setResourcesOpen(true);
            setResourceView("agents");
          }}
          onConfirm={() => deleteAgentWorkspaceSelection(workspaceDeleteTarget)}
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

function ModalSurface({ title, description, side, onClose, children, className = "", closeDisabled = false }) {
  const titleId = useId();
  const descriptionId = useId();
  const surfaceRef = useRef(null);
  const closeRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  closeRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    const previousFocus = document.activeElement;
    const surface = surfaceRef.current;
    const focusable = surface?.querySelector("[data-autofocus]")
      || surface?.querySelector("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])");
    (focusable || surface)?.focus();
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!closeDisabledRef.current) closeRef.current();
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
        if (event.target === event.currentTarget && !closeDisabled) closeRef.current();
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
          <IconButton label={closeDisabled ? "Please wait while saving" : "Close"} onClick={() => closeRef.current()} disabled={closeDisabled}>
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

export function ChatMessage({
  message,
  run,
  agents,
  connections,
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
  onDetails,
  progressivelyRender = false,
  onProgressiveRenderComplete = () => undefined,
  onProgressiveRenderProgress = () => undefined
}) {
  const isAssistant = message.role === "assistant";
  return (
    <article className={`message ${message.role}`}>
      <div className="message-content">
        {isAssistant
          ? <ProgressiveFormattedText
              text={message.content}
              active={progressivelyRender}
              onComplete={onProgressiveRenderComplete}
              onProgress={onProgressiveRenderProgress}
            />
          : message.content}
        {message.kind === "workflow_draft" && workflow && (
          <WorkflowDraftCard
            workflow={workflow}
            connections={connections}
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
        <div className="answer-meta">
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
        </div>
      )}
    </article>
  );
}

export function WorkflowDraftCard({
  workflow,
  connections = [],
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
        <div><small>{workflow.mode === "agent_team" ? "PROPOSED TEAM" : "PROPOSED WORKFLOW"}</small><strong>{workflow.title}</strong></div>
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
          {(workflow.connection_requirements || []).map((requirement) => {
            const matchingConnections = workflowRequirementConnectionCandidates(requirement, connections);
            const readyConnections = matchingConnections.filter((connection) => connection.status === "ready").slice(0, 4);
            const reconnectableConnections = requirement.connection_mode === "managed"
              ? matchingConnections.filter((connection) => connection.status !== "ready").slice(0, 4)
              : [];
            const connectionSetupEnabled = Boolean(workflow.approved_at)
              && ["awaiting_connections", "ready_to_activate", "activation_failed"].includes(workflow.status);
            return (
              <div key={requirement.provider_id}>
                <span><Plug size={14} /><i><b>{requirement.name}</b><small>{requirement.reason}</small></i></span>
                {requirement.status === "connected"
                  ? <em className="connected"><Check size={12} />Connected</em>
                  : !connectionSetupEnabled
                    ? <em className="pending">{workflow.status === "declined" ? "Draft closed" : "Create the team first"}</em>
                  : <span className="workflow-connection-actions">
                    {readyConnections.map((connection) => (
                      <button
                        type="button"
                        key={connection.connection_id}
                        disabled={!canWrite || busy}
                        onClick={() => onConnect(workflow, requirement, connection.connection_id)}
                      >Use {connection.name || requirement.name}</button>
                    ))}
                    {reconnectableConnections.map((connection) => (
                      <button
                        type="button"
                        key={connection.connection_id}
                        disabled={!canWrite || busy}
                        onClick={() => onConnect(workflow, requirement, connection.connection_id)}
                      >Reconnect {connection.name || requirement.name}</button>
                    ))}
                    {(requirement.connection_mode !== "managed" || (!readyConnections.length && !reconnectableConnections.length)) && (
                      <button type="button" disabled={!canWrite || busy} onClick={() => onConnect(workflow, requirement)}>
                        {requirement.connection_mode === "managed"
                          ? `Connect ${requirement.name}`
                          : readyConnections.length ? "Add another MCP" : `Add ${requirement.name} MCP`}
                      </button>
                    )}
                  </span>}
              </div>
            );
          })}
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
          <button type="button" className="text-button ghost" disabled={!canWrite || busy} onClick={() => onDecision(workflow, "deny")}>Not now</button>
          <button type="button" className="text-button primary" disabled={!canWrite || busy} onClick={() => onDecision(workflow, "approve")}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{workflow.mode === "agent_team" ? "Create this team" : "Create this workflow"}</button>
        </>}
        {workflow.status === "awaiting_connections" && <>
          <button type="button" className="text-button ghost" disabled={!canWrite || busy} onClick={() => onDecision(workflow, "deny")}>Cancel setup</button>
          <span>{missingConnections.length ? `Waiting for ${missingConnections.map((item) => item.name).join(" and ")}` : "Connections ready"}</span>
        </>}
        {workflow.status === "ready_to_activate" && <button type="button" className="text-button primary" disabled={!canWrite || busy} onClick={() => onResume(workflow)}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Complete team setup</button>}
        {workflow.status === "activation_failed" && <>
          <button type="button" className="text-button ghost" disabled={!canWrite || busy} onClick={() => onDecision(workflow, "deny")}>Cancel setup</button>
          <button type="button" className="text-button primary" disabled={!canWrite || busy} onClick={() => onResume(workflow)}><RefreshCw size={14} />Retry setup</button>
        </>}
        {workflow.status === "active" && <>
          <button type="button" className="text-button ghost" onClick={() => onGraph(workflow)}><Network size={14} />View team map</button>
          <button type="button" className="text-button primary" disabled={!canWrite || busy} onClick={() => onRun(workflow)}><ArrowRight size={14} />Start workflow</button>
        </>}
        {workflow.status === "activating" && <span><LoaderCircle className="spin" size={14} />Adding your specialists and connecting their work…</span>}
        {workflow.status === "declined" && <span>Nothing was created. Your connected accounts were unchanged.</span>}
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

export function ApprovalArguments({ argumentsValue = {} }) {
  const entries = Object.entries(argumentsValue || {});
  const label = (key) => String(key || "Detail")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
  const value = (entry) => {
    if (entry == null || entry === "") return "Not provided";
    if (typeof entry === "boolean") return entry ? "Yes" : "No";
    if (Array.isArray(entry) && entry.every((item) => ["string", "number", "boolean"].includes(typeof item))) return entry.join(", ");
    if (typeof entry === "object") return "Structured details included";
    return String(entry);
  };
  return (
    <div className="approval-arguments">
      {entries.length > 0 ? <dl>{entries.slice(0, 8).map(([key, entry]) => <div key={key}><dt>{label(key)}</dt><dd>{value(entry)}</dd></div>)}</dl> : <p>No extra details are required for this action.</p>}
      <details><summary>Technical details</summary><pre>{JSON.stringify(argumentsValue || {}, null, 2)}</pre></details>
    </div>
  );
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
  if (approval?.status === "execution_outcome_uncertain") {
    return (
      <section className="tool-checkpoint-card error" role="alert" aria-label="External action outcome needs verification">
        <AlertCircle size={18} />
        <div>
          <strong>Check {approval.connection_name || "the provider"} before trying again</strong>
          <p>The approved {approval.tool_title || approval.tool_name} action was in flight when the process stopped. It may or may not have completed, and Virenis did not replay it.</p>
          <ApprovalArguments argumentsValue={approval.arguments} />
        </div>
        <button type="button" className="text-button primary" disabled={busy} onClick={() => onDecision(checkpoint, approval, "acknowledge_uncertain")}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}I’ll check, continue chat</button>
      </section>
    );
  }
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
      <ApprovalArguments argumentsValue={approval.arguments} />
      <p className="tool-checkpoint-note">Only this exact action will run. Approving or declining will resume the answer in this conversation.</p>
      <footer><button type="button" className="text-button ghost" disabled={busy} onClick={() => onDecision(checkpoint, approval, "deny")}>Don’t run</button><button type="button" className="text-button primary" disabled={busy} onClick={() => onDecision(checkpoint, approval, "approve")}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Approve and continue</button></footer>
    </section>
  );
}

function workflowSourceLabel(node) {
  if (node.source === "workspace") return "Already on your team";
  if (node.source === "marketplace") return `Marketplace${node.publisher ? ` · ${node.publisher}` : ""}`;
  if (node.source === "generated") return "Created for you";
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

export function progressiveRevealPlan(characterCount) {
  const length = Math.max(0, Number(characterCount) || 0);
  const targetDurationMs = Math.min(7000, Math.max(1600, length * 2.2));
  const targetFrames = Math.max(1, Math.round(targetDurationMs / 28));
  return {
    targetDurationMs,
    targetFrames,
    charactersPerFrame: Math.max(1, Math.ceil(length / targetFrames))
  };
}

export function ProgressiveFormattedText({
  text,
  active = false,
  onComplete = () => undefined,
  onProgress = () => undefined
}) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const canAnimate = active && typeof window !== "undefined";
  const [visibleCharacters, setVisibleCharacters] = useState(() => canAnimate ? 0 : normalized.length);
  const completeRef = useRef(onComplete);
  const progressRef = useRef(onProgress);

  useEffect(() => { completeRef.current = onComplete; }, [onComplete]);
  useEffect(() => { progressRef.current = onProgress; }, [onProgress]);

  useEffect(() => {
    if (!canAnimate || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      setVisibleCharacters(normalized.length);
      if (active) completeRef.current();
      return undefined;
    }

    let frameId = 0;
    let visible = 0;
    let previousFrameAt = 0;
    const { charactersPerFrame } = progressiveRevealPlan(normalized.length);
    setVisibleCharacters(0);

    const reveal = (timestamp) => {
      if (timestamp - previousFrameAt < 24) {
        frameId = window.requestAnimationFrame(reveal);
        return;
      }
      previousFrameAt = timestamp;
      visible = Math.min(normalized.length, visible + charactersPerFrame);
      setVisibleCharacters(visible);
      progressRef.current(visible, normalized.length);
      if (visible < normalized.length) {
        frameId = window.requestAnimationFrame(reveal);
      } else {
        completeRef.current();
      }
    };
    frameId = window.requestAnimationFrame(reveal);
    return () => window.cancelAnimationFrame(frameId);
  }, [active, canAnimate, normalized]);

  const streaming = canAnimate && visibleCharacters < normalized.length;
  return (
    <div className={`progressive-answer ${streaming ? "streaming" : "complete"}`}>
      <div aria-hidden={streaming ? "true" : undefined}>
        <FormattedText text={normalized.slice(0, visibleCharacters)} />
      </div>
      {streaming && <span className="sr-only" role="status">{normalized}</span>}
    </div>
  );
}

function safeMarkdownUrl(url, key) {
  const value = String(url || "").trim();
  if (key === "src") return "";
  if (/^(https?:|mailto:)/i.test(value) || value.startsWith("#")) return value;
  return "";
}

export function RunReceipt({ run, onClick }) {
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
  if (run.world_graph?.total > 0) {
    const kept = Number(run.world_graph.kept || 0);
    const refreshed = Number(run.world_graph.refreshed || 0);
    if (kept > 0) parts.push(`${kept} previous ${kept === 1 ? "result" : "results"} reused`);
    if (refreshed > 0) parts.push(`${refreshed} ${refreshed === 1 ? "specialist checked" : "specialists checked"} again`);
    const reasonCodes = (run.world_graph.decisions || []).map((decision) => String(decision.reason || decision.reason_code || ""));
    if (refreshed > 0 && reasonCodes.some((reason) => reason.includes("live_or_mutable") || reason.includes("tool_result_requires_fresh"))) {
      parts.push("live information was enabled");
    } else if (refreshed > 0 && reasonCodes.some((reason) => reason === "request_changed")) {
      parts.push("your request changed");
    } else if (refreshed > 0 && reasonCodes.some((reason) => reason === "agent_team_changed")) {
      parts.push("your team changed");
    } else if (refreshed > 0 && reasonCodes.some((reason) => reason === "fresh_run_requested")) {
      parts.push("a fresh check was requested");
    }
  }
  if (agentCount && !run.world_graph?.total) parts.push(`${agentCount} ${agentCount === 1 ? "specialist" : "specialists"}`);
  if (run.elapsed_sec != null) parts.push(`${Number(run.elapsed_sec).toFixed(1)}s`);
  if (run.usage_receipt && (run.usage_receipt.provider_reported === true || Number(run.usage_receipt.total_tokens) > 0)) {
    parts.push(`${formatTokenCount(run.usage_receipt.total_tokens)} tokens`);
  }
  if (sourceCount) parts.push(`${sourceCount} ${sourceCount === 1 ? "source" : "sources"}`);
  if (settled) parts.push(`${settled} recorded result${settled === 1 ? "" : "s"}`);
  else if (pending) parts.push(`${pending} claim${pending === 1 ? "" : "s"} being tracked`);
  return (
    <button type="button" className={`run-receipt ${run.status || ""}`} onClick={onClick} title="Open Answer details, token usage, and complete specialist results">
      <span className="receipt-dot" aria-hidden="true" />
      <span>{parts.join(" · ") || "Answer details"}</span>
      <ChevronRight size={14} />
    </button>
  );
}

export function UsageReceipt({ receipt, agents = [], expertOutputs = [], includeFinalOutput = false }) {
  if (!receipt) return null;
  const components = Array.isArray(receipt.components) ? [...receipt.components] : [];
  for (const output of expertOutputs) {
    if (!output?.adapter) continue;
    const outputStepId = output.id || output.step_id || null;
    const outputAccounted = components.some((component) => (
      component.kind === "agent"
      && component.agent_id === output.adapter
      && (!outputStepId || !component.step_id || component.step_id === outputStepId)
    ));
    if (outputAccounted) continue;
    const usage = output.token_usage || {};
    components.push({
      component_key: `unreported-agent:${output.adapter}:${outputStepId || components.length}`,
      component: `agent:${output.adapter}:unreported`,
      kind: "agent",
      agent_id: output.adapter,
      step_id: outputStepId,
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
      charged_credits: usage.charged_credits || "0",
      reported: usage.reported === true,
      reused_zero_cost: output.execution_mode === "reused"
    });
  }
  const finalOutputAccounted = components.some((component) => (
    component.kind === "final_output"
    || component.component === "workflow_composition"
    || component.component === "conversation_continuation"
  ));
  if (includeFinalOutput && !finalOutputAccounted) {
    components.push({
      component_key: "unreported-final-output",
      component: "final_synthesis",
      kind: "final_output",
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      charged_credits: "0",
      reported: false
    });
  }
  const usageReported = receipt.provider_reported === true || components.length > 0;
  return (
    <section className="usage-receipt" aria-label="Token usage and credit charge">
      <div className="usage-summary">
        <span>
          <strong>{formatTokenCount(receipt.total_tokens)} tokens</strong>
          <small>{usageReported ? `${formatTokenCount(receipt.prompt_tokens)} input · ${formatTokenCount(receipt.completion_tokens)} output` : "Provider token usage was not reported"}</small>
        </span>
        <span>
          <strong>{formatCreditDisplay(receipt.charged_credits)}</strong>
          <small>{receipt.balance_after_credits == null ? "No balance change" : `${formatCreditDisplay(receipt.balance_after_credits)} remaining`}</small>
        </span>
      </div>
      {components.length > 0 && (
        <div className="usage-components" role="list" aria-label="Usage by router, agent, and final output">
          {components.map((component, index) => (
            <div className={`usage-component ${component.kind || "other"}`} role="listitem" key={component.component_key || `${component.component}-${index}`}>
              <span className="usage-kind-dot" aria-hidden="true" />
              <span>
                <strong>{usageComponentLabel(component, agents)}</strong>
                <small>{component.reused_zero_cost
                  ? "Kept from earlier · no agent model call"
                  : component.reported === false
                  ? "Provider token usage was not reported for this output"
                  : `${formatTokenCount(component.prompt_tokens)} input · ${formatTokenCount(component.completion_tokens)} output · ${formatCreditDisplay(component.charged_credits)}`}</small>
              </span>
              <em>{component.reused_zero_cost
                ? "0 calls"
                : component.reported === false ? "Not reported" : `${formatTokenCount(component.total_tokens)} tokens`}</em>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function usageComponentLabel(component, agents) {
  if (component.kind === "agent") return formatAgentName(component.agent_id, agents);
  if (component.kind === "router") return "Router";
  if (component.kind === "final_output") {
    return component.component === "conversation_continuation" ? "Conversation response" : "Final answer";
  }
  return String(component.component || "Model call")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function RunProgress({ run }) {
  return (
    <div className="run-progress" role="status" aria-live="polite" aria-atomic="true">
      <LoaderCircle className="spin" size={17} />
      <span>{runStatusLabel(run?.status)}</span>
    </div>
  );
}

export function EmptyTeamWelcome({
  readOnly = false,
  workspace = null,
  agents = [],
  onStart = () => undefined,
  onBuildWorkflow = () => undefined,
  onOpenTeam = () => undefined
}) {
  const readyAgents = availableSessionAgents(agents).filter((agent) => agent.session_active !== false);
  const visibleAgents = readyAgents.slice(0, 4);
  const remaining = Math.max(0, readyAgents.length - visibleAgents.length);
  const teamName = workspace?.name || "General";
  const hasTeam = readyAgents.length > 0;

  if (readOnly) {
    return (
      <div className="empty-chat team-welcome read-only">
        <span className="team-welcome-kicker">READ-ONLY ACCOUNT</span>
        <h1>No conversation selected</h1>
        <p>Choose a conversation from history to review the team’s work.</p>
      </div>
    );
  }

  return (
    <div className="empty-chat team-welcome">
      <span className="team-welcome-kicker"><Sparkles size={13} /> {hasTeam ? `${teamName} IS READY` : "YOUR TEAM SPACE IS READY"}</span>
      <h1>{hasTeam ? "What should your team accomplish?" : "What do you want to accomplish?"}</h1>
      <p>{hasTeam
        ? `Describe the outcome. Virenis will assign the right work across your ${readyAgents.length} available ${readyAgents.length === 1 ? "specialist" : "specialists"}.`
        : "Start with a request now, or add a specialist when you want repeatable expertise."}</p>
      {hasTeam && (
        <div className="team-welcome-roster" aria-label={`${teamName} team members`}>
          <div className="team-welcome-avatars" aria-hidden="true">
            {visibleAgents.map((agent, index) => (
              <span className={`team-avatar tone-${(index % 5) + 1}`} key={agent.id}>
                {formatAgentName(agent.id, agents).slice(0, 1)}
              </span>
            ))}
            {remaining > 0 && <span className="team-avatar more">+{remaining}</span>}
          </div>
          <span><strong>Your active team</strong><small>{visibleAgents.map((agent) => formatAgentName(agent.id, agents)).join(" · ")}{remaining ? ` · ${remaining} more` : ""}</small></span>
        </div>
      )}
      <div className="team-welcome-actions">
        <button type="button" className="welcome-action primary" onClick={onStart}><MessageCircle size={16} /><span><strong>Start with a request</strong><small>Ask once; your team handles the division of work</small></span></button>
        <button type="button" className="welcome-action" onClick={onBuildWorkflow}><WandSparkles size={16} /><span><strong>Build a repeatable workflow</strong><small>Describe a process and review the proposed team</small></span></button>
        <button type="button" className="welcome-action" onClick={onOpenTeam}><Layers3 size={16} /><span><strong>{hasTeam ? "Manage your team" : "Add your first specialist"}</strong><small>{hasTeam ? "Choose roles, tools, knowledge, and handoffs" : "Create a reusable role in a few guided steps"}</small></span></button>
      </div>
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
    { command: "workflow", title: "Build a repeatable workflow", detail: "Describe the process; review the team before anything is created" },
    { command: "agent", title: "Assemble a specialist team", detail: "Create a team you can call whenever you need it" }
  ].filter((item) => item.command.startsWith(commandMatch[1].toLowerCase())) : [];

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return agents
      .filter((agent) => agent.enabled !== false)
      .filter((agent) => agent.runtime_only !== true)
      .filter((agent) => agent.runtime_sync_pending !== true)
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
        label="Turn this into a workflow"
        className="composer-control workflow-trigger"
        onClick={() => {
          const nextValue = /^\/(?:workflow|agent)\b/i.test(value.trimStart())
            ? value
            : value.trim()
              ? `/workflow ${value.trimStart()}`
              : "/workflow ";
          onChange(nextValue);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        disabled={!canWrite || !sessionId}
      >
        <WandSparkles size={18} />
      </IconButton>
      <IconButton
        label="Choose your team for this chat"
        className={`composer-control agent-trigger ${agentMenuOpen ? "active" : ""}`}
        onClick={() => setAgentMenuOpen((open) => !open)}
        disabled={!sessionId}
        aria-expanded={agentMenuOpen}
      >
        <Network size={18} />
        {activeAgentCount > 0 && <span className="composer-count" aria-hidden="true">{activeAgentCount}</span>}
      </IconButton>
      {agentMenuOpen && (
        <div className="quick-agent-menu" aria-label="Your team for this chat">
          <div className="quick-menu-heading">
            <span><strong>Your team for this chat</strong><small>Available teammates are called only when their role fits.</small></span>
            <button type="button" onClick={() => { setAgentMenuOpen(false); onOpenAgents(); }}>Manage team</button>
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
            {quickAgents.length === 0 && <p>No specialists are on this team yet.</p>}
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
          placeholder={canWrite ? "Tell your team what you need…" : "This conversation is read-only"}
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
  billing,
  agents,
  agentWorkspaces,
  activeAgentWorkspace,
  documents,
  runtime,
  metrics,
  marketplace,
  mcpConnections,
  mcpTemplates,
  mcpApprovals,
  resumeWorkflowId,
  sessionId,
  latestRun,
  initialView,
  togglingAgentId,
  onViewChange,
  onClose,
  onCreateAgent,
  onSelectAgentWorkspace,
  onCreateAgentWorkspace,
  onEditAgentWorkspace,
  onManageAgentWorkspace,
  onDeleteAgentWorkspace,
  onPublishAgentWorkspace,
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
  onRefreshBilling,
  onRefreshConnections,
  onSignedOut,
  onConnectionChanged
}) {
  const [view, setView] = useState(initialView || "agents");
  const canWrite = !auth?.is_viewer;
  const activeWorkspaceAgents = agentsForWorkspace(agents, activeAgentWorkspace);
  const workspaceLatestRun = latestRun
    && String(latestRun.agent_workspace_id || "") === String(activeAgentWorkspace?.agent_workspace_id || "")
    ? latestRun
    : null;
  function changeView(next) {
    setView(next);
    onViewChange(next);
    if (next === "account") void onRefreshBilling?.();
  }
  return (
    <ModalSurface title="Team studio" description="Build your team, equip each role, and decide how work moves." side="right" onClose={onClose} className="resource-hub-sheet">
      <div className="sheet-body resource-sheet-body">
        <div className="view-switch resource-nav" aria-label="Team studio sections">
          <button type="button" aria-pressed={view === "agents"} onClick={() => changeView("agents")}>My team</button>
          <button type="button" aria-pressed={view === "graph"} onClick={() => changeView("graph")}>Team map</button>
          <button type="button" aria-pressed={view === "marketplace"} onClick={() => changeView("marketplace")}>Discover</button>
          <button type="button" aria-pressed={view === "connections"} onClick={() => changeView("connections")}>Apps</button>
          <button type="button" aria-pressed={view === "knowledge"} onClick={() => changeView("knowledge")}>Knowledge</button>
          <button type="button" aria-pressed={view === "account"} onClick={() => changeView("account")}>Account</button>
          {auth?.is_admin && <button type="button" aria-pressed={view === "admin"} onClick={() => changeView("admin")}>Admin</button>}
        </div>

        {view === "agents" && (
          <AgentCatalog
            agents={activeWorkspaceAgents}
            workspaces={agentWorkspaces}
            activeWorkspace={activeAgentWorkspace}
            auth={auth}
            onCreate={onCreateAgent}
            onSelectWorkspace={onSelectAgentWorkspace}
            onCreateWorkspace={onCreateAgentWorkspace}
            onEditWorkspace={onEditAgentWorkspace}
            onManageWorkspace={onManageAgentWorkspace}
            onDeleteWorkspace={onDeleteAgentWorkspace}
            onPublishWorkspace={onPublishAgentWorkspace}
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
            agents={activeWorkspaceAgents}
            auth={auth}
            workspace={activeAgentWorkspace}
            run={workspaceLatestRun}
            storageKey={`virenis:agent-graph:${auth?.workspace_id || "workspace"}:${activeAgentWorkspace?.agent_workspace_id || "general"}`}
            onConnect={onConnectAgents}
            onDisconnect={onDisconnectAgents}
            onCreate={onCreateAgent}
            onEdit={onEditAgent}
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
            agents={agents}
            templates={mcpTemplates}
            approvals={mcpApprovals}
            canWrite={canWrite}
            isAdmin={auth?.is_admin === true}
            onRefresh={onRefreshConnections}
            resumeWorkflowId={resumeWorkflowId}
            onConnectionChanged={onConnectionChanged}
          />
        )}

        {view === "account" && (
          <AccountPanel auth={auth} billing={billing} onRefreshBilling={onRefreshBilling} onSignedOut={onSignedOut} />
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
  agents = [],
  templates = [],
  approvals = [],
  canWrite,
  isAdmin = false,
  onRefresh,
  resumeWorkflowId = "",
  onConnectionChanged = async () => undefined
}) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ template_id: "custom", name: "", endpoint_url: "", auth_type: "none", token: "", trust_read_annotations: false });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revocations, setRevocations] = useState([]);
  const [resolutionDraft, setResolutionDraft] = useState(null);
  const [disconnectTarget, setDisconnectTarget] = useState(null);
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const recentApprovals = approvals.filter((approval) => approval.status !== "pending").slice(-4).reverse();
  const managedProviders = templates.filter((template) => template.connection_mode === "managed");
  const customTemplates = templates.filter((template) => template.connection_mode !== "managed");

  async function refreshRevocations({ reportError = false } = {}) {
    try {
      const result = await api.get("/api/mcp/revocations");
      setRevocations(result.revocations || []);
    } catch (revocationError) {
      if (reportError) setError(friendlyError(revocationError));
    }
  }

  useEffect(() => {
    let active = true;
    void api.get("/api/mcp/revocations")
      .then((result) => {
        if (active) setRevocations(result.revocations || []);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

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
      setNotice(result.revocation_pending
        ? `${connection.name} was removed. Provider access is being revoked safely in the background.`
        : `${connection.name} was disconnected securely.`);
      await onRefresh();
      await refreshRevocations();
      setDisconnectTarget(null);
    } catch (deleteError) {
      setError(friendlyError(deleteError));
    } finally {
      setBusy("");
    }
  }

  async function retryRevocation(revocation) {
    setBusy(revocation.revocation_id);
    setError("");
    setNotice("");
    try {
      await api.post(`/api/mcp/revocations/${encodeURIComponent(revocation.revocation_id)}/retry`, {});
      setNotice("Provider access was revoked successfully.");
      await refreshRevocations({ reportError: true });
    } catch (revocationError) {
      setError(friendlyError(revocationError));
      await refreshRevocations();
    } finally {
      setBusy("");
    }
  }

  async function resolveRevocation(event, revocation) {
    event.preventDefault();
    if (!resolutionDraft?.confirmed) {
      setError("Confirm that you removed this app's provider access before recording verification.");
      return;
    }
    setBusy(revocation.revocation_id);
    setError("");
    setNotice("");
    try {
      await api.post(`/api/admin/mcp/revocations/${encodeURIComponent(revocation.revocation_id)}/resolve`, {
        confirmation: revocation.manual_resolution_required
          ? "PROVIDER_APP_ACCESS_REVOKED_AND_VERIFIED"
          : "PROVIDER_ACCESS_REVOKED",
        evidence_reference: resolutionDraft.evidence_reference,
        reason: resolutionDraft.reason
      });
      setResolutionDraft(null);
      setNotice("Provider removal was verified and recorded in the security audit.");
      await refreshRevocations({ reportError: true });
      await onRefresh();
    } catch (resolutionError) {
      setError(friendlyError(resolutionError));
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
          <span className="eyebrow">TEAM APPS</span>
          <h2 id="connections-heading">Connected apps</h2>
          <p>Sign in once, then choose the exact app abilities each specialist may request.</p>
        </div>
        {canWrite && <button type="button" className="text-button ghost" onClick={() => setShowForm((value) => !value)}><Settings2 size={15} />Advanced connection</button>}
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="connection-notice" role="status">{notice}</div>}
      {resumeWorkflowId && <div className="connection-notice" role="status">This connection will return you to the saved workflow automatically.</div>}

      {revocations.length > 0 && (
        <div className="connection-revocation-stack" role="status" aria-label="Provider disconnects still being verified">
          <div className="connections-subheading"><span><ShieldCheck size={15} /></span><div><strong>Finishing secure disconnect</strong><small>The connection is already unavailable to agents. Virenis keeps retrying until the provider confirms that access is revoked.</small></div></div>
          {revocations.map((revocation) => (
            <article className="connection-revocation-card" key={revocation.revocation_id}>
              <div><strong>{templates.find((template) => template.id === revocation.provider_id)?.name || revocation.provider_id || "Connected provider"}</strong><small>{revocation.attempts ? `${revocation.attempts} ${revocation.attempts === 1 ? "attempt" : "attempts"} · ` : ""}{revocation.manual_resolution_required ? "Administrator verification is required" : "No agent can use this connection"}</small></div>
              {canWrite && !revocation.manual_resolution_required && <button type="button" className="text-button ghost compact" disabled={busy === revocation.revocation_id} onClick={() => retryRevocation(revocation)}>{busy === revocation.revocation_id ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}Retry now</button>}
              {isAdmin && <button type="button" className="text-button ghost compact" disabled={busy === revocation.revocation_id} onClick={() => setResolutionDraft((current) => current?.revocation_id === revocation.revocation_id ? null : { revocation_id: revocation.revocation_id, evidence_reference: "", reason: "", confirmed: false })}><ShieldCheck size={13} />Record provider removal</button>}
              {isAdmin && resolutionDraft?.revocation_id === revocation.revocation_id && (
                <form className="revocation-resolution-form" onSubmit={(event) => resolveRevocation(event, revocation)}>
                  <p><strong>First remove Virenis access in the provider’s security settings.</strong> This does not call the provider again; it records your verified evidence so cleanup can finish safely.</p>
                  <label><span>Evidence reference</span><input value={resolutionDraft.evidence_reference} onChange={(event) => setResolutionDraft((current) => ({ ...current, evidence_reference: event.target.value }))} required maxLength={300} placeholder="Provider audit event, ticket, or screenshot reference" /></label>
                  <label><span>Why this proves removal</span><textarea value={resolutionDraft.reason} onChange={(event) => setResolutionDraft((current) => ({ ...current, reason: event.target.value }))} required maxLength={500} placeholder="App access was removed and verified in the provider account." /></label>
                  <label className="revocation-confirm"><input type="checkbox" checked={resolutionDraft.confirmed} onChange={(event) => setResolutionDraft((current) => ({ ...current, confirmed: event.target.checked }))} /><span>I verified that provider access is revoked for this app.</span></label>
                  <button type="submit" className="text-button primary compact" disabled={!resolutionDraft.confirmed || busy === revocation.revocation_id}>{busy === revocation.revocation_id ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}Finish secure cleanup</button>
                </form>
              )}
            </article>
          ))}
        </div>
      )}

      {managedProviders.length > 0 && (
        <div className="managed-connections-block">
          <div className="connections-subheading"><span><Plug size={15} /></span><div><strong>Connect your accounts</strong><small>No endpoints or tokens to copy. Sign in securely and choose what your specialists can use.</small></div></div>
          <div className="managed-provider-grid">
            {managedProviders.map((provider) => {
              const providerConnections = connections.filter((connection) => connection.provider_id === provider.id);
              const connecting = busy === `provider:${provider.id}`;
              return (
                <article className={`managed-provider-card provider-${provider.id}`} key={provider.id}>
                  <div className="managed-provider-head">
                    <span className={`managed-provider-icon ${provider.id}`}><ManagedProviderIcon providerId={provider.id} /></span>
                    <div><em>{provider.category || "Integration"}</em><strong>{provider.name}</strong><small>{provider.description}</small></div>
                    <i className={provider.setup_mode === "automatic" ? "automatic" : ""}>{provider.setup_mode === "automatic" ? "Instant setup" : provider.preview ? "Preview" : "Secure sign-in"}</i>
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
              <ApprovalArguments argumentsValue={approval.arguments} />
              <div className="approval-actions">
                <button type="button" className="text-button ghost" disabled={busy === approval.approval_id} onClick={() => decideApproval(approval, "deny")}>Don’t run</button>
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

      {disconnectTarget && (() => {
        const affectedAgents = agents.filter((agent) => (agent.mcp_bindings || []).some((binding) => binding.connection_id === disconnectTarget.connection_id));
        return (
          <div className="connection-disconnect-confirm" role="alertdialog" aria-labelledby="disconnect-app-heading" aria-describedby="disconnect-app-description">
            <span><AlertCircle size={18} /></span>
            <div><strong id="disconnect-app-heading">Disconnect {disconnectTarget.name}?</strong><p id="disconnect-app-description">{affectedAgents.length ? `${affectedAgents.length} ${affectedAgents.length === 1 ? "specialist" : "specialists"} will lose these app abilities. Existing chat answers stay unchanged.` : "No current specialist uses this connection. Existing chat answers stay unchanged."}</p>{affectedAgents.length > 0 && <small>{affectedAgents.slice(0, 4).map((agent) => formatAgentName(agent.id, agents)).join(" · ")}{affectedAgents.length > 4 ? ` · ${affectedAgents.length - 4} more` : ""}</small>}</div>
            <div><button type="button" className="text-button ghost" onClick={() => setDisconnectTarget(null)} disabled={busy === disconnectTarget.connection_id}>Keep connected</button><button type="button" className="text-button danger" onClick={() => deleteConnection(disconnectTarget)} disabled={busy === disconnectTarget.connection_id}>{busy === disconnectTarget.connection_id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}Disconnect account</button></div>
          </div>
        );
      })()}

      <div className="connection-list">
        {connections.map((connection) => (
          <article className={`connection-card ${connection.status !== "ready" ? "connection-needs-attention" : ""}`} key={connection.connection_id}>
            <div className="connection-card-head"><span className={`connection-icon ${connection.provider_id || "custom"}`}>{connection.connection_mode === "managed" ? <ManagedProviderIcon providerId={connection.provider_id} size={17} /> : <Plug size={17} />}</span><div><strong>{connection.name}</strong><small>{connection.connection_mode === "managed" ? "Connected securely with OAuth" : `${connection.endpoint_origin} · ${connection.auth_type === "bearer" ? "Protected" : "No auth"}`}</small></div><i className={connection.status === "ready" ? "connection-ready" : "connection-warning"}><span />{connection.status === "ready" ? "Ready" : "Reconnect"}</i></div>
            <div className="connection-tools">
              {(connection.tools || []).map((tool) => <span className={!tool.requires_approval ? "read" : "write"} key={tool.name}>{tool.title || tool.name}<small>{!tool.requires_approval ? "Read" : "Approval"}</small></span>)}
            </div>
            <footer><small>{connection.tools?.length || 0} available abilities · {connection.read_policy === "allow_declared_reads" ? "approved read actions run automatically" : "every action asks first"}</small>{canWrite && <div>{connection.reauthorization_required && <button type="button" className="text-button primary compact" disabled={busy === connection.connection_id} onClick={() => connectManaged(templates.find((template) => template.id === connection.provider_id) || { id: connection.provider_id, availability: "available" }, connection.connection_id)}>{busy === connection.connection_id ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}Reconnect</button>}<IconButton compact label={`Refresh available abilities for ${connection.name}`} disabled={busy === connection.connection_id || connection.reauthorization_required} onClick={() => refreshConnection(connection)}><RefreshCw className={busy === connection.connection_id ? "spin" : ""} size={15} /></IconButton><IconButton compact label={`Disconnect ${connection.name}`} disabled={busy === connection.connection_id} onClick={() => setDisconnectTarget(connection)}><Trash2 size={15} /></IconButton></div>}</footer>
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
  workspaces = [],
  activeWorkspace = null,
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
  onUnpublish,
  onSelectWorkspace = () => undefined,
  onCreateWorkspace = () => undefined,
  onEditWorkspace = () => undefined,
  onManageWorkspace = () => undefined,
  onDeleteWorkspace = () => undefined,
  onPublishWorkspace = () => undefined
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
      {activeWorkspace && (
        <div className="agent-workspace-toolbar">
          <label>
            <span>Active team</span>
            <select
              value={activeWorkspace.agent_workspace_id}
              onChange={(event) => onSelectWorkspace(event.target.value)}
              disabled={!canWrite}
            >
              {workspaces.map((workspace) => (
                <option value={workspace.agent_workspace_id} key={workspace.agent_workspace_id}>
                  {workspace.name} · {workspace.agent_count} specialist{workspace.agent_count === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </label>
          <div className="team-toolbar-actions">
            <button type="button" className="team-add-button" onClick={onCreate} disabled={!canWrite || (activeWorkspace?.agent_count || 0) >= (activeWorkspace?.max_agents || 16)}><Plus size={15} />Add specialist</button>
            <button type="button" onClick={() => onManageWorkspace(activeWorkspace)} disabled={!canWrite}><Layers3 size={14} />Choose members</button>
            <details className="team-more-menu">
              <summary aria-label="More team actions"><Menu size={15} />More</summary>
              <div>
                <button type="button" onClick={onCreateWorkspace} disabled={!canWrite}><Plus size={14} />Create another team</button>
                <button type="button" onClick={() => onEditWorkspace(activeWorkspace)} disabled={!canWrite}><Pencil size={14} />Team details</button>
                <button type="button" onClick={() => onPublishWorkspace(activeWorkspace)} disabled={!canWrite || !activeWorkspace.agent_count}>
                  {activeWorkspace.marketplace?.published ? <Pencil size={14} /> : <Upload size={14} />}
                  {activeWorkspace.marketplace?.published ? "Edit public listing" : "Publish team publicly"}
                </button>
                {activeWorkspace.marketplace?.published && (
                  <button
                    type="button"
                    onClick={() => onUnpublish({
                      ...activeWorkspace,
                      id: activeWorkspace.agent_workspace_id,
                      title: activeWorkspace.name,
                      item_type: "workspace"
                    })}
                    disabled={!canWrite}
                  ><Globe2 size={14} />Remove public listing</button>
                )}
                {!activeWorkspace.is_general && (
                  <button type="button" className="danger" onClick={() => onDeleteWorkspace(activeWorkspace)} disabled={!canWrite}><Trash2 size={14} />Delete team</button>
                )}
              </div>
            </details>
          </div>
          <p>{activeWorkspace.description || "Your specialists share work here and can be assigned together in chat."}</p>
          {activeWorkspace.setup_error && <div className="agent-workspace-error" role="alert"><AlertCircle size={14} />{activeWorkspace.setup_error}</div>}
        </div>
      )}
      <div className="section-heading">
        <div>
          <h3 id="agents-heading">Your specialists</h3>
          <p>Keep the right roles available. The Router assigns only those whose job fits your request.</p>
        </div>
      </div>
      <label className="search-field full-width">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Search agents</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this team" />
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
                <small>{archived ? "Archived" : runtimeOnly ? "Needs an owner" : agent.session_active === false ? "Paused for this chat" : "Available for this chat"}</small>
                {realityRankSummary(agent.reality_rank).samples > 0 && <RealityRank rank={agent.reality_rank} />}
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
                    <label className="agent-duty-control" title={`${agent.session_active === false ? "Make available" : "Pause"} for this chat`}>
                      <span>{agent.session_active === false ? "Paused" : "Available"}</span>
                      <input
                        type="checkbox"
                        checked={agent.session_active !== false}
                        disabled={togglingAgentId === agent.id}
                        onChange={(event) => onToggle(agent, event.target.checked)}
                      />
                      <i aria-hidden="true" />
                    </label>
                  )}
                  {manageable && !archived && <button type="button" className="agent-open-action" onClick={() => onEdit(agent)}>Open</button>}
                  {manageable && (
                    <details className="agent-row-menu">
                      <summary aria-label={`More actions for ${formatAgentName(agent.id, agents)}`}><Menu size={16} /></summary>
                      <div>
                        {!archived && <button type="button" onClick={() => onPublish(agent)}>{agent.marketplace?.published ? <Pencil size={14} /> : <Upload size={14} />}{agent.marketplace?.published ? "Edit public description" : "Publish publicly"}</button>}
                        {agent.marketplace?.published && <button type="button" onClick={() => onUnpublish(agent)}><Globe2 size={14} />Remove public listing</button>}
                        {archived ? agent.system_managed !== true && <button type="button" className="danger" onClick={() => onDelete(agent)}><Trash2 size={14} />Delete permanently</button> : <button type="button" onClick={() => onArchive(agent)}><Archive size={14} />Archive specialist</button>}
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="empty-resource-state team-empty-state">
            <span><UserPlus size={22} /></span>
            <h3>{query ? "No specialists match that search" : "Build your first specialist"}</h3>
            <p>{query ? "Try a role name or a broader phrase." : "Give one role a clear job. You can add knowledge, apps, and teammates in the guided setup."}</p>
            {!query && <button type="button" className="text-button primary" onClick={onCreate} disabled={!canWrite}><Plus size={15} />Add a specialist</button>}
          </div>
        )}
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
  return [...edges.values()];
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

export function graphPositionForCanvas(bounds, position, nodeBounds = {}) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const renderedNodeWidth = Math.max(0, Number(nodeBounds?.width) || 148);
  const renderedNodeHeight = Math.max(0, Number(nodeBounds?.height) || 60);
  const horizontalInset = Math.min(450, ((renderedNodeWidth / 2 + 6) / width) * 900);
  const verticalInset = Math.min(280, ((renderedNodeHeight / 2 + 6) / height) * 560);
  return {
    x: Math.max(horizontalInset, Math.min(900 - horizontalInset, x)),
    y: Math.max(verticalInset, Math.min(560 - verticalInset, y))
  };
}

export function graphPositionFromPointer(bounds, clientX, clientY, nodeBounds = {}) {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return graphPositionForCanvas(bounds, {
    x: ((Number(clientX) - Number(bounds.left || 0)) / width) * 900,
    y: ((Number(clientY) - Number(bounds.top || 0)) / height) * 560
  }, nodeBounds);
}

export function graphEdgeEndpoints(from, to, nodeBounds = {}) {
  if (!from || !to) return null;
  const deltaX = Number(to.x) - Number(from.x);
  const deltaY = Number(to.y) - Number(from.y);
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (!deltaX && !deltaY)) return null;
  const halfWidth = Math.max(1, Number(nodeBounds.halfWidth) || 80);
  const halfHeight = Math.max(1, Number(nodeBounds.halfHeight) || 36);
  const boundaryScale = 1 / Math.max(Math.abs(deltaX) / halfWidth, Math.abs(deltaY) / halfHeight);
  return {
    from: { x: Number(from.x) + deltaX * boundaryScale, y: Number(from.y) + deltaY * boundaryScale },
    to: { x: Number(to.x) - deltaX * boundaryScale, y: Number(to.y) - deltaY * boundaryScale }
  };
}

export function graphEdgePath(from, to) {
  if (!from || !to) return "";
  const endpoints = graphEdgeEndpoints(from, to);
  if (!endpoints) return "";
  const start = endpoints.from;
  const end = endpoints.to;
  const direction = end.x >= start.x ? 1 : -1;
  const bend = Math.max(42, Math.min(145, Math.abs(end.x - start.x) * 0.42));
  const verticalOffset = Math.abs(end.x - start.x) < 40 ? 52 : 0;
  return `M ${start.x} ${start.y} C ${start.x + direction * bend + verticalOffset} ${start.y}, ${end.x - direction * bend + verticalOffset} ${end.y}, ${end.x} ${end.y}`;
}

export function graphTone(agentId) {
  let hash = 0;
  for (const character of String(agentId || "specialist")) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % 5 + 1;
}

export function initialGraphPositions(agents) {
  const centerX = 450;
  const centerY = 278;
  const positions = {};
  if (!agents.length) return positions;
  const configuredEdges = graphConnections(agents).filter((edge) => edge.kind === "handoff");
  if (agents.length <= 10 && configuredEdges.length) {
    const agentIds = new Set(agents.map((agent) => agent.id));
    const incoming = new Map(agents.map((agent) => [agent.id, 0]));
    const downstream = new Map(agents.map((agent) => [agent.id, []]));
    for (const edge of configuredEdges) {
      if (!agentIds.has(edge.from) || !agentIds.has(edge.to)) continue;
      incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
      downstream.get(edge.from).push(edge.to);
    }
    const queue = agents.filter((agent) => incoming.get(agent.id) === 0).map((agent) => agent.id);
    const levels = new Map(queue.map((id) => [id, 0]));
    const visited = new Set();
    while (queue.length) {
      const id = queue.shift();
      visited.add(id);
      for (const nextId of downstream.get(id) || []) {
        levels.set(nextId, Math.max(levels.get(nextId) || 0, (levels.get(id) || 0) + 1));
        incoming.set(nextId, incoming.get(nextId) - 1);
        if (incoming.get(nextId) === 0) queue.push(nextId);
      }
    }
    const maxLevel = Math.max(0, ...levels.values());
    if (visited.size === agents.length && maxLevel <= 4) {
      const columns = new Map();
      for (const agent of agents) {
        const level = levels.get(agent.id) || 0;
        if (!columns.has(level)) columns.set(level, []);
        columns.get(level).push(agent);
      }
      for (const [level, columnAgents] of columns) {
        columnAgents.sort((left, right) => String(left.title || left.id).localeCompare(String(right.title || right.id)));
        columnAgents.forEach((agent, row) => {
          positions[agent.id] = {
            x: maxLevel ? 92 + (level / maxLevel) * 716 : centerX,
            y: 68 + ((row + 0.5) / columnAgents.length) * 420
          };
        });
      }
      return positions;
    }
  }
  const connectionCounts = new Map(agents.map((agent) => [agent.id, 0]));
  for (const edge of graphConnections(agents)) {
    connectionCounts.set(edge.from, (connectionCounts.get(edge.from) || 0) + 1);
    connectionCounts.set(edge.to, (connectionCounts.get(edge.to) || 0) + 1);
  }
  const ordered = [...agents].sort((left, right) =>
    (connectionCounts.get(right.id) || 0) - (connectionCounts.get(left.id) || 0)
      || String(left.title || left.id).localeCompare(String(right.title || right.id))
  );
  if (ordered.length > 10) {
    const columns = Math.min(5, Math.ceil(Math.sqrt(ordered.length * 1.3)));
    const rows = Math.ceil(ordered.length / columns);
    ordered.forEach((agent, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      positions[agent.id] = {
        x: 64 + ((column + 0.5) / columns) * 772,
        y: 44 + ((row + 0.5) / rows) * 472
      };
    });
    return positions;
  }
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

export function worldGraphAgentStatuses(decisions = []) {
  const statuses = new Map();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    const adapter = String(decision?.adapter || "");
    if (!adapter || !["kept", "refreshed"].includes(decision?.action)) continue;
    const current = statuses.get(adapter) || { kept: 0, refreshed: 0, total: 0, action: "" };
    current[decision.action] += 1;
    current.total += 1;
    current.action = current.kept > 0 && current.refreshed > 0
      ? "mixed"
      : current.refreshed > 0 ? "refreshed" : "kept";
    statuses.set(adapter, current);
  }
  return statuses;
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

export function AgentGraph({ agents, auth, workspace = null, storageKey, onConnect, onDisconnect, onCreate, onEdit, run = null }) {
  const eligibleGraphAgents = agents
    .filter((agent) => !agent.document && !agent.resource_for_agent_id && agent.enabled !== false);
  const graphAgents = eligibleGraphAgents.slice(0, 25);
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
  const [graphNotice, setGraphNotice] = useState("");
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const canvasRef = useRef(null);
  const inspectorRef = useRef(null);
  const dragStateRef = useRef(null);
  const draggedRef = useRef(false);
  const allEdges = graphConnections(eligibleGraphAgents);
  const visibleAgentIds = new Set(graphAgents.map((agent) => agent.id));
  const edges = allEdges.filter((edge) => visibleAgentIds.has(edge.from) && visibleAgentIds.has(edge.to));
  const focusedAgent = graphAgents.find((agent) => agent.id === focusedId);
  const focusedEdges = focusedId
    ? allEdges.filter((edge) => edge.from === focusedId || edge.to === focusedId)
    : [];
  const latestStatuses = worldGraphAgentStatuses(run?.world_graph?.decisions || []);
  const latestWorkCounts = [...latestStatuses.values()].reduce((counts, status) => ({
    kept: counts.kept + status.kept,
    refreshed: counts.refreshed + status.refreshed
  }), { kept: 0, refreshed: 0 });
  const latestGraphAvailable = run?.status === "completed"
    && ["unchecked", "current"].includes(run?.world_graph?.validity)
    && Number(run?.world_graph?.total || 0) > 0
    && latestWorkCounts.kept + latestWorkCounts.refreshed > 0;

  useEffect(() => {
    setPositions({
      ...initialGraphPositions(graphAgents),
      ...storedGraphPositions(storageKey)
    });
    setFocusedId(null);
    setConnectFromId(null);
    setMoveAnnouncement("");
  }, [graphAgentIds, storageKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const keepVisible = () => {
      const bounds = canvas.getBoundingClientRect();
      const nodeBounds = canvas.querySelector(".graph-node")?.getBoundingClientRect() || {};
      setPositions((current) => {
        let changed = false;
        const next = { ...current };
        for (const agent of graphAgents) {
          const safe = graphPositionForCanvas(bounds, current[agent.id] || { x: 450, y: 278 }, nodeBounds);
          if (!safe) continue;
          if (safe.x !== current[agent.id]?.x || safe.y !== current[agent.id]?.y) changed = true;
          next[agent.id] = safe;
        }
        return changed ? next : current;
      });
    };
    keepVisible();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", keepVisible);
      return () => window.removeEventListener("resize", keepVisible);
    }
    const observer = new ResizeObserver(keepVisible);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [graphAgentIds]);

  useEffect(() => {
    if (!focusedId || connectMode || !inspectorRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => inspectorRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [connectMode, focusedId]);

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
      event.clientY,
      event.currentTarget.getBoundingClientRect()
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
    const canvas = canvasRef.current;
    const bounds = canvas?.getBoundingClientRect();
    const nodeBounds = canvas?.querySelector(".graph-node")?.getBoundingClientRect() || {};
    const initial = initialGraphPositions(graphAgents);
    setPositions(Object.fromEntries(graphAgents.map((agent) => [
      agent.id,
      graphPositionForCanvas(bounds, initial[agent.id], nodeBounds) || initial[agent.id]
    ])));
    setFocusedId(null);
    setConnectFromId(null);
    setGraphError("");
    setGraphNotice("");
    setMoveAnnouncement("Agent layout reset.");
  }

  function moveFocused(deltaX, deltaY, direction) {
    if (!focusedId) return;
    setPositions((current) => {
      const position = current[focusedId] || { x: 450, y: 278 };
      const canvas = canvasRef.current;
      const nextPosition = graphPositionForCanvas(
        canvas?.getBoundingClientRect(),
        { x: position.x + deltaX, y: position.y + deltaY },
        canvas?.querySelector(".graph-node")?.getBoundingClientRect() || {}
      ) || position;
      return {
        ...current,
        [focusedId]: nextPosition
      };
    });
    setMoveAnnouncement(`${formatAgentName(focusedId, agents)} moved ${direction}.`);
  }

  function toggleConnectMode() {
    setConnectMode((current) => !current);
    setConnectFromId(null);
    setGraphError("");
    setGraphNotice("");
  }

  function closeInspector() {
    const agentId = focusedId;
    setFocusedId(null);
    window.requestAnimationFrame(() => {
      [...(canvasRef.current?.querySelectorAll("[data-graph-agent]") || [])]
        .find((node) => node.dataset.graphAgent === agentId)
        ?.focus();
    });
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
    if (allEdges.some((edge) => edge.from === connectFromId && edge.to === agent.id && edge.kind === "handoff")) {
      setGraphError("Those agents already have a handoff connection.");
      return;
    }
    if (graphConnectionWouldCycle(allEdges, connectFromId, agent.id)) {
      setGraphError("That handoff would create a circular workflow. Choose another direction.");
      return;
    }
    setConnectionBusy(true);
    setGraphError("");
    try {
      await onConnect?.(connectFromId, agent.id);
      setGraphNotice(`${formatAgentName(connectFromId, agents)} now hands completed work to ${formatAgentName(agent.id, agents)}.`);
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
    const target = eligibleGraphAgents.find((agent) => agent.id === edge.to);
    if (!canManageAgent(target, auth)) {
      setGraphError("You can remove connections only from agents you can edit.");
      return;
    }
    setConnectionBusy(true);
    setGraphError("");
    try {
      await onDisconnect?.(edge.from, edge.to);
      setGraphNotice(`The handoff from ${formatAgentName(edge.from, agents)} to ${formatAgentName(edge.to, agents)} was removed.`);
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
          <div><span className="section-eyebrow">{workspace?.name ? `${workspace.name.toUpperCase()} · TEAM MAP` : "CURRENT TEAM MAP"}</span><h3 id="graph-heading">Decide how your team passes work.</h3><p>Move specialists into a layout that makes sense to you, then connect who works first to who receives the result.</p></div>
          <span className="graph-count">{graphAgents.length}{eligibleGraphAgents.length > graphAgents.length ? ` of ${eligibleGraphAgents.length}` : ""} {eligibleGraphAgents.length === 1 ? "specialist" : "specialists"} · {edges.length} {edges.length === 1 ? "handoff" : "handoffs"}</span>
        </div>
        <div className="graph-toolbar" aria-label="Graph tools">
          <button type="button" className={connectMode ? "active" : ""} onClick={toggleConnectMode} disabled={auth?.is_viewer || graphAgents.length < 2 || connectionBusy}>
            <Network size={15} />{connectMode ? "Cancel" : "Connect teammates"}
          </button>
          <button type="button" onClick={resetLayout} disabled={!graphAgents.length || connectionBusy}><RefreshCw size={15} />Auto-arrange</button>
        </div>
      </div>
      <div className={`graph-guidance ${connectMode ? "active" : ""}`} role="status" aria-live="polite">
        <span>{connectMode ? connectFromId ? "Step 2 of 2 · Choose the teammate who receives the completed work." : "Step 1 of 2 · Choose the teammate who works first and sends the result." : "Drag teammates to organize the map. Select one to see who gives them work and where their result goes."}</span>
        <span className="graph-scroll-hint">On a small screen, scroll the map sideways.</span>
        {connectFromId && <strong>From: {formatAgentName(connectFromId, agents)}</strong>}
        {graphError && <em>{graphError}</em>}
      </div>
      {graphNotice && <div className="graph-success-notice" role="status"><Check size={14} /><span>{graphNotice}</span><button type="button" aria-label="Dismiss handoff update" onClick={() => setGraphNotice("")}><X size={13} /></button></div>}
      {eligibleGraphAgents.length > graphAgents.length && (
        <div className="graph-limit-note" role="note">
          <AlertCircle size={15} aria-hidden="true" />
          <span>Showing 25 of {eligibleGraphAgents.length} agents to keep the map readable. Lines involving hidden agents are omitted; select a visible agent to inspect all of its configured connections, or manage the full team in Agents.</span>
        </div>
      )}
      {latestGraphAvailable && (
        <div className="graph-run-summary" role="status">
          <Check size={15} aria-hidden="true" />
          <div>
            <strong>What your team did on the latest answer</strong>
            <span>{latestWorkCounts.kept} previous {latestWorkCounts.kept === 1 ? "result" : "results"} reused · {latestWorkCounts.refreshed} checked again</span>
            <small>The lines below show your saved handoffs. Open Answer details to see that run's exact assignment.</small>
          </div>
        </div>
      )}
      <div className={`graph-workspace ${focusedAgent && !connectMode ? "has-inspector" : ""}`}>
        <div className="graph-canvas-scroll" role="region" aria-label="Scrollable agent map" tabIndex="0">
        <div className={`agent-graph ${connectMode ? "is-connecting" : ""}`} ref={canvasRef} role="group" aria-label="Current agent team map. Select an agent to inspect its configured connections.">
        <svg viewBox="0 0 900 560" preserveAspectRatio="none" role="group" aria-label="Current configured handoff and knowledge links">
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
            const edgeLabel = edge.kind === "knowledge"
              ? `${formatAgentName(edge.from, agents)} provides knowledge to ${formatAgentName(edge.to, agents)}`
              : `${formatAgentName(edge.from, agents)} hands work to ${formatAgentName(edge.to, agents)}`;
            return (
              <g className={`graph-edge ${edge.kind} ${related ? "related" : ""}`} key={`${edge.from}-${edge.to}-${edge.kind}`} role="img" aria-label={edgeLabel}>
                <path className="edge-line" d={path} markerEnd={`url(#graph-arrow-${edge.kind})`} vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
        {graphAgents.map((agent) => {
          const position = positions[agent.id] || { x: 450, y: 278 };
          const connectionCount = allEdges.filter((edge) => edge.from === agent.id || edge.to === agent.id).length;
          const latestStatus = latestStatuses.get(agent.id);
          const latestStatusText = latestStatus?.action === "mixed"
            ? `Latest answer: ${latestStatus.kept} kept, ${latestStatus.refreshed} refreshed`
            : latestStatus?.action === "kept"
              ? `Latest answer: ${latestStatus.total} ${latestStatus.total === 1 ? "work item" : "work items"} kept`
              : latestStatus?.action === "refreshed"
                ? `Latest answer: ${latestStatus.total} ${latestStatus.total === 1 ? "work item" : "work items"} refreshed`
                : "";
          return (
            <button
              type="button"
              className={`graph-node tone-${graphTone(agent.id)} ${focusedId === agent.id ? "focused" : ""} ${connectFromId === agent.id ? "connection-source" : ""} ${agent.session_active === false ? "inactive" : ""} ${latestStatus?.action ? `world-${latestStatus.action}` : ""}`}
              style={{ left: `${(position.x / 900) * 100}%`, top: `${(position.y / 560) * 100}%` }}
              key={agent.id}
              onPointerDown={(event) => beginNodeDrag(event, agent.id)}
              onPointerMove={moveNode}
              onPointerUp={endNodeDrag}
              onPointerCancel={endNodeDrag}
              onClick={() => chooseNode(agent)}
              title={agentFacingText(agent.capability || agent.title)}
              aria-pressed={focusedId === agent.id}
              data-graph-agent={agent.id}
            >
              <span>{formatAgentName(agent.id, agents)}</span>
              <small>{latestStatusText || (connectionCount ? `${connectionCount} configured connection${connectionCount === 1 ? "" : "s"}` : "Ready to connect")}</small>
            </button>
          );
        })}
        {graphAgents.length === 0 && <div className="graph-empty"><span><Layers3 size={22} /></span><strong>Your team map is ready</strong><small>Add the first specialist, then connect work as your team grows.</small>{onCreate && <button type="button" onClick={onCreate} disabled={auth?.is_viewer}><Plus size={14} />Add a specialist</button>}</div>}
        </div>
        </div>
        {focusedAgent && !connectMode && (
          <aside ref={inspectorRef} tabIndex="-1" className="graph-inspector" aria-label={`${formatAgentName(focusedId, agents)} connections`}>
            <header><span>SELECTED TEAMMATE</span><button type="button" aria-label="Close teammate details" onClick={closeInspector}><X size={14} /></button></header>
            <strong>{formatAgentName(focusedId, agents)}</strong>
            <p>{agentFacingText(focusedAgent.capability, "No capability description yet.")}</p>
            {onEdit && canManageAgent(focusedAgent, auth) && <button type="button" className="graph-edit-agent" onClick={() => onEdit(focusedAgent)}><Pencil size={14} />Open specialist profile</button>}
            <div className="graph-move-controls" role="group" aria-label="Move selected agent without dragging">
              <button type="button" onClick={() => moveFocused(-36, 0, "left")} aria-label="Move selected agent left"><ArrowLeft size={14} /></button>
              <button type="button" onClick={() => moveFocused(0, -30, "up")} aria-label="Move selected agent up"><ArrowUp size={14} /></button>
              <button type="button" onClick={() => moveFocused(0, 30, "down")} aria-label="Move selected agent down"><ArrowDown size={14} /></button>
              <button type="button" onClick={() => moveFocused(36, 0, "right")} aria-label="Move selected agent right"><ArrowRight size={14} /></button>
            </div>
            <span className="sr-only" role="status" aria-live="polite">{moveAnnouncement}</span>
            <div className="graph-relations">
              {focusedEdges.map((edge) => {
                const incoming = edge.to === focusedId;
                const otherId = incoming ? edge.from : edge.to;
                const removable = edge.kind === "handoff" && canManageAgent(eligibleGraphAgents.find((agent) => agent.id === edge.to), auth);
                const relationship = edge.kind === "knowledge"
                  ? incoming ? "Knowledge from" : "Knowledge for"
                  : incoming ? "Gets work from" : "Passes work to";
                return (
                  <div key={`${edge.from}-${edge.to}-${edge.kind}`}>
                    <span><small>{relationship}</small><b>{formatAgentName(otherId, agents)}</b><i>{edge.kind === "handoff" ? "Handoff" : "Knowledge"}</i></span>
                    {removable && <button type="button" onClick={() => removeConnection(edge)} disabled={connectionBusy} aria-label={`Remove connection with ${formatAgentName(otherId, agents)}`}><X size={13} /></button>}
                  </div>
                );
              })}
              {focusedEdges.length === 0 && <span className="graph-no-relations">No handoffs yet. Choose “Connect teammates” to decide how this specialist shares work.</span>}
            </div>
          </aside>
        )}
      </div>
      <div className="graph-legend">
        <span className="palette"><i /><i /><i /></span><span>Names identify agents; color helps scan the map</span>
        <span><i className="handoff" />Work moves in the arrow direction</span><span><i className="knowledge" />Knowledge link</span>
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
        <h3 id="marketplace-heading">Shared agents and teams, ready to make your own.</h3>
        <p>Inspect how an agent or workspace works, see who published it, rate it, or copy an independent version.</p>
      </div>
      <div className="marketplace-toolbar">
        <label className="search-field full-width"><Search size={16} /><span className="sr-only">Search marketplace</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents or publishers" /></label>
      </div>
      <div className="marketplace-grid">
        {filtered.map((item) => (
          <article className="market-card" key={item.listing_id || item.id}>
            <button type="button" className="market-card-open" onClick={() => onOpen(item)} aria-label={`View ${agentFacingText(item.title, "community agent")}`}>
              <header><span className={`market-type ${item.item_type}`}>
                {item.item_type === "workspace" ? <Network size={13} /> : <Bot size={13} />}
                {item.item_type === "workspace" ? "workspace" : "agent"}
              </span><ChevronRight size={15} /></header>
              <h4>{agentFacingText(item.title, "Community agent")}</h4>
              <p>{agentFacingText(item.description || item.capability)}</p>
              <small className="market-author">Published by {item.publisher_display_name || item.publisher?.user_id || item.published_by || "Virenis"}</small>
              {item.workspace_copy && <span className="market-copy-state"><Check size={12} />Copied as {item.workspace_copy.title || item.workspace_copy.name}</span>}
            </button>
            <footer>
              <span className="market-rating"><Star size={14} fill="currentColor" />{item.rating_count ? item.rating_average.toFixed(1) : "New"}<small>{item.rating_count ? `(${item.rating_count})` : ""}</small></span>
              {item.is_self_published
                ? <span className="market-own-listing"><Check size={12} />Your listing</span>
                : <button type="button" onClick={() => onRate(item)} disabled={auth?.is_viewer}>{item.my_rating ? "Update rating" : "Rate"}</button>}
            </footer>
          </article>
        ))}
        {filtered.length === 0 && <div className="market-empty"><Sparkles size={22} /><strong>No matches yet</strong><span>Try a broader search or publish an agent or workspace from the Agents tab.</span></div>}
      </div>
    </section>
  );
}

export function PublishDialog({ agent, onClose, onSaved }) {
  const existing = agent.marketplace || {};
  const workspaceListing = agent.item_type === "workspace";
  const [description, setDescription] = useState(agentFacingText(existing.description || existing.summary || agent.capability));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/marketplace/items/${encodeURIComponent(agent.id)}`, {
        item_type: workspaceListing ? "workspace" : "agent",
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
    <ModalSurface title={existing.published ? "Edit Marketplace description" : "Publish to Marketplace"} description={`Share a clear description. People can inspect the ${workspaceListing ? "workspace" : "agent"} before copying it.`} onClose={onClose} className="form-dialog">
      <form className="dialog-form publish-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="publish-subject"><span className={`market-type ${workspaceListing ? "workspace" : "agent"}`}>{workspaceListing ? <Network size={13} /> : <Bot size={13} />}{workspaceListing ? "workspace" : "agent"}</span><strong>{workspaceListing ? agent.name || agent.title : formatAgentName(agent.id, [agent])}</strong></div>
        <label><span>{workspaceListing ? "Workspace" : "Agent"} description</span><textarea data-autofocus value={description} onChange={(event) => setDescription(event.target.value)} required maxLength={1200} placeholder={`Explain what this ${workspaceListing ? "team" : "agent"} helps with and when someone should use it.`} /></label>
        <div className="publish-note">{workspaceListing ? <Network size={16} /> : <Bot size={16} />}<span><strong>Safe sharing</strong><small>Private notes, uploaded knowledge, credentials, and live MCP bindings are not included.</small></span></div>
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
    <ModalSurface title={`Rate ${agentFacingText(item.title, item.item_type === "workspace" ? "workspace" : "agent")}`} description="Select a star rating from 1 to 5." onClose={onClose} className="small-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <fieldset className="star-picker"><legend>Your rating</legend>{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} aria-label={`${value} star${value === 1 ? "" : "s"}`} aria-pressed={score === value} onClick={() => setScore(value)}><Star size={25} fill={value <= score ? "currentColor" : "none"} /></button>)}</fieldset>
        <div className="dialog-actions"><button type="button" className="text-button ghost" onClick={onClose}>Cancel</button><button type="submit" className="text-button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Star size={16} />}Save rating</button></div>
      </form>
    </ModalSurface>
  );
}

export function MarketplaceWorkspaceAgentDetails({
  entry,
  workspaceTitle,
  publisher,
  onBack = () => undefined
}) {
  const agent = entry?.agent || {};
  const title = agentFacingText(agent.title, "Workspace agent");
  const description = agentFacingText(agent.capability, "No purpose provided.");
  const tools = Array.isArray(agent.tools) ? agent.tools : [];
  const consumes = Array.isArray(agent.consumes) ? agent.consumes : [];
  const produces = Array.isArray(agent.produces) ? agent.produces : [];
  const cues = Array.isArray(agent.routing_cues) ? agent.routing_cues : [];
  const connectorRequirements = Array.isArray(agent.connector_requirements) ? agent.connector_requirements : [];
  const exclusions = agent.exclusions || {};
  const connectionTools = connectorRequirements.flatMap((requirement, requirementIndex) => (
    (Array.isArray(requirement?.tools) ? requirement.tools : []).map((tool, toolIndex) => ({
      key: `${requirementIndex}:${toolIndex}:${tool?.name || "tool"}`,
      label: `${requirement.connection_name || "Connection"} · ${tool?.title || tool?.name || "Tool"}`
    }))
  ));
  return (
    <>
      <div className="marketplace-detail-layout workspace-agent-detail-layout">
        <main className="marketplace-detail-content">
          <button type="button" className="workspace-agent-detail-back" onClick={onBack}><ArrowLeft size={14} />Back to workspace</button>
          <section className="builder-panel marketplace-detail-intro">
            <div className="builder-heading">
              <span>WORKSPACE AGENT</span>
              <h3>{description}</h3>
              <p>Part of <strong>{agentFacingText(workspaceTitle, "Shared workspace")}</strong> · Published by <strong>{publisher}</strong>.</p>
            </div>
          </section>

          <section className="builder-panel marketplace-detail-section" aria-labelledby="workspace-agent-purpose-heading">
            <div className="builder-heading"><span>AGENT BASICS</span><h3 id="workspace-agent-purpose-heading">Purpose and instructions</h3></div>
            <dl className="marketplace-spec-list">
              <div><dt>What it does</dt><dd>{description}</dd></div>
              <div><dt>Instructions and limits</dt><dd>{agentFacingText(agent.boundary, "No additional limits provided.")}</dd></div>
            </dl>
          </section>

          <section className="builder-panel marketplace-detail-section" aria-labelledby="workspace-agent-workflow-heading">
            <div className="builder-heading"><span>TOOLS &amp; TEAMWORK</span><h3 id="workspace-agent-workflow-heading">How it works</h3></div>
            <dl className="marketplace-spec-list compact">
              <div><dt>Tools</dt><dd>{tools.length ? tools.map((value) => <span className="marketplace-spec-chip" key={value}>{String(value).replaceAll("_", " ")}</span>) : "No tools required"}</dd></div>
              <div><dt>Connections</dt><dd>{connectionTools.length ? connectionTools.map((tool) => <span className="marketplace-spec-chip" key={tool.key}>{tool.label}</span>) : "No external connection required"}</dd></div>
              <div><dt>Receives</dt><dd>{consumes.length ? consumes.map((value) => <span className="marketplace-spec-chip" key={value}>{String(value).replaceAll("_", " ")}</span>) : "User request"}</dd></div>
              <div><dt>Produces</dt><dd>{produces.length ? produces.map((value) => <span className="marketplace-spec-chip" key={value}>{String(value).replaceAll("_", " ")}</span>) : "Domain output"}</dd></div>
              <div><dt>Router cues</dt><dd>{cues.length ? cues.join(", ") : "Uses its name and purpose"}</dd></div>
            </dl>
          </section>

          {(exclusions.private_knowledge || exclusions.agent_connections || exclusions.mcp_credentials_and_bindings) && (
            <div className="marketplace-sharing-boundary">
              <AlertCircle size={16} />
              <span><strong>Workspace-safe agent</strong><small>{[exclusions.private_knowledge ? "Private knowledge" : null, exclusions.agent_connections ? "private workspace connections" : null, exclusions.mcp_credentials_and_bindings ? "live MCP credentials and bindings" : null].filter(Boolean).join(", ")} are not included in the published workspace.</small></span>
            </div>
          )}
        </main>

        <aside className="builder-preview marketplace-detail-preview" aria-label="Published workspace agent summary">
          <div className="preview-badge"><Bot size={18} /><span>WORKSPACE AGENT</span></div>
          <h4>{title}</h4>
          <p>{description}</p>
          <dl>
            <div><dt>Workspace</dt><dd>{agentFacingText(workspaceTitle, "Shared workspace")}</dd></div>
            <div><dt>Publisher</dt><dd>{publisher}</dd></div>
            <div><dt>Tools</dt><dd>{tools.length || "None"}</dd></div>
            <div><dt>Connections</dt><dd>{connectorRequirements.length || "None"}</dd></div>
            <div><dt>Outputs</dt><dd>{produces.length || "Default"}</dd></div>
          </dl>
          <div className="preview-status"><Check size={14} /><div><strong>Included in this team</strong><small>Its sanitized contract is part of the workspace copy.</small></div></div>
        </aside>
      </div>

      <footer className="builder-actions marketplace-detail-actions">
        <button type="button" className="text-button ghost" onClick={onBack}><ArrowLeft size={15} />Back to workspace</button>
        <span>Published by {publisher}</span>
      </footer>
    </>
  );
}

export function MarketplaceAgentDialog({
  item,
  auth,
  agentWorkspaces = [],
  activeAgentWorkspaceId = "",
  onClose,
  onRate,
  onCopied,
  onEditDescription = () => undefined,
  onUnpublish = () => undefined
}) {
  const [detail, setDetail] = useState(item);
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(activeAgentWorkspaceId);
  const [selectedWorkspaceAgent, setSelectedWorkspaceAgent] = useState(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSelectedWorkspaceAgent(null);
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
      const result = await api.post(`/api/marketplace/items/${encodeURIComponent(item.id)}/copy`, {
        ...(detail.item_type === "agent" && targetWorkspaceId ? { agent_workspace_id: targetWorkspaceId } : {})
      });
      await onCopied(result);
    } catch (copyError) {
      setError(friendlyError(copyError));
    } finally {
      setCopying(false);
    }
  }

  const agent = detail.agent || {};
  const sharedWorkspace = detail.workspace || {};
  const workspaceListing = detail.item_type === "workspace";
  const publisher = detail.publisher_display_name || detail.publisher?.user_id || detail.published_by || "Virenis";
  const exclusions = agent.exclusions || {};
  const tools = agent.tools || [];
  const consumes = agent.consumes || [];
  const produces = agent.produces || [];
  const cues = agent.routing_cues || [];
  const connectorRequirements = agent.connector_requirements || [];
  const targetWorkspace = agentWorkspaces.find((workspace) => workspace.agent_workspace_id === targetWorkspaceId);
  const targetWorkspaceFull = Boolean(
    targetWorkspace
    && targetWorkspace.agent_count >= (targetWorkspace.max_agents || 16)
  );
  if (workspaceListing) {
    const workspaceAgents = sharedWorkspace.agents || [];
    const workspaceEdges = sharedWorkspace.edges || [];
    if (selectedWorkspaceAgent) {
      return (
        <ModalSurface
          title={agentFacingText(selectedWorkspaceAgent.agent?.title, "Workspace agent")}
          description={`Part of ${agentFacingText(detail.title, "Marketplace workspace")}`}
          onClose={onClose}
          className="agent-builder-dialog marketplace-agent-dialog"
        >
          <div className="marketplace-detail-body">
            {error && <div className="form-error" role="alert">{error}</div>}
            <MarketplaceWorkspaceAgentDetails
              entry={selectedWorkspaceAgent}
              workspaceTitle={detail.title}
              publisher={publisher}
              onBack={() => setSelectedWorkspaceAgent(null)}
            />
          </div>
        </ModalSurface>
      );
    }
    return (
      <ModalSurface
        title={agentFacingText(detail.title, "Marketplace workspace")}
        description={`Published by ${publisher}`}
        onClose={onClose}
        className="agent-builder-dialog marketplace-agent-dialog"
      >
        <div className="marketplace-detail-body workspace-marketplace-detail">
          {error && <div className="form-error" role="alert">{error}</div>}
          {loading && <div className="marketplace-detail-loading"><LoaderCircle className="spin" size={18} />Loading workspace details</div>}
          <section className="builder-panel marketplace-detail-intro">
            <div className="builder-heading"><span>SHARED AGENT WORKSPACE</span><h3>{detail.description || sharedWorkspace.description}</h3><p>{workspaceAgents.length} coordinated agent{workspaceAgents.length === 1 ? "" : "s"} · Published by <strong>{publisher}</strong>.</p></div>
          </section>
          <div className="workspace-marketplace-agents">
            {workspaceAgents.map((entry, index) => (
              <button
                type="button"
                className="workspace-marketplace-agent-card"
                key={entry.source_agent_id || index}
                onClick={() => setSelectedWorkspaceAgent(entry)}
                aria-label={`View details for ${agentFacingText(entry.agent?.title, "workspace agent")}`}
              >
                <span>{index + 1}</span>
                <div><strong>{entry.agent?.title || "Agent"}</strong><p>{entry.agent?.capability}</p><small>{(entry.agent?.produces || []).join(" · ") || "Domain output"}</small></div>
                <ChevronRight size={15} aria-hidden="true" />
              </button>
            ))}
          </div>
          {workspaceEdges.length > 0 && (
            <section className="workspace-marketplace-handoffs">
              <h4>Team handoffs</h4>
              {workspaceEdges.map((edge, index) => {
                const from = workspaceAgents.find((entry) => entry.source_agent_id === edge.from)?.agent?.title || edge.from;
                const to = workspaceAgents.find((entry) => entry.source_agent_id === edge.to)?.agent?.title || edge.to;
                return <span key={`${edge.from}:${edge.to}:${index}`}><b>{from}</b><ArrowRight size={14} /><b>{to}</b></span>;
              })}
            </section>
          )}
          <div className="marketplace-sharing-boundary"><AlertCircle size={16} /><span><strong>Independent, safe copy</strong><small>The team structure and sanitized agent instructions are copied. Private knowledge, credentials, and live connections are not.</small></span></div>
          <footer className="builder-actions marketplace-detail-actions">
            <button type="button" className="text-button ghost" onClick={onClose}>Close</button>
            <span><Star size={14} fill="currentColor" /> {detail.rating_count ? `${detail.rating_average.toFixed(1)} (${detail.rating_count})` : "New"}</span>
            <div>
              {detail.can_manage && <button type="button" className="text-button ghost" onClick={() => onEditDescription(detail)}><Pencil size={15} />Edit description</button>}
              {detail.can_manage && <button type="button" className="text-button danger" onClick={() => onUnpublish(detail)}><Globe2 size={15} />Unpublish</button>}
              {!detail.is_self_published && <button type="button" className="text-button ghost" onClick={() => onRate(detail)} disabled={auth?.is_viewer}><Star size={15} />{detail.my_rating ? "Update rating" : "Rate"}</button>}
              <button type="button" className="text-button primary" onClick={copyToWorkspace} disabled={auth?.is_viewer || loading || copying}>{copying ? <LoaderCircle className="spin" size={16} /> : <Copy size={16} />}{copying ? "Copying team" : "Copy workspace"}</button>
            </div>
          </footer>
        </div>
      </ModalSurface>
    );
  }
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
            {detail.workspace_copy && <div className="preview-status"><Check size={14} /><div><strong>Already on your team</strong><small>{detail.workspace_copy.title}</small></div></div>}
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
            {!detail.is_self_published && agentWorkspaces.length > 0 && (
              <label className="marketplace-copy-target"><span>Add to team</span><select value={targetWorkspaceId} onChange={(event) => setTargetWorkspaceId(event.target.value)}>{agentWorkspaces.map((workspace) => <option value={workspace.agent_workspace_id} key={workspace.agent_workspace_id}>{workspace.name} · {workspace.agent_count} specialist{workspace.agent_count === 1 ? "" : "s"}</option>)}</select></label>
            )}
            <button type="button" className="text-button primary" onClick={copyToWorkspace} disabled={auth?.is_viewer || loading || copying || targetWorkspaceFull}>{copying ? <LoaderCircle className="spin" size={16} /> : <Copy size={16} />}{targetWorkspaceFull ? "Team is full" : copying ? "Adding" : detail.workspace_copy ? "Add another copy" : "Add to my team"}</button>
          </div>
        </footer>
      </div>
    </ModalSurface>
  );
}

export function AgentWorkspaceDialog({ workspace, onClose, onSaved }) {
  const editing = Boolean(workspace);
  const [name, setName] = useState(workspace?.name || "");
  const [description, setDescription] = useState(workspace?.description || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = editing
        ? await api.patch(`/api/agent-workspaces/${encodeURIComponent(workspace.agent_workspace_id)}`, {
            ...(!workspace.is_general ? { name } : {}),
            description
          })
        : await api.post("/api/agent-workspaces", { name, description });
      await onSaved(saved);
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalSurface title={editing ? "Team details" : "Create a team"} description="A team groups the specialists who should work together in chat." onClose={onClose} className="form-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label><span>Team name</span><input data-autofocus value={name} onChange={(event) => setName(event.target.value)} disabled={workspace?.is_general} required maxLength={80} placeholder="Customer launch team" /></label>
        <label><span>Description</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1200} placeholder="Describe when this team should be active and what its agents accomplish together." /></label>
        <div className="dialog-actions"><button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="text-button primary" disabled={busy || !name.trim()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}{editing ? "Save details" : "Create team"}</button></div>
      </form>
    </ModalSurface>
  );
}

export function AgentWorkspaceMembersDialog({ workspace, agents, onClose, onSaved }) {
  const [selected, setSelected] = useState(() => new Set(workspace.agent_ids || []));
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = agents
    .filter((agent) => !agent.document && !agent.resource_for_agent_id)
    .filter((agent) => agent.enabled !== false || selected.has(agent.id))
    .filter((agent) => !query || `${agent.title || ""} ${agent.capability || ""}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => Number(selected.has(right.id)) - Number(selected.has(left.id))
      || String(left.title || left.id).localeCompare(String(right.title || right.id)));
  function toggle(agentId, checked) {
    setError("");
    setSelected((current) => {
      const next = new Set(current);
      if (checked) {
        if (next.size >= (workspace.max_agents || 16)) {
          setError(`This team can contain at most ${workspace.max_agents || 16} specialists.`);
          return current;
        }
        next.add(agentId);
      } else {
        next.delete(agentId);
      }
      return next;
    });
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.patch(`/api/agent-workspaces/${encodeURIComponent(workspace.agent_workspace_id)}`, {
        agent_ids: [...selected]
      });
      await onSaved();
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalSurface title={`Choose members for ${workspace.name}`} description={`Choose up to ${workspace.max_agents || 16} specialists. These are the roles the Router may assign when this team is active.`} onClose={onClose} className="form-dialog workspace-members-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="workspace-member-count"><strong>{selected.size} / {workspace.max_agents || 16}</strong><span>specialists selected</span></div>
        <label className="search-field full-width"><Search size={16} /><span className="sr-only">Search available specialists</span><input data-autofocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search available specialists" /></label>
        <div className="workspace-member-list">
          {candidates.map((agent) => (
            <label className={selected.has(agent.id) ? "selected" : ""} key={agent.id}>
              <input type="checkbox" checked={selected.has(agent.id)} onChange={(event) => toggle(agent.id, event.target.checked)} />
              <span><strong>{formatAgentName(agent.id, agents)}</strong><small>{agentFacingText(agent.capability, "Custom agent")}</small></span>
              <i>{agent.enabled === false ? "Archived" : agent.system_managed ? "Built-in" : "Your specialist"}</i>
            </label>
          ))}
          {!candidates.length && <p className="muted-empty">No specialists match this search.</p>}
        </div>
        <div className="dialog-actions"><button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="text-button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save team</button></div>
      </form>
    </ModalSurface>
  );
}

export function WorkflowWorkspaceDialog({ workspaces, activeWorkspaceId, onClose, onConfirm, onCreated }) {
  const [selection, setSelection] = useState(activeWorkspaceId || workspaces[0]?.agent_workspace_id || "");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (creating) {
        const created = await api.post("/api/agent-workspaces", {
          name,
          description: "Created for an agent workflow from chat."
        });
        await onCreated(created);
      } else {
        if (!selection) throw new Error("Choose a team first.");
        await onConfirm(selection);
      }
    } catch (submitError) {
      setError(friendlyError(submitError));
      setBusy(false);
    }
  }
  return (
    <ModalSurface title="Choose where this team should live" description="Your active team is selected by default. New or reused specialists will join it before the workflow is proposed." onClose={onClose} className="form-dialog workflow-workspace-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="workflow-workspace-options">
          {workspaces.map((workspace) => (
            <label className={!creating && selection === workspace.agent_workspace_id ? "selected" : ""} key={workspace.agent_workspace_id}>
              <input type="radio" name="workflow-workspace" checked={!creating && selection === workspace.agent_workspace_id} onChange={() => { setCreating(false); setSelection(workspace.agent_workspace_id); }} />
              <span><strong>{workspace.name}{workspace.agent_workspace_id === activeWorkspaceId ? " · Recommended" : ""}</strong><small>{workspace.agent_count} specialist{workspace.agent_count === 1 ? "" : "s"} · {workspace.description || "Your team"}</small></span>
            </label>
          ))}
          <label className={creating ? "selected" : ""}>
            <input type="radio" name="workflow-workspace" checked={creating} onChange={() => setCreating(true)} />
            <span><strong>Create a new team</strong><small>Keep this workflow separate from your current team.</small></span>
          </label>
        </div>
        {creating && <label><span>New team name</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} placeholder="Support automation" /></label>}
        <div className="dialog-actions"><button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="text-button primary" disabled={busy || (creating ? !name.trim() : !selection)}>{busy ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}Continue</button></div>
      </form>
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

export function WorldGraphChanges({ run, agents, canWrite, onRefreshTracked, onRunFresh }) {
  const graph = run?.world_graph || {};
  const [currentCheck, setCurrentCheck] = useState(null);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const decisions = Array.isArray(graph.decisions) ? graph.decisions : [];
  const refreshed = decisions.filter((item) => item.action === "refreshed");
  const kept = decisions.filter((item) => item.action === "kept");
  const hasCompletedChangeRecord = run?.status === "completed"
    && ["unchecked", "current"].includes(graph.validity)
    && Number(graph.total || 0) > 0
    && decisions.length > 0;
  const planById = new Map((run?.plan?.steps || []).map((step) => [step.id, step]));

  useEffect(() => {
    setCurrentCheck(null);
    setCheckBusy(false);
    setCheckError("");
    setActionBusy("");
    setActionError("");
  }, [run?.run_id]);

  useEffect(() => {
    if (!currentCheck?.checked_at) return undefined;
    const checkedAt = Date.parse(currentCheck.checked_at);
    if (!Number.isFinite(checkedAt)) return undefined;
    const timer = window.setTimeout(() => {
      setCurrentCheck(null);
      setCheckError("The previous change check expired. Check again before refreshing work.");
    }, Math.max(0, checkedAt + 60_000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [currentCheck?.checked_at]);

  async function checkWhatChanged() {
    if (!run?.run_id || checkBusy) return;
    setCheckBusy(true);
    setCurrentCheck(null);
    setCheckError("");
    setActionError("");
    try {
      const result = await api.post(`/api/chat/runs/${encodeURIComponent(run.run_id)}/worldgraph/check`, {});
      setCurrentCheck(result);
    } catch (checkFailure) {
      setCheckError(friendlyError(checkFailure));
    } finally {
      setCheckBusy(false);
    }
  }

  async function startRefresh(runFresh) {
    if (actionBusy || checkBusy) return;
    const callback = runFresh ? onRunFresh : onRefreshTracked;
    if (typeof callback !== "function") return;
    setActionBusy(runFresh ? "fresh" : "selective");
    setActionError("");
    try {
      const started = await callback(run);
      if (started === false) {
        setActionError("The refresh could not be started. Your change check was preserved; please try again.");
      }
    } catch (refreshFailure) {
      setActionError(friendlyError(refreshFailure));
    } finally {
      setActionBusy("");
    }
  }
  const row = (decision) => {
    const step = planById.get(decision.step_id);
    const isKept = decision.action === "kept";
    return (
      <li className={isKept ? "kept" : "refreshed"} key={decision.step_id || decision.adapter}>
        <span className="world-change-icon" aria-hidden="true">{isKept ? <Check size={15} /> : <RefreshCw size={15} />}</span>
        <span>
          <strong>{formatAgentName(decision.adapter, agents)}</strong>
          <small>{isKept ? "Work item kept from earlier" : "Work item refreshed now"}</small>
          <p>{decision.plain_reason || (isKept ? "Its validated inputs are unchanged." : "This agent checked its part of the answer now.")}</p>
          {step?.task && <em>Work item: {agentFacingText(step.task)}</em>}
          {step?.depends_on?.length > 0 && (
            <em>Uses {step.depends_on.map((id) => formatAgentName(planById.get(id)?.adapter || id, agents)).join(", ")}</em>
          )}
        </span>
      </li>
    );
  };
  if (!hasCompletedChangeRecord) {
    const unavailableCopy = run?.status === "failed"
      ? "This run did not finish, so no current change record can be proven."
      : run && !["completed", "failed"].includes(run.status)
        ? "Change tracking will appear after this answer finishes."
        : "This answer does not include a verified change record.";
    return (
      <section className="detail-section world-changes" aria-labelledby="world-changes-heading">
        <div className="world-unavailable-card">
          <span><AlertCircle size={18} aria-hidden="true" /></span>
          <div>
            <strong id="world-changes-heading">Change tracking is unavailable</strong>
            <p>{unavailableCopy}</p>
          </div>
        </div>
        {canWrite && run?.status === "completed" && (
          <>
            <div className="world-run-disclosure">
              <AlertCircle size={15} aria-hidden="true" />
              <span>A fresh run still uses Router planning and final answer synthesis. Billing may reserve the full-run maximum first, then settle only the provider work actually used.</span>
            </div>
            <button type="button" className="text-button secondary world-run-fresh" onClick={() => startRefresh(true)} disabled={Boolean(actionBusy)}>
              {actionBusy === "fresh" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
              {actionBusy === "fresh" ? "Starting fresh run" : "Run all work fresh"}
            </button>
            {actionError && <p className="form-error world-action-error" role="alert">{actionError}</p>}
          </>
        )}
      </section>
    );
  }
  return (
    <section className="detail-section world-changes" aria-labelledby="world-changes-heading">
      <div className="world-current-card" role="status" aria-live="polite">
        <span><Check size={18} aria-hidden="true" /></span>
        <div>
          <strong id="world-changes-heading">Change record ready</strong>
          <p>When this answer ran, {kept.length} validated {kept.length === 1 ? "work item was" : "work items were"} kept and {refreshed.length} {refreshed.length === 1 ? "work item was" : "work items were"} refreshed.</p>
        </div>
      </div>
      <div
        className="world-change-map"
        role="img"
        aria-label={`Router checked inputs and evidence. ${kept.length} work items were kept from earlier and ${refreshed.length} were refreshed now. The answer was combined.`}
      >
        <Network size={17} aria-hidden="true" />
        <span>Router checked inputs and evidence</span>
        <ChevronRight size={14} aria-hidden="true" />
        <span>{kept.length} work items kept · {refreshed.length} refreshed</span>
        <ChevronRight size={14} aria-hidden="true" />
        <span>Answer combined</span>
      </div>
      <div className="world-check-panel">
        <div>
          <strong>Has anything changed since then?</strong>
          <p>Check agent instructions, source revisions, conversation inputs, and live-tool rules without calling a model.</p>
        </div>
        <button type="button" className="text-button secondary" onClick={checkWhatChanged} disabled={checkBusy || Boolean(actionBusy)} aria-busy={checkBusy}>
          {checkBusy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
          {checkBusy ? "Checking" : currentCheck ? "Check again" : "Check what changed"}
        </button>
      </div>
      {checkError && <p className="form-error world-check-error" role="alert">{checkError}</p>}
      {currentCheck?.availability === "ready" && (
        <div className={`world-check-result ${currentCheck.validity === "current" ? "current" : "needs-refresh"}`} role="status" aria-live="polite">
          <span aria-hidden="true">{currentCheck.validity === "current" ? <Check size={17} /> : <RefreshCw size={17} />}</span>
          <div>
            <strong>{currentCheck.validity === "current"
              ? "Nothing needs to rerun"
              : `${currentCheck.wake_count} ${currentCheck.wake_count === 1 ? "work item may need" : "work items may need"} to run again`}</strong>
            <p>{currentCheck.validity === "current"
              ? `${currentCheck.keep_count} validated ${currentCheck.keep_count === 1 ? "result is" : "results are"} still usable.`
              : `${currentCheck.keep_count} ${currentCheck.keep_count === 1 ? "work item can stay" : "work items can stay"} asleep. This preview used no model calls.`}</p>
            {currentCheck.validity !== "current" && (
              <ul>
                {(currentCheck.decisions || []).filter((item) => item.projected_action === "wake").map((item) => (
                  <li key={item.step_id || item.adapter}>
                    <b>{formatAgentName(item.adapter, agents)}</b><span>{item.plain_reason}</span>
                  </li>
                ))}
              </ul>
            )}
            {currentCheck.conservative && <small>The live run may keep more work if a refreshed result is unchanged.</small>}
            {currentCheck.checked_at && (
              <time className="world-checked-at" dateTime={currentCheck.checked_at}>Checked {formatDate(currentCheck.checked_at, { includeTime: true })}. Recheck after any later change.</time>
            )}
          </div>
        </div>
      )}
      {refreshed.length > 0 && (
        <div className="world-change-group">
          <h4>Refreshed now</h4>
          <ul>{refreshed.map(row)}</ul>
        </div>
      )}
      {kept.length > 0 && (
        <div className="world-change-group">
          <h4>Kept from earlier</h4>
          <ul>{kept.map(row)}</ul>
        </div>
      )}
      {!decisions.length && <p className="muted-empty">Change tracking is not available for this answer.</p>}
      <div className="world-safety-note">
        <AlertCircle size={15} aria-hidden="true" />
        <span>Live information, tool actions, and approval-based actions are always checked again. Nothing external is repeated automatically.</span>
      </div>
      {canWrite && run?.status === "completed" && (
        <>
          <div className="world-run-disclosure">
            <AlertCircle size={15} aria-hidden="true" />
            <span>A refresh still runs Router planning and final answer synthesis. Billing may reserve the full-run maximum first, then settle only the provider work actually used.</span>
          </div>
          <div className="world-run-actions">
            {currentCheck?.validity === "needs_refresh" && (
              <button type="button" className="text-button primary" onClick={() => startRefresh(false)} disabled={Boolean(actionBusy) || checkBusy}>
                {actionBusy === "selective" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                {actionBusy === "selective" ? "Starting refresh" : "Refresh affected work"}
              </button>
            )}
            <button type="button" className="text-button secondary world-run-fresh" onClick={() => startRefresh(true)} disabled={Boolean(actionBusy) || checkBusy}>
              {actionBusy === "fresh" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
              {actionBusy === "fresh" ? "Starting fresh run" : "Run all agents anyway"}
            </button>
          </div>
          {actionError && <p className="form-error world-action-error" role="alert">{actionError}</p>}
        </>
      )}
    </section>
  );
}

export function RunDetailsSheet({
  run,
  agents,
  contractsById,
  canWrite,
  onClose,
  onCreateOutcome,
  onSettleOutcome,
  onDisputeOutcome,
  onCorrectOutcome,
  onRefreshTracked,
  onRunFresh
}) {
  const hasCurrentWorldGraph = run?.status === "completed"
    && ["unchecked", "current"].includes(run?.world_graph?.validity)
    && Number(run?.world_graph?.total || 0) > 0
    && (run?.world_graph?.decisions || []).length > 0;
  const [view, setView] = useState(hasCurrentWorldGraph ? "changes" : "agents");
  const userSelectedViewRef = useRef(false);
  const viewedRunIdRef = useRef(run?.run_id || null);
  const routeSelections = new Map((run?.plan?.routing?.selected || []).map((item) => [item.adapter, item]));
  const contracts = run?.outcome_contracts || [];
  const hasOutcome = contracts.length > 0;

  useEffect(() => {
    if (!run?.run_id) return;
    if (viewedRunIdRef.current !== run.run_id) {
      viewedRunIdRef.current = run.run_id;
      userSelectedViewRef.current = false;
    }
    if (!userSelectedViewRef.current) setView(hasCurrentWorldGraph ? "changes" : "agents");
  }, [hasCurrentWorldGraph, run?.run_id]);

  function selectView(nextView) {
    userSelectedViewRef.current = true;
    setView(nextView);
  }

  return (
    <ModalSurface title="Answer details" description={run ? runStatusLabel(run.status) : "Loading details"} side="right" onClose={onClose}>
      <div className="sheet-body details-sheet-body">
        {!run && <div className="center-state"><LoaderCircle className="spin" size={19} />Loading details</div>}
        {run && (
          <>
            <div className="view-switch five-up" aria-label="Answer detail view">
              <button type="button" aria-pressed={view === "changes"} onClick={() => selectView("changes")}>Changes</button>
              <button type="button" aria-pressed={view === "agents"} onClick={() => selectView("agents")}>Agents</button>
              <button type="button" aria-pressed={view === "sources"} onClick={() => selectView("sources")}>Sources</button>
              <button type="button" aria-pressed={view === "outcomes"} onClick={() => selectView("outcomes")}>Results</button>
              <button type="button" aria-pressed={view === "activity"} onClick={() => selectView("activity")}>Activity</button>
            </div>

            {view === "changes" && (
              <WorldGraphChanges
                run={run}
                agents={agents}
                canWrite={canWrite}
                onRefreshTracked={onRefreshTracked}
                onRunFresh={onRunFresh}
              />
            )}

            {view === "agents" && (
              <section className="detail-section" aria-labelledby="used-agents-heading">
                <div className="section-heading compact-heading">
                  <div><h3 id="used-agents-heading">Agents and model usage</h3><p>{run.expert_outputs?.length || 0} contributors. Expand any agent to read its complete result.</p></div>
                </div>
                <UsageReceipt
                  receipt={run.usage_receipt}
                  agents={agents}
                  expertOutputs={run.expert_outputs || []}
                  includeFinalOutput
                />
                <div className="detail-list">
                  {(run.expert_outputs || []).map((route) => {
                    const selection = routeSelections.get(route.adapter);
                    const tieBreak = realityRankTieBreak(run?.plan?.routing, route.adapter);
                    const resolvedInputs = route.consumption_validation?.resolved_contract_inputs || [];
                    const producedOutputs = route.artifact_validation?.produced
                      || (route.handoff_artifacts || []).map((artifact) => artifact.name || artifact.artifact).filter(Boolean);
                    return (
                      <details className="detail-row" key={route.step_id || route.adapter}>
                        <summary>
                          <span className="status-dot ready" aria-hidden="true" />
                          <span>
                            <strong>{formatAgentName(route.adapter, agents)}</strong>
                            <small>{route.execution_mode === "reused" ? "Kept from earlier" : selection?.reason || route.task || "Completed its part of the answer"}</small>
                          </span>
                          {tieBreak
                            ? <em>Past results</em>
                            : selection?.confidence != null && <em>{Math.round(selection.confidence * 100)}%</em>}
                        </summary>
                        <div className="detail-row-content">
                          {tieBreak && <RankTieBreakNote tieBreak={tieBreak} adapter={route.adapter} agents={agents} />}
                          {route.task && <p><strong>Task</strong>{route.task}</p>}
                          {route.domain_answer && (
                            <div className="agent-full-output">
                              <strong>Agent result</strong>
                              <FormattedText text={route.domain_answer} />
                            </div>
                          )}
                          {resolvedInputs.length > 0 && (
                            <p><strong>Context received</strong>{resolvedInputs.map((value) => contractFieldLabel(value, agents)).join(", ")}</p>
                          )}
                          {producedOutputs.length > 0 && (
                            <p><strong>Outputs produced</strong>{producedOutputs.map((value) => contractFieldLabel(value, agents)).join(", ")}</p>
                          )}
                          {route.tool_executions?.length > 0 ? (
                            <p><strong>Tools used</strong>{route.tool_executions.map((execution) => workflowToolLabel(execution.name)).join(", ")}</p>
                          ) : route.allowed_tools?.length > 0 && (
                            <p><strong>Tools available</strong>{route.allowed_tools.map(workflowToolLabel).join(", ")}</p>
                          )}
                          {route.token_usage && (
                            <p>
                              <strong>Token usage</strong>
                              {route.token_usage.reported
                                ? `${formatTokenCount(route.token_usage.total_tokens)} total (${formatTokenCount(route.token_usage.prompt_tokens)} input · ${formatTokenCount(route.token_usage.completion_tokens)} output) · ${formatCreditDisplay(route.token_usage.charged_credits)}`
                                : "Provider token usage was not reported for this contribution."}
                            </p>
                          )}
                          {route.consumption_validation?.valid === false && (
                            <p><strong>Missing context</strong>{(route.consumption_validation.missing_from_upstream || []).map((value) => contractFieldLabel(value, agents)).join(", ") || "A required verified handoff was unavailable."}</p>
                          )}
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
                {run.usage_receipt && (
                  <details className="provenance-details">
                    <summary>Model usage</summary>
                    <dl>
                      <div><dt>Calls</dt><dd>{run.usage_receipt.call_count}</dd></div>
                      <div><dt>Input tokens</dt><dd>{formatTokenCount(run.usage_receipt.prompt_tokens)}</dd></div>
                      <div><dt>Output tokens</dt><dd>{formatTokenCount(run.usage_receipt.completion_tokens)}</dd></div>
                      <div><dt>Total tokens</dt><dd>{formatTokenCount(run.usage_receipt.total_tokens)}</dd></div>
                      <div><dt>Credits charged</dt><dd>{formatCreditDisplay(run.usage_receipt.charged_credits)}</dd></div>
                      <div><dt>Balance after</dt><dd>{formatCreditDisplay(run.usage_receipt.balance_after_credits)}</dd></div>
                      <div><dt>Accounting</dt><dd>{run.usage_receipt.complete ? "Complete" : run.usage_receipt.provider_reported ? "Partial" : "Not reported"}</dd></div>
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

function contractFieldLabel(value, agents = []) {
  const text = String(value || "");
  const agentMatch = text.match(/^agent:([a-z0-9_-]+):output$/i);
  if (agentMatch) return `${formatAgentName(agentMatch[1], agents)} output`;
  const labels = {
    domain_outputs: "All verified agent outputs",
    upstream_route_outputs: "Other agents’ verified work",
    document_context: "Attached document context",
    table_context: "Structured data",
    shared_memory: "Conversation context",
    user_request: "User request"
  };
  return labels[text] || text.replaceAll("_", " ");
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
  { id: "web", title: "Current web information", detail: "Checks public sources again when information may have changed", icon: Globe2, values: ["web_search"] },
  { id: "calculate", title: "Calculations", detail: "Check arithmetic and formulas", icon: Calculator, values: ["calculator"] },
  { id: "tables", title: "Data tables", detail: "Read and analyze tabular data", icon: Table2, values: ["data_table"] },
  { id: "documents", title: "Documents", detail: "Search attached files", icon: FileSearch, values: ["document_search", "document_read"] },
  { id: "code", title: "Code & repositories", detail: "Inspect approved project files", icon: Code2, values: ["repo_inspector"] },
  { id: "data", title: "Workspace data", detail: "Run approved read-only queries", icon: Database, values: ["sql_runner"] }
];

const CONTEXT_OPTIONS = [
  { value: "upstream_route_outputs", title: "Work passed from teammates", detail: "Use completed work from earlier steps", icon: Network },
  { value: "shared_memory", title: "Remember this conversation", detail: "Use relevant context from the current chat", icon: Layers3 },
  { value: "table_context", title: "Tables and records", detail: "Receive structured information", icon: Table2 }
];

const OUTPUT_OPTIONS = [
  { value: "domain_outputs", title: "Working answer" },
  { value: "evidence_summary", title: "Research notes" },
  { value: "recommendations", title: "Recommendations" },
  { value: "structured_data", title: "Structured data" },
  { value: "agent_handoff", title: "Work for another teammate" },
  { value: "final_answer", title: "Final response" }
];

function resourceToken(agentId) {
  return `agent:${agentId}`;
}

function collaboratorToken(agentId) {
  return `agent:${agentId}:output`;
}

export function agentPayloadFromForm(form, { isAdmin = false, hasDocumentResources = false } = {}) {
  const responseStyle = RESPONSE_STYLES.find((style) => style.id === form.response_style);
  return {
    item_type: form.item_type,
    title: form.title.trim(),
    capability: form.capability.trim(),
    boundary: form.boundary.trim() || responseStyle?.boundary || RESPONSE_STYLES[0].boundary,
    routing_cues: form.routing_cues || `${form.title}, ${form.capability}`,
    consumes: [...new Set([
      "user_request",
      ...(form.consumes || []),
      ...(hasDocumentResources ? ["document_context"] : [])
    ])],
    produces: form.produces?.length ? [...form.produces] : ["domain_outputs"],
    tools: [...new Set([
      ...(form.tools || []),
      ...(hasDocumentResources ? ["document_search", "document_read"] : [])
    ])],
    mcp_bindings: form.mcp_bindings || [],
    resources: form.resources || [],
    source_text: form.source_text || "",
    ...(isAdmin ? { sources: form.sources } : {})
  };
}

function createAgentForm(agent) {
  if (agent) {
    const matchingStyle = RESPONSE_STYLES.find((style) => style.boundary === String(agent.boundary || "").trim());
    return {
      id: agent.id,
      title: agentFacingText(agent.title),
      capability: agentFacingText(agent.capability),
      boundary: matchingStyle ? "" : agent.boundary || "",
      response_style: matchingStyle?.id || "custom",
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
    boundary: "",
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

function AgentDialog({ auth, runtime, agent, agents, documents, mcpConnections = [], agentWorkspaceId = null, teamName = "General team", onClose, onSaved }) {
  const editing = Boolean(agent);
  const [form, setForm] = useState(() => createAgentForm(agent));
  const [step, setStep] = useState(0);
  const [newFiles, setNewFiles] = useState([]);
  const [uploadedFileKeys, setUploadedFileKeys] = useState([]);
  const [createdAgentId, setCreatedAgentId] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  const [error, setError] = useState("");
  const initialFormSignature = useRef("");
  if (!initialFormSignature.current) initialFormSignature.current = JSON.stringify(form);
  const fileInputId = useId();
  const knowledgeDocuments = (documents || []).filter((document) => document.scope !== "chat" && document.enabled !== false);
  const collaboratorAgents = (agents || [])
    .filter((candidate) => candidate.id !== agent?.id && candidate.enabled !== false && !candidate.document && !candidate.resource_for_agent_id)
    .slice(0, 24);
  const selectedDocumentCount = knowledgeDocuments.filter((document) => form.resources.includes(resourceToken(document.agent_id))).length;
  const dirty = JSON.stringify(form) !== initialFormSignature.current || newFiles.length > 0 || Boolean(createdAgentId);

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
    setForm((current) => ({ ...current, response_style: style.id }));
  }

  function requestClose() {
    if (busy) return;
    if (dirty && typeof window !== "undefined" && !window.confirm("Leave setup? Your unsaved changes will be lost.")) return;
    onClose();
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
    const payload = agentPayloadFromForm(form, {
      isAdmin: Boolean(auth?.is_admin),
      hasDocumentResources
    });
    let newAgentPersisted = Boolean(createdAgentId);
    try {
      if (editing || createdAgentId) {
        if (!payload.source_text) delete payload.source_text;
        await api.patch(`/api/agents/${encodeURIComponent(activeAgentId)}`, payload);
      } else {
        await api.post("/api/agents", {
          id: form.id,
          ...payload,
          ...(agentWorkspaceId ? { agent_workspace_id: agentWorkspaceId } : {})
        });
        setCreatedAgentId(form.id);
        newAgentPersisted = true;
      }

      let resources = [...payload.resources];
      const completed = new Set(uploadedFileKeys);
      for (const [fileIndex, file] of newFiles.entries()) {
        const fileKey = `${file.name}:${file.size}:${file.lastModified}`;
        if (completed.has(fileKey)) continue;
        setUploadProgress(`Adding file ${fileIndex + 1} of ${newFiles.length}`);
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
      await onSaved({ id: activeAgentId, title: form.title.trim(), editing });
    } catch (saveError) {
      const prefix = !editing && newAgentPersisted
        ? "The specialist joined your team, but its knowledge setup is not finished. You can retry without creating a duplicate. "
        : "";
      setError(`${prefix}${friendlyError(saveError)}`);
    } finally {
      setUploadProgress("");
      setBusy(false);
    }
  }

  const steps = [
    { label: "Role", detail: "Name and purpose" },
    { label: "Abilities", detail: "Tools and teammates" },
    { label: "Knowledge", detail: "Sources and review" }
  ];
  const canContinue = step === 0 ? form.title.trim() && form.capability.trim() : step === 1 ? form.produces.length > 0 : true;

  return (
    <ModalSurface
      title={editing ? "Edit specialist" : "Add a specialist to your team"}
      description={editing ? `Update this role in ${teamName}. Changes apply to future work.` : `Choose the job and abilities. Virenis handles the technical setup for ${teamName}.`}
      onClose={requestClose}
      closeDisabled={busy}
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
                  <p>Give this teammate one clear responsibility. You can refine the role whenever the team evolves.</p>
                </div>
                <div className="builder-field">
                  <label htmlFor="agent-name">Role name</label>
                  <input id="agent-name" data-autofocus value={form.title} onChange={(event) => update("title", event.target.value)} required maxLength={160} placeholder="Launch risk analyst" />
                  <small>Use a name people will recognize when they call it with @.</small>
                </div>
                <div className="builder-field">
                  <label htmlFor="agent-purpose">What is this specialist responsible for?</label>
                  <textarea id="agent-purpose" value={form.capability} onChange={(event) => update("capability", event.target.value)} required maxLength={2400} placeholder="Review launch plans, find operational and market risks, and turn them into practical recommendations..." />
                  <small>Describe the expertise, the decisions it supports, and what useful work looks like.</small>
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
                  <summary><Settings2 size={15} /> Add specific guardrails <span>Optional</span></summary>
                  <div className="builder-field"><label htmlFor="agent-boundary">Extra instructions and limits</label><textarea id="agent-boundary" value={form.boundary} onChange={(event) => update("boundary", event.target.value)} placeholder="Add only rules that are unique to this role. Your response preference remains separate." /></div>
                </details>
              </section>
            )}

            {step === 1 && (
              <section className="builder-panel" aria-labelledby="agent-tools-heading">
                <div className="builder-heading">
                  <span>STEP 2 OF 3</span>
                  <h3 id="agent-tools-heading">Equip the role—without overcomplicating it.</h3>
                  <p>Select only what this specialist needs. Safe teamwork defaults are already in place.</p>
                </div>
                <fieldset className="choice-fieldset">
                  <legend>Abilities <small>optional</small></legend>
                  <p>Only selected abilities can be used by this specialist.</p>
                  <div className="tool-choice-grid">
                    {TOOL_OPTIONS.map((option) => {
                      const Icon = option.icon;
                      const selected = option.values.every((value) => form.tools.includes(value));
                      const readiness = option.values.map((value) => runtime?.tool_readiness?.[value]).filter(Boolean);
                      const unavailable = readiness.find((item) => item.available === false);
                      const setupRequired = readiness.find((item) => item.setup_required);
                      const detail = unavailable?.message || setupRequired?.message || option.detail;
                      return (
                        <label className={[selected ? "selected" : "", unavailable ? "setup-needed" : ""].filter(Boolean).join(" ")} key={option.id}>
                          <input type="checkbox" checked={selected} onChange={() => toggleTool(option)} />
                          <Icon size={18} />
                          <span><strong>{option.title}</strong><small>{detail}</small></span>
                          <i>{selected && <Check size={13} />}</i>
                        </label>
                      );
                    })}
                  </div>
                  {form.tools.includes("web_search") && <div className="live-tool-note"><Globe2 size={15} /><span><strong>Keeps current work current</strong><small>Public web information can change, so this specialist will check that part again on repeated requests.</small></span></div>}
                </fieldset>
                <details className="builder-details connected-app-details" open={(form.mcp_bindings || []).length > 0 || undefined}>
                  <summary><Plug size={15} /> Connected apps <span>{(form.mcp_bindings || []).reduce((total, binding) => total + binding.tool_names.length, 0) || "Optional"}</span></summary>
                <fieldset className="choice-fieldset mcp-tool-fieldset">
                  <legend className="sr-only">Connected apps</legend>
                  <p>Choose the exact app actions this specialist may request. Actions that change data still pause for your approval.</p>
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
                  ) : <div className="inline-empty-connection"><Plug size={17} /><span><strong>No apps connected yet</strong><small>Connect an account from Team studio → Apps, then return here.</small></span></div>}
                </fieldset>
                </details>
                <details className="builder-details advanced-handoff-details">
                  <summary><Network size={15} /> Teamwork and handoff settings <span>Safe defaults applied</span></summary>
                  <div className="advanced-handoff-content">
                <fieldset className="choice-fieldset">
                  <legend>What can teammates pass to this specialist?</legend>
                  <p>Your request is always included.</p>
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
                    <summary><Network size={15} /> Choose specific teammates <span>{form.consumes.filter((value) => /^agent:.+:output$/.test(value)).length || "Optional"}</span></summary>
                    <p>Select teammates whose completed work can be passed to this specialist.</p>
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
                  <legend>What should this specialist hand back?</legend>
                  <p>Choose the kinds of work teammates and the final answer may use.</p>
                  <div className="output-chips">
                    {OUTPUT_OPTIONS.map((option) => {
                      const selected = form.produces.includes(option.value);
                      return <label className={selected ? "selected" : ""} key={option.value}><input type="checkbox" checked={selected} onChange={(event) => toggleValue("produces", option.value, event.target.checked)} />{selected && <Check size={12} />}{option.title}</label>;
                    })}
                  </div>
                </fieldset>
                  </div>
                </details>
              </section>
            )}

            {step === 2 && (
              <section className="builder-panel" aria-labelledby="agent-knowledge-heading">
                <div className="builder-heading">
                  <span>STEP 3 OF 3</span>
                  <h3 id="agent-knowledge-heading">Add knowledge it can rely on.</h3>
                  <p>Attach private reference material for this role. It stays knowledge—not another teammate you need to manage.</p>
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
                            <BookOpen size={16} /><span><strong>{document.title}</strong><small>Ready for this specialist</small></span><i>{selected && <Check size={12} />}</i>
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
                <div className="mobile-builder-review" aria-label="Specialist review">
                  <span><Check size={15} /></span>
                  <div><strong>{form.title || "Your specialist"} will join {teamName}</strong><small>{form.capability || "Add a clear role description before saving."}</small></div>
                </div>
              </section>
            )}
          </div>

          <aside className="builder-preview" aria-label="Specialist summary">
            <div className="preview-badge"><Bot size={18} /><span>YOUR TEAMMATE</span></div>
            <h4>{form.title || "Untitled specialist"}</h4>
            <p>{form.capability || "Describe the role to see how this specialist will contribute."}</p>
            <dl>
              <div><dt>Response</dt><dd>{RESPONSE_STYLES.find((style) => style.id === form.response_style)?.title || "Custom instructions"}</dd></div>
              <div><dt>Abilities</dt><dd>{form.tools.length ? form.tools.map(workflowToolLabel).join(", ") : (form.mcp_bindings || []).some((binding) => binding.tool_names.length) ? "Connected app actions" : "Uses team context only"}</dd></div>
              <div><dt>Handoffs</dt><dd>{form.consumes.filter((value) => /^agent:.+:output$/.test(value)).length ? `${form.consumes.filter((value) => /^agent:.+:output$/.test(value)).length} teammate${form.consumes.filter((value) => /^agent:.+:output$/.test(value)).length === 1 ? "" : "s"} selected` : "Router assigns when useful"}</dd></div>
              <div><dt>Knowledge</dt><dd>{selectedDocumentCount + newFiles.length + (form.source_text.trim() ? 1 : 0) ? `${selectedDocumentCount + newFiles.length + (form.source_text.trim() ? 1 : 0)} private source${selectedDocumentCount + newFiles.length + (form.source_text.trim() ? 1 : 0) === 1 ? "" : "s"}` : "No private sources"}</dd></div>
            </dl>
            <div className="preview-status"><span /><div><strong>{teamName}</strong><small>{editing ? "Updates future assignments" : "Joins your team after review"}</small></div></div>
          </aside>
        </div>

        <footer className="builder-actions">
          <button type="button" className="text-button ghost" onClick={step === 0 ? requestClose : () => setStep((current) => current - 1)} disabled={busy}>
            {step === 0 ? "Cancel" : <><ArrowLeft size={15} /> Back</>}
          </button>
          <span>Step {step + 1} of 3</span>
          <button type="submit" className="text-button primary" disabled={busy || !canContinue}>
            {busy ? <LoaderCircle className="spin" size={16} /> : step < 2 ? <ArrowRight size={16} /> : editing ? <Check size={16} /> : <Plus size={16} />}
            {busy ? uploadProgress || "Saving" : step < 2 ? "Continue" : editing ? "Save changes" : "Add to team"}
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
