import {
  AlertCircle,
  Archive,
  ArrowUp,
  AtSign,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  FilePlus2,
  Flag,
  LoaderCircle,
  Menu,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  Settings2,
  SquarePen,
  Trash2,
  Upload,
  UserPlus,
  X
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
    throw error;
  }
  return payload;
}

function friendlyError(error) {
  return String(error?.message || error || "Something went wrong.")
    .replace(/TCAR/gi, "the service")
    .replace(/vLLM/gi, "the model service")
    .replace(/LoRA/gi, "agent");
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

function formatAgentName(agentId, agents) {
  const agent = agents.find((item) => item.id === agentId);
  if (agent?.title && agent.title.length <= 58) return agent.title;
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
  return String(auth?.user_id || "User")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "U";
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
  const [agentEditor, setAgentEditor] = useState(undefined);
  const [adoptionTarget, setAdoptionTarget] = useState(null);
  const [archiveTarget, setArchiveTarget] = useState(null);
  const [deleteDocumentTarget, setDeleteDocumentTarget] = useState(null);
  const [feedbackRunId, setFeedbackRunId] = useState(null);
  const [outcomeEditorRun, setOutcomeEditorRun] = useState(null);
  const [settlementContract, setSettlementContract] = useState(null);
  const [disputeContract, setDisputeContract] = useState(null);
  const [correctionContract, setCorrectionContract] = useState(null);
  const [mountingAgentId, setMountingAgentId] = useState("");
  const [focusComposer, setFocusComposer] = useState(0);
  const threadRef = useRef(null);
  const nearBottomRef = useRef(true);
  const eventSourceRef = useRef(null);

  const canWrite = Boolean(auth && !auth.is_viewer);
  const detailsRun = detailsRunId ? runsById[detailsRunId] : null;

  useEffect(() => {
    bootstrap();
    return () => eventSourceRef.current?.close();
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
      setAgents(agentList.agents || []);
      setDocuments(docList.documents || []);
      setMetrics(metricData);
      let nextSession = sessionList.sessions?.[0] || null;
      if (!nextSession && !me.is_viewer) {
        nextSession = await api.post("/api/chat/sessions", { title: "New chat", visibility: "private" });
      }
      setSessions(sessionList.sessions?.length ? sessionList.sessions : nextSession ? [nextSession] : []);
      if (nextSession) await openSession(nextSession.session_id);
    } catch (bootstrapError) {
      setError(friendlyError(bootstrapError));
    } finally {
      setLoading(false);
    }
  }

  async function refreshResources() {
    const [me, sessionList, agentList, docList, health] = await Promise.all([
      api.get("/api/auth/me"),
      api.get("/api/chat/sessions"),
      api.get("/api/agents"),
      api.get("/api/documents"),
      api.get("/api/runtime/health")
    ]);
    const metricData = me.is_admin ? await api.get("/api/admin/metrics") : emptyMetrics();
    setAuth(me);
    setSessions(sessionList.sessions || []);
    setAgents(agentList.agents || []);
    setDocuments(docList.documents || []);
    setRuntime(health);
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
    const payload = await api.get(`/api/chat/sessions/${encodeURIComponent(sessionId)}`);
    setSession(payload);
    setMessages(payload.messages || []);
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

  async function archiveAgent(agent) {
    setError("");
    await api.delete(`/api/agents/${encodeURIComponent(agent.id)}`);
    setArchiveTarget(null);
    await refreshResources();
    setResourcesOpen(true);
    setResourceView("agents");
  }

  async function deleteDocument(document) {
    setError("");
    await api.delete(`/api/documents/${encodeURIComponent(document.document_id)}`);
    setDeleteDocumentTarget(null);
    await refreshResources();
    setResourcesOpen(true);
    setResourceView("knowledge");
  }

  async function mountAgent(agent) {
    setMountingAgentId(agent.id);
    setError("");
    try {
      await api.post(`/api/agents/${encodeURIComponent(agent.id)}/mount`, {});
      await refreshResources();
    } catch (mountError) {
      setError(friendlyError(mountError));
    } finally {
      setMountingAgentId("");
    }
  }

  function openAgentEditor(agent = null) {
    setResourcesOpen(false);
    setAgentEditor(agent);
  }

  function openAgentAdoption(agent) {
    setResourcesOpen(false);
    setAdoptionTarget(agent);
  }

  function openKnowledgeUpload() {
    setResourcesOpen(false);
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-side">
          <IconButton label="Open chat history" onClick={() => setHistoryOpen(true)}>
            <Menu size={20} />
          </IconButton>
          <span className="wordmark">virenis</span>
        </div>
        <div className="header-side header-actions">
          <IconButton label="New chat" onClick={newChat} disabled={!canWrite}>
            <SquarePen size={19} />
          </IconButton>
          <button
            className="account-button"
            type="button"
            aria-label="Open agents and settings"
            title="Agents and settings"
            onClick={() => setResourcesOpen(true)}
          >
            {initialsFor(auth)}
          </button>
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
                onCopy={copyText}
                onRetry={retryAnswer}
                onFeedback={setFeedbackRunId}
                onDetails={openRunDetails}
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
            onAddKnowledge={() => setUploadOpen(true)}
            agents={agents}
            canWrite={canWrite}
            focusRequest={focusComposer}
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
          initialView={resourceView}
          mountingAgentId={mountingAgentId}
          onViewChange={setResourceView}
          onClose={() => setResourcesOpen(false)}
          onCreateAgent={() => openAgentEditor(null)}
          onEditAgent={openAgentEditor}
          onAdoptAgent={openAgentAdoption}
          onArchiveAgent={(agent) => {
            setResourcesOpen(false);
            setArchiveTarget(agent);
          }}
          onMountAgent={mountAgent}
          onAddKnowledge={openKnowledgeUpload}
          onDeleteKnowledge={(document) => {
            setResourcesOpen(false);
            setDeleteDocumentTarget(document);
          }}
          onRefresh={refreshResources}
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
          onClose={() => setUploadOpen(false)}
          onUploaded={async () => {
            setUploadOpen(false);
            await refreshResources();
            setResourcesOpen(true);
            setResourceView("knowledge");
          }}
        />
      )}

      {agentEditor !== undefined && (
        <AgentDialog
          auth={auth}
          agent={agentEditor || null}
          onClose={() => setAgentEditor(undefined)}
          onSaved={async () => {
            setAgentEditor(undefined);
            await refreshResources();
            setResourcesOpen(true);
            setResourceView("agents");
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
          onClose={() => setArchiveTarget(null)}
          onConfirm={() => archiveAgent(archiveTarget)}
        />
      )}


      {deleteDocumentTarget && (
        <ConfirmDialog
          title="Delete knowledge?"
          message={`${deleteDocumentTarget.title || "This file"} and its searchable contents will be permanently removed.`}
          confirmLabel="Delete"
          destructive
          icon={Trash2}
          onClose={() => {
            setDeleteDocumentTarget(null);
            setResourcesOpen(true);
            setResourceView("knowledge");
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

function ChatMessage({ message, run, agents, canWrite, previousUser, onCopy, onRetry, onFeedback, onDetails }) {
  const isAssistant = message.role === "assistant";
  return (
    <article className={`message ${message.role}`}>
      <div className="message-content">
        {isAssistant ? <FormattedText text={message.content} /> : message.content}
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

function FormattedText({ text }) {
  const normalized = normalizeAnswerText(text);
  const lines = normalized.split("\n");
  const blocks = [];
  let list = [];
  let listType = null;
  let code = [];
  let inCode = false;

  function flushList() {
    if (!list.length) return;
    const Tag = listType === "ordered" ? "ol" : "ul";
    blocks.push(<Tag key={`list-${blocks.length}`}>{list.map((item, index) => <li key={index}>{inlineFormat(item, `list-${blocks.length}-${index}`)}</li>)}</Tag>);
    list = [];
    listType = null;
  }

  function flushCode() {
    if (!code.length) return;
    blocks.push(<pre key={`code-${blocks.length}`}><code>{code.join("\n")}</code></pre>);
    code = [];
  }

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      if (inCode) flushCode();
      else flushList();
      inCode = !inCode;
      return;
    }
    if (inCode) {
      code.push(rawLine);
      return;
    }
    if (!line) {
      flushList();
      return;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = Math.min(heading[1].length + 1, 4);
      const Tag = `h${level}`;
      blocks.push(<Tag key={`heading-${blocks.length}`}>{inlineFormat(heading[2], `heading-${blocks.length}`)}</Tag>);
      return;
    }
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = ordered ? "ordered" : "unordered";
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      list.push((ordered || unordered)[1]);
      return;
    }
    flushList();
    blocks.push(<p key={`paragraph-${blocks.length}`}>{inlineFormat(line, `paragraph-${blocks.length}`)}</p>);
  });
  flushList();
  flushCode();
  return <div className="formatted-text">{blocks}</div>;
}

function normalizeAnswerText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+(#{2,4})\s+/g, "\n$1 ")
    .replace(/(?:\s+\*)+\s+(?=\*[^*]|\*\*|`|\[|[A-Z])/g, "\n- ")
    .replace(/^\*\s+/gm, "- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inlineFormat(text, keyPrefix) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*]+\*)/g;
  return String(text).split(pattern).filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link && /^(https?:\/\/|mailto:)/i.test(link[2])) {
      return <a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
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
  if (settled) parts.push(`${settled} settled outcome${settled === 1 ? "" : "s"}`);
  else if (pending) parts.push(`${pending} pending outcome${pending === 1 ? "" : "s"}`);
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
  const id = String(agent.id || "").toLowerCase().replace(/_lora$/, "").replaceAll("_", " ");
  const capability = String(agent.capability || "").toLowerCase();
  const words = `${title} ${id}`.split(/[^a-z0-9]+/).filter(Boolean);
  if (title.startsWith(query) || id.startsWith(query)) return 100;
  if (words.some((word) => word.startsWith(query))) return 80;
  if (title.includes(query) || id.includes(query)) return 50;
  if (capability.includes(query)) return 10;
  return 0;
}

function Composer({ value, onChange, onSubmit, onAddKnowledge, agents, canWrite, focusRequest }) {
  const inputRef = useRef(null);
  const listId = useId();
  const [mention, setMention] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const suggestions = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    return agents
      .filter((agent) => agent.enabled !== false && agent.mounted !== false)
      .map((agent) => ({ agent, score: mentionMatchScore(agent, query) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score
        || formatAgentName(left.agent.id, agents).localeCompare(formatAgentName(right.agent.id, agents)))
      .map(({ agent }) => agent)
      .slice(0, 6);
  }, [agents, mention]);

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
    const title = String(agent.title || "").replace(/"/g, "");
    const alias = String(agent.id || "agent").replace(/_lora$/i, "");
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
                <small>{agent.capability}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <IconButton label="Add knowledge" className="composer-control" onClick={onAddKnowledge} disabled={!canWrite}>
        <Paperclip size={19} />
      </IconButton>
      <label className="composer-input">
        <span className="sr-only">Message virenis</span>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            updateMention(event.target.value, event.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onClick={(event) => updateMention(event.currentTarget.value, event.currentTarget.selectionStart)}
          placeholder={canWrite ? "Ask anything" : "This conversation is read-only"}
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
  initialView,
  mountingAgentId,
  onViewChange,
  onClose,
  onCreateAgent,
  onEditAgent,
  onAdoptAgent,
  onArchiveAgent,
  onMountAgent,
  onAddKnowledge,
  onDeleteKnowledge,
  onRefresh
}) {
  const [view, setView] = useState(initialView || "agents");
  const canWrite = !auth?.is_viewer;
  function changeView(next) {
    setView(next);
    onViewChange(next);
  }
  return (
    <ModalSurface title="Agents & knowledge" side="right" onClose={onClose}>
      <div className="sheet-body resource-sheet-body">
        <div className="view-switch" aria-label="Resource view">
          <button type="button" aria-pressed={view === "agents"} onClick={() => changeView("agents")}>Agents</button>
          <button type="button" aria-pressed={view === "knowledge"} onClick={() => changeView("knowledge")}>Knowledge</button>
          {auth?.is_admin && <button type="button" aria-pressed={view === "admin"} onClick={() => changeView("admin")}>Admin</button>}
        </div>

        {view === "agents" && (
          <AgentCatalog
            agents={agents}
            auth={auth}
            mountingAgentId={mountingAgentId}
            onCreate={onCreateAgent}
            onEdit={onEditAgent}
            onAdopt={onAdoptAgent}
            onArchive={onArchiveAgent}
            onMount={onMountAgent}
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

        {view === "admin" && auth?.is_admin && (
          <AdminPanel runtime={runtime} metrics={metrics} agents={agents} documents={documents} onRefresh={onRefresh} />
        )}

        <footer className="profile-footer">
          <span className="profile-initials" aria-hidden="true">{initialsFor(auth)}</span>
          <span>
            <strong>{auth?.user_id || "User"}</strong>
            <small>{auth?.is_admin ? "Admin" : auth?.is_viewer ? "Viewer" : "Private workspace"}</small>
          </span>
        </footer>
      </div>
    </ModalSurface>
  );
}

function RealityRank({ rank }) {
  const summary = realityRankSummary(rank);
  const history = realityRankHistory(rank);
  return (
    <div className="rank-summary">
      <div className="rank-overview" title="Used only when capability cues tie">
        <b>RealityRank {summary.score_label}</b>
        <i>{summary.status_label}</i>
        <i>{summary.sample_label}</i>
      </div>
      <details
        className="rank-history"
        onToggle={(event) => {
          if (!event.currentTarget.open) return;
          const details = event.currentTarget;
          requestAnimationFrame(() => details.scrollIntoView({ block: "nearest" }));
        }}
      >
        <summary>Sample history</summary>
        <dl>
          {history.map((entry) => {
            const entrySummary = realityRankSummary({ score: entry.score, sample_size: entry.sample_size });
            return (
              <div key={`${entry.agent_revision}-${entry.current}`}>
                <dt>{entry.current ? "Current" : `Revision ${shortRevision(entry.agent_revision)}`}</dt>
                <dd>{entrySummary.score_label} · {entrySummary.sample_label}</dd>
              </div>
            );
          })}
        </dl>
      </details>
    </div>
  );
}

function AgentCatalog({ agents, auth, mountingAgentId, onCreate, onEdit, onAdopt, onArchive, onMount }) {
  const [query, setQuery] = useState("");
  const canWrite = !auth?.is_viewer;
  const canManage = (agent) => auth?.is_admin || (canWrite
    && agent.visibility === "private"
    && agent.created_by === auth?.user_id
    && agent.workspace_id === auth?.workspace_id);
  const filtered = agents
    .filter((agent) => !query || `${agent.title || ""} ${agent.capability || ""}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => Number(canManage(right)) - Number(canManage(left))
      || String(left.title || left.id).localeCompare(String(right.title || right.id)));
  return (
    <section className="resource-section" aria-labelledby="agents-heading">
      <div className="section-heading">
        <div>
          <h3 id="agents-heading">Agents</h3>
          <p>Choose one in chat by typing @.</p>
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
          const archived = agent.enabled === false && agent.mount_pending !== true;
          const pending = !archived && (agent.mount_pending === true || agent.mounted === false);
          const manageable = !runtimeOnly && canManage(agent);
          return (
            <div className="agent-row" key={agent.id}>
              <span className={`status-dot ${archived ? "muted" : pending || runtimeOnly ? "pending" : "ready"}`} aria-hidden="true" />
              <div className="row-copy">
                <strong>{formatAgentName(agent.id, agents)}</strong>
                <span>{agent.capability || "Custom agent"}</span>
                <small>{archived ? "Archived" : runtimeOnly ? "Needs an owner" : pending ? "Preparing" : agent.visibility === "private" ? "Private" : agent.visibility === "team" ? "Team" : "Available"}</small>
                <RealityRank rank={agent.reality_rank} />
              </div>
              {runtimeOnly && auth?.is_admin && (
                <div className="row-actions">
                  <IconButton label={`Adopt ${agent.title || "agent"}`} compact onClick={() => onAdopt(agent)}>
                    <UserPlus size={16} />
                  </IconButton>
                </div>
              )}
              {manageable && (
                <div className="row-actions">
                  {pending && (
                    <IconButton label={`Retry ${agent.title || "agent"}`} compact onClick={() => onMount(agent)} disabled={mountingAgentId === agent.id}>
                      <RefreshCw className={mountingAgentId === agent.id ? "spin" : ""} size={16} />
                    </IconButton>
                  )}
                  <IconButton label={`Edit ${agent.title || "agent"}`} compact onClick={() => onEdit(agent)} disabled={archived}>
                    <Pencil size={16} />
                  </IconButton>
                  <IconButton label={`Archive ${agent.title || "agent"}`} compact onClick={() => onArchive(agent)} disabled={archived}>
                    <Archive size={16} />
                  </IconButton>
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

function KnowledgeList({ documents, agents, auth, canWrite, onAdd, onDelete }) {
  return (
    <section className="resource-section" aria-labelledby="knowledge-heading">
      <div className="section-heading">
        <div>
          <h3 id="knowledge-heading">Knowledge</h3>
          <p>Files that your agents can use as sources.</p>
        </div>
        <IconButton label="Add knowledge" onClick={onAdd} disabled={!canWrite}>
          <FilePlus2 size={18} />
        </IconButton>
      </div>
      <div className="flat-list knowledge-list">
        {documents.map((document) => (
          <div className="knowledge-row" key={document.document_id}>
            <BookOpen size={18} aria-hidden="true" />
            <div className="row-copy">
              <strong>{document.title}</strong>
              <span>{document.chunks ? `${document.chunks} indexed sections` : "Ready to search"}</span>
              <small>{document.visibility === "private" ? "Private" : document.visibility || "Available"}</small>
            </div>
            {canManageDocument(document, agents, auth) && (
              <div className="row-actions">
                <IconButton label={`Delete ${document.title || "knowledge"}`} compact onClick={() => onDelete(document)}>
                  <Trash2 size={16} />
                </IconButton>
              </div>
            )}
          </div>
        ))}
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
  const readyAgents = agents.filter((agent) => agent.enabled !== false && agent.mounted !== false).length;
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
    </section>
  );
}

function RankTieBreakNote({ tieBreak, adapter, agents }) {
  const selectedName = formatAgentName(adapter, agents);
  const alternatives = tieBreak.tied_candidates.slice(0, 2);
  const comparison = alternatives.length
    ? `${selectedName}'s ${Math.round(tieBreak.reality_rank * 100)} rank was preferred over ${alternatives.map((candidate) => `${formatAgentName(candidate.adapter, agents)} at ${Math.round(candidate.reality_rank * 100)}`).join(" and ")} after equal capability matches.`
    : `Capability cues tied, so ${selectedName}'s ${Math.round(tieBreak.reality_rank * 100)} rank was the final tie-break.`;
  const sampleText = tieBreak.sample_size === 1
    ? "1 verified outcome informed this rank."
    : tieBreak.sample_size > 1
      ? `${tieBreak.sample_size} verified outcomes informed this rank.`
      : "The execution did not expose a verified sample count for this rank snapshot.";
  return (
    <div className="rank-route-note">
      <Scale size={16} aria-hidden="true" />
      <div>
        <strong>RealityRank tie-break</strong>
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
              <button type="button" aria-pressed={view === "outcomes"} onClick={() => setView("outcomes")}>Outcomes</button>
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
                            ? <em>Rank {Math.round(tieBreak.reality_rank * 100)}</em>
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
                  <div><h3 id="outcomes-heading">Outcomes</h3><p>Track whether a measurable claim proves true.</p></div>
                  {canWrite && run.status === "completed" && !hasOutcome && (
                    <IconButton label="Create outcome" onClick={onCreateOutcome}><Plus size={18} /></IconButton>
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
                            <div><dt>Rank status</dt><dd>{contract.settlement?.verified_for_rank === true ? "Verified for ranking" : "Tracking only"}</dd></div>
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
                      <p>No outcome is being tracked for this answer.</p>
                      {canWrite && run.status === "completed" && (
                        <button type="button" className="text-button secondary" onClick={onCreateOutcome}>
                          <Plus size={16} />Track an outcome
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

function createAgentForm(agent) {
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
  const suffix = Date.now().toString(36).slice(-7);
  return {
    id: `custom_${suffix}_lora`,
    title: "",
    capability: "",
    boundary: "Use only the supplied instructions and knowledge. State uncertainty and stay within this agent's purpose.",
    routing_cues: "",
    produces: "domain_outputs",
    tools: "",
    sources: "",
    source_text: ""
  };
}

function AgentDialog({ auth, agent, onClose, onSaved }) {
  const editing = Boolean(agent);
  const [form, setForm] = useState(() => createAgentForm(agent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = {
        ...form,
        routing_cues: form.routing_cues || form.title
      };
      if (editing) {
        delete payload.id;
        if (!payload.source_text || agent?.document) delete payload.source_text;
        if (!auth?.is_admin) delete payload.sources;
        await api.patch(`/api/agents/${encodeURIComponent(agent.id)}`, payload);
      } else {
        await api.post("/api/agents", payload);
      }
      await onSaved();
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalSurface
      title={editing ? "Edit agent" : "Create agent"}
      description={editing ? "Changes apply to future answers." : "Give it a clear purpose and tell virenis when to use it."}
      onClose={onClose}
      className="form-dialog"
    >
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label>
          <span>Name</span>
          <input data-autofocus value={form.title} onChange={(event) => update("title", event.target.value)} required maxLength={160} placeholder="2026 Financial Data" />
        </label>
        <label>
          <span>Purpose and instructions</span>
          <textarea value={form.capability} onChange={(event) => update("capability", event.target.value)} required placeholder="What this agent should know and do" />
        </label>
        <label>
          <span>When to use it</span>
          <textarea value={form.routing_cues} onChange={(event) => update("routing_cues", event.target.value)} placeholder="financial data, 2026 report, revenue" />
        </label>
        {!agent?.document && (
          <label>
            <span>{editing ? "Replace private knowledge" : "Private knowledge"} <small>optional</small></span>
            <textarea value={form.source_text} onChange={(event) => update("source_text", event.target.value)} placeholder="Paste facts, rules, or reference material" />
          </label>
        )}
        <details className="advanced-fields">
          <summary><Settings2 size={15} />Advanced</summary>
          <div>
            <label><span>Internal id</span><input value={form.id} onChange={(event) => update("id", event.target.value)} disabled={editing} required /></label>
            <label><span>Boundary</span><textarea value={form.boundary} onChange={(event) => update("boundary", event.target.value)} required /></label>
            <label><span>Outputs</span><input value={form.produces} onChange={(event) => update("produces", event.target.value)} /></label>
            <label><span>Allowed tools</span><input value={form.tools} onChange={(event) => update("tools", event.target.value)} /></label>
            {auth?.is_admin && <label><span>Approved sources</span><input value={form.sources} onChange={(event) => update("sources", event.target.value)} /></label>}
          </div>
        </details>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="text-button primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : editing ? <Check size={16} /> : <Plus size={16} />}
            {editing ? "Save" : "Create"}
          </button>
        </div>
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
          <div><strong>{formatAgentName(agent.id, [agent])}</strong><code>{agent.id}</code></div>
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
    } catch (uploadError) {
      setError(friendlyError(uploadError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ModalSurface title="Add knowledge" description="Upload a PDF, Markdown, or text file." onClose={onClose} className="form-dialog">
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
            {busy ? "Adding" : "Add"}
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
    domain: "",
    task_type: "decision",
    outcome_type: "binary",
    metric: "",
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
        title: form.title,
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
    <ModalSurface title="Track an outcome" description="Turn a measurable claim from this answer into a result you can settle later." onClose={onClose} className="wide-dialog">
      <form className="dialog-form" onSubmit={submit}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="field-grid two-column">
          <label><span>Name</span><input data-autofocus value={form.title} onChange={(event) => update("title", event.target.value)} required placeholder="Q3 cash threshold" /></label>
          <label><span>Type</span><select value={form.outcome_type} onChange={(event) => updateOutcomeType(event.target.value)}><option value="binary">Yes or no</option><option value="numeric">Number</option><option value="categorical">Category</option></select></label>
        </div>
        <label><span>Measurable claim</span><textarea value={form.claim} onChange={(event) => update("claim", event.target.value)} required placeholder="Cash balance will remain above the required threshold through Q3." /></label>
        <div className="field-grid two-column">
          <label><span>Domain</span><input value={form.domain} onChange={(event) => update("domain", event.target.value)} required placeholder="finance" /></label>
          <label><span>Metric</span><input value={form.metric} onChange={(event) => update("metric", event.target.value)} required placeholder="quarter-end cash balance" /></label>
          <label><span>Due date</span><input type="date" min={minimumDueDate} value={form.due_at} onChange={(event) => update("due_at", event.target.value)} required /></label>
          {form.outcome_type === "numeric" && <label><span>Accepted error</span><input type="number" min="0.000001" step="any" value={form.error_scale} onChange={(event) => update("error_scale", event.target.value)} required /></label>}
          {form.outcome_type === "categorical" && <label><span>Allowed values <small>optional, comma separated</small></span><input value={form.allowed_values} onChange={(event) => update("allowed_values", event.target.value)} /></label>}
          {form.outcome_type === "numeric" && <label><span>Unit <small>optional</small></span><input value={form.unit} onChange={(event) => update("unit", event.target.value)} placeholder="USD" /></label>}
          <label className="span-two"><span>Result source</span><input value={form.reference} onChange={(event) => update("reference", event.target.value)} required maxLength={1000} placeholder="URL, report ID, or review record to use at settlement" /></label>
        </div>
        <fieldset className="prediction-fieldset">
          <legend>Agent predictions</legend>
          <p>Record each agent's independent prediction before the result is known.</p>
          {participants.map((participant) => {
            const prediction = form.predictions[participant.step_id];
            const evidenceIsValid = predictionEvidenceIsValid(participant, prediction, form.outcome_type);
            return (
              <div className="prediction-row" key={participant.step_id}>
                <strong>{formatAgentName(participant.adapter, agents)}</strong>
                <label>
                  <span>{form.outcome_type === "binary" ? "Chance (%)" : "Prediction"}</span>
                  <input
                    type={form.outcome_type === "categorical" ? "text" : "number"}
                    min={form.outcome_type === "binary" ? "0" : undefined}
                    max={form.outcome_type === "binary" ? "100" : undefined}
                    step={form.outcome_type === "numeric" ? "any" : undefined}
                    value={prediction.value}
                    onChange={(event) => updatePredictionValue(participant, event.target.value)}
                    disabled={prediction.abstained}
                    required={!prediction.abstained}
                  />
                </label>
                <label>
                  <span>Confidence (%)</span>
                  <input type="number" min="0" max="100" value={prediction.confidence} onChange={(event) => updatePrediction(participant.step_id, "confidence", event.target.value)} disabled={prediction.abstained} required={!prediction.abstained} />
                </label>
                <label className="check-label"><input type="checkbox" checked={prediction.abstained} onChange={(event) => updatePrediction(participant.step_id, "abstained", event.target.checked)} /><span>Abstain</span></label>
                {!prediction.abstained && (
                  <>
                    <label className="prediction-evidence">
                      <span>Evidence from recorded answer</span>
                      <textarea
                        value={prediction.evidence_quote}
                        onChange={(event) => updatePrediction(participant.step_id, "evidence_quote", event.target.value)}
                        required
                        maxLength={500}
                      />
                      <small className={`evidence-status ${evidenceIsValid ? "valid" : "invalid"}`}>
                        {evidenceIsValid ? "Exact passage verified" : "Use an exact passage containing this value"}
                      </small>
                    </label>
                    <details className="recorded-answer">
                      <summary>View recorded answer</summary>
                      <p>{participant.domain_answer || "No recorded answer is available."}</p>
                    </details>
                  </>
                )}
              </div>
            );
          })}
        </fieldset>
        <details className="advanced-fields">
          <summary><Settings2 size={15} />Resolver</summary>
          <div className="field-grid two-column">
            <label><span>Source type</span><select value={form.resolver_type} onChange={(event) => update("resolver_type", event.target.value)}><option value="human">Human review</option><option value="api">API</option><option value="document">Document</option></select></label>
            <label><span>Authority</span><input value={form.authority} onChange={(event) => update("authority", event.target.value)} required maxLength={240} /></label>
          </div>
        </details>
        <div className="dialog-actions">
          <button type="button" className="text-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="text-button primary" disabled={busy || !form.due_at || !form.reference.trim() || !predictionsAreValid}>{busy ? <LoaderCircle className="spin" size={16} /> : <Clock3 size={16} />}Start tracking</button>
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
      setError("This outcome cannot be settled before its due time.");
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
