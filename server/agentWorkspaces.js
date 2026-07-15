import crypto from "node:crypto";

export const AGENT_WORKSPACE_MAX_AGENTS = 16;
export const AGENT_WORKSPACE_MAX_PER_USER = 50;

const GENERAL_NAME = "General";
const RESERVATION_TTL_MS = 15 * 60 * 1000;

function workspaceError(status, message, code = "agent_workspace_error") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function makeWorkspaceId() {
  return `aw_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function boundedText(value, max) {
  return String(value || "").replaceAll("\0", "").trim().slice(0, max);
}

function actorOwnsWorkspace(workspace, actor) {
  return Boolean(
    workspace
    && String(workspace.workspace_id || "") === String(actor?.workspace_id || "")
    && String(workspace.created_by || "") === String(actor?.user_id || "")
  );
}

function eligibleDefaultAgent(agent, actor) {
  if (!agent || agent.enabled === false || agent.document || agent.resource_for_agent_id) return false;
  if (!agent.workspace_id) return true;
  return String(agent.workspace_id) === String(actor?.workspace_id || "")
    && String(agent.created_by || "") === String(actor?.user_id || "");
}

function defaultAgentIds(data, actor) {
  const candidates = (data.agents || []).filter((agent) => eligibleDefaultAgent(agent, actor));
  candidates.sort((left, right) => {
    const leftOwned = left.created_by === actor?.user_id ? 1 : 0;
    const rightOwned = right.created_by === actor?.user_id ? 1 : 0;
    return rightOwned - leftOwned
      || Number(left.system_managed !== true) - Number(right.system_managed !== true)
      || String(left.title || left.id).localeCompare(String(right.title || right.id));
  });
  return [...new Set(candidates.map((agent) => agent.id).filter(Boolean))]
    .slice(0, AGENT_WORKSPACE_MAX_AGENTS);
}

export function normalizeAgentWorkspaceCollections(data) {
  data.agentWorkspaces = Array.isArray(data.agentWorkspaces) ? data.agentWorkspaces : [];
  data.agentWorkspaceRatings = Array.isArray(data.agentWorkspaceRatings) ? data.agentWorkspaceRatings : [];
  const seen = new Set();
  data.agentWorkspaces = data.agentWorkspaces.filter((workspace) => {
    if (!workspace || typeof workspace !== "object" || !workspace.agent_workspace_id) return false;
    if (seen.has(workspace.agent_workspace_id)) return false;
    seen.add(workspace.agent_workspace_id);
    workspace.name = boundedText(workspace.name, 80) || GENERAL_NAME;
    workspace.description = boundedText(workspace.description, 1200);
    workspace.agent_ids = [...new Set((Array.isArray(workspace.agent_ids) ? workspace.agent_ids : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean))].slice(0, AGENT_WORKSPACE_MAX_AGENTS);
    workspace.is_general = workspace.is_general === true;
    workspace.visibility = "private";
    workspace.reservations = Array.isArray(workspace.reservations) ? workspace.reservations : [];
    workspace.copy_status = ["copying", "ready", "cleanup_required"].includes(workspace.copy_status)
      ? workspace.copy_status
      : undefined;
    if (workspace.marketplace && typeof workspace.marketplace === "object" && !Array.isArray(workspace.marketplace)) {
      workspace.marketplace.description = boundedText(
        workspace.marketplace.description || workspace.description,
        1200
      );
      workspace.marketplace.published_by = boundedText(
        workspace.marketplace.published_by || workspace.created_by,
        200
      );
      workspace.marketplace.publisher_display_name = boundedText(
        workspace.marketplace.publisher_display_name || workspace.marketplace.published_by,
        80
      );
      workspace.marketplace.publisher_workspace_id ??= workspace.workspace_id || null;
      for (const key of ["summary", "achievements", "proofs", "version", "license", "comments", "review"]) {
        delete workspace.marketplace[key];
      }
    }
    return true;
  });
  data.agentWorkspaceRatings = data.agentWorkspaceRatings
    .filter((rating) => rating && typeof rating === "object")
    .map((rating) => {
      const safe = { ...rating };
      delete safe.review;
      delete safe.comment;
      delete safe.comments;
      return safe;
    })
    .filter((rating) => {
      const workspace = data.agentWorkspaces.find((candidate) => (
        candidate.marketplace?.listing_id
        && candidate.marketplace.listing_id === rating.listing_id
      ));
      if (!workspace) return true;
      return !(
        rating.created_by === workspace.marketplace?.published_by
        && String(rating.workspace_id || "") === String(workspace.marketplace?.publisher_workspace_id || "")
      );
    });
  return data;
}

export function pruneAgentWorkspaceReservations(workspace, at = Date.now()) {
  if (!workspace) return;
  workspace.reservations = (Array.isArray(workspace.reservations) ? workspace.reservations : [])
    .filter((reservation) => {
      const expiresAt = Date.parse(reservation?.expires_at || "");
      return reservation?.reservation_id
        && Number.isInteger(Number(reservation.count))
        && Number(reservation.count) > 0
        && Number.isFinite(expiresAt)
        && expiresAt > at;
    });
}

export function ensureGeneralAgentWorkspace(data, actor) {
  normalizeAgentWorkspaceCollections(data);
  let workspace = data.agentWorkspaces.find((candidate) => (
    candidate.is_general === true && actorOwnsWorkspace(candidate, actor)
  ));
  if (workspace) {
    pruneAgentWorkspaceReservations(workspace);
    return workspace;
  }
  const now = nowIso();
  workspace = {
    agent_workspace_id: makeWorkspaceId(),
    name: GENERAL_NAME,
    description: "Your default agent team.",
    workspace_id: actor.workspace_id,
    created_by: actor.user_id,
    visibility: "private",
    is_general: true,
    agent_ids: defaultAgentIds(data, actor),
    reservations: [],
    marketplace: null,
    created_at: now,
    updated_at: now
  };
  data.agentWorkspaces.push(workspace);
  return workspace;
}

export function findAgentWorkspace(data, workspaceId, actor, { mutable = false } = {}) {
  normalizeAgentWorkspaceCollections(data);
  const workspace = data.agentWorkspaces.find((candidate) => candidate.agent_workspace_id === workspaceId);
  if (!actorOwnsWorkspace(workspace, actor)) {
    throw workspaceError(404, "Workspace not found.", "agent_workspace_not_found");
  }
  if (mutable && actor?.role === "viewer") {
    throw workspaceError(403, "This workspace is read-only.", "agent_workspace_read_only");
  }
  pruneAgentWorkspaceReservations(workspace);
  return workspace;
}

export function listAgentWorkspaces(data, actor) {
  const general = ensureGeneralAgentWorkspace(data, actor);
  return data.agentWorkspaces
    .filter((workspace) => actorOwnsWorkspace(workspace, actor))
    .sort((left, right) => Number(right.agent_workspace_id === general.agent_workspace_id)
      - Number(left.agent_workspace_id === general.agent_workspace_id)
      || String(right.updated_at || "").localeCompare(String(left.updated_at || "")));
}

export function publicAgentWorkspace(workspace, data = null) {
  const availableIds = data
    ? new Set((data.agents || []).filter((agent) => agent.enabled !== false).map((agent) => agent.id))
    : null;
  const agentIds = [...new Set(workspace.agent_ids || [])];
  return {
    agent_workspace_id: workspace.agent_workspace_id,
    name: workspace.name,
    description: workspace.description || "",
    is_general: workspace.is_general === true,
    agent_ids: agentIds,
    agent_count: agentIds.length,
    available_agent_count: availableIds ? agentIds.filter((id) => availableIds.has(id)).length : agentIds.length,
    max_agents: AGENT_WORKSPACE_MAX_AGENTS,
    setup_status: workspace.copy_status || "ready",
    setup_error: workspace.copy_error || null,
    marketplace: workspace.marketplace?.published === true ? {
      published: true,
      listing_id: workspace.marketplace.listing_id,
      description: workspace.marketplace.description,
      published_at: workspace.marketplace.published_at,
      updated_at: workspace.marketplace.updated_at
    } : { published: false },
    created_at: workspace.created_at,
    updated_at: workspace.updated_at
  };
}

export function createAgentWorkspace(data, actor, body = {}) {
  normalizeAgentWorkspaceCollections(data);
  ensureGeneralAgentWorkspace(data, actor);
  const owned = data.agentWorkspaces.filter((workspace) => actorOwnsWorkspace(workspace, actor));
  const limit = Number(process.env.APP_MAX_AGENT_WORKSPACES_PER_USER || AGENT_WORKSPACE_MAX_PER_USER);
  if (limit > 0 && owned.length >= limit) {
    throw workspaceError(429, `You can create up to ${limit} workspaces.`, "agent_workspace_quota_exceeded");
  }
  const name = boundedText(body.name, 80);
  if (!name) throw workspaceError(400, "Workspace name is required.", "agent_workspace_name_required");
  if (name.toLowerCase() === GENERAL_NAME.toLowerCase()) {
    throw workspaceError(409, "General is reserved for your default workspace.", "agent_workspace_name_reserved");
  }
  if (owned.some((workspace) => workspace.name.toLowerCase() === name.toLowerCase())) {
    throw workspaceError(409, "A workspace with this name already exists.", "agent_workspace_name_conflict");
  }
  const requestedAgentIds = [...new Set((Array.isArray(body.agent_ids) ? body.agent_ids : [])
    .map((id) => String(id || "").trim()).filter(Boolean))];
  if (requestedAgentIds.length > AGENT_WORKSPACE_MAX_AGENTS) {
    throw workspaceError(409, `A workspace can contain at most ${AGENT_WORKSPACE_MAX_AGENTS} agents.`, "agent_workspace_capacity_exceeded");
  }
  const now = nowIso();
  const workspace = {
    agent_workspace_id: makeWorkspaceId(),
    name,
    description: boundedText(body.description, 1200),
    workspace_id: actor.workspace_id,
    created_by: actor.user_id,
    visibility: "private",
    is_general: false,
    agent_ids: requestedAgentIds,
    reservations: [],
    marketplace: null,
    created_at: now,
    updated_at: now
  };
  data.agentWorkspaces.push(workspace);
  return workspace;
}

export function updateAgentWorkspace(data, workspaceId, actor, body = {}) {
  const workspace = findAgentWorkspace(data, workspaceId, actor, { mutable: true });
  if ("name" in body) {
    const name = boundedText(body.name, 80);
    if (!name) throw workspaceError(400, "Workspace name is required.", "agent_workspace_name_required");
    if (workspace.is_general && name.toLowerCase() !== GENERAL_NAME.toLowerCase()) {
      throw workspaceError(409, "The General workspace cannot be renamed.", "agent_workspace_general_immutable");
    }
    if (!workspace.is_general && name.toLowerCase() === GENERAL_NAME.toLowerCase()) {
      throw workspaceError(409, "General is reserved for your default workspace.", "agent_workspace_name_reserved");
    }
    if (data.agentWorkspaces.some((candidate) => (
      candidate.agent_workspace_id !== workspace.agent_workspace_id
      && actorOwnsWorkspace(candidate, actor)
      && candidate.name.toLowerCase() === name.toLowerCase()
    ))) {
      throw workspaceError(409, "A workspace with this name already exists.", "agent_workspace_name_conflict");
    }
    workspace.name = name;
  }
  if ("description" in body) workspace.description = boundedText(body.description, 1200);
  workspace.updated_at = nowIso();
  return workspace;
}

export function setAgentWorkspaceMembers(data, workspaceId, actor, agentIds) {
  const workspace = findAgentWorkspace(data, workspaceId, actor, { mutable: true });
  if (workspace.copy_status === "copying") {
    throw workspaceError(409, "Wait for the Marketplace workspace copy to finish.", "agent_workspace_copy_in_progress");
  }
  const ids = [...new Set((Array.isArray(agentIds) ? agentIds : [])
    .map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length > AGENT_WORKSPACE_MAX_AGENTS) {
    throw workspaceError(409, `A workspace can contain at most ${AGENT_WORKSPACE_MAX_AGENTS} agents.`, "agent_workspace_capacity_exceeded");
  }
  pruneAgentWorkspaceReservations(workspace);
  const reserved = workspace.reservations.reduce((total, reservation) => total + Number(reservation.count || 0), 0);
  if (ids.length + reserved > AGENT_WORKSPACE_MAX_AGENTS) {
    throw workspaceError(
      409,
      "Agent setup is currently reserving the remaining workspace capacity. Try this membership change again when setup finishes.",
      "agent_workspace_capacity_reserved"
    );
  }
  const agentsById = new Map((data.agents || []).map((agent) => [agent.id, agent]));
  for (const id of ids) {
    const agent = agentsById.get(id);
    const accessible = agent && (
      !agent.workspace_id
      || (
        String(agent.workspace_id) === String(actor.workspace_id)
        && (agent.visibility !== "private" || agent.created_by === actor.user_id)
      )
    );
    if (!accessible || agent.document || agent.resource_for_agent_id) {
      throw workspaceError(404, `Agent not found: ${id}.`, "agent_workspace_agent_not_found");
    }
  }
  workspace.agent_ids = ids;
  workspace.updated_at = nowIso();
  return workspace;
}

export function reserveAgentWorkspaceCapacity(data, workspaceId, actor, count, reservationId) {
  const workspace = findAgentWorkspace(data, workspaceId, actor, { mutable: true });
  const requested = Number(count);
  if (!Number.isInteger(requested) || requested < 1 || requested > AGENT_WORKSPACE_MAX_AGENTS) {
    throw workspaceError(400, "Workspace reservation count is invalid.", "agent_workspace_reservation_invalid");
  }
  const id = boundedText(reservationId, 160);
  if (!id) throw workspaceError(400, "Workspace reservation id is required.", "agent_workspace_reservation_invalid");
  const existing = workspace.reservations.find((reservation) => reservation.reservation_id === id);
  if (existing) return workspace;
  const reserved = workspace.reservations.reduce((total, reservation) => total + Number(reservation.count || 0), 0);
  if (workspace.agent_ids.length + reserved + requested > AGENT_WORKSPACE_MAX_AGENTS) {
    throw workspaceError(
      409,
      `This workspace has room for ${Math.max(0, AGENT_WORKSPACE_MAX_AGENTS - workspace.agent_ids.length - reserved)} more agent${AGENT_WORKSPACE_MAX_AGENTS - workspace.agent_ids.length - reserved === 1 ? "" : "s"}.`,
      "agent_workspace_capacity_exceeded"
    );
  }
  workspace.reservations.push({
    reservation_id: id,
    count: requested,
    expires_at: new Date(Date.now() + RESERVATION_TTL_MS).toISOString()
  });
  workspace.updated_at = nowIso();
  return workspace;
}

export function commitAgentWorkspaceReservation(data, workspaceId, actor, reservationId, agentIds = []) {
  const workspace = findAgentWorkspace(data, workspaceId, actor, { mutable: true });
  const reservationIndex = workspace.reservations.findIndex((reservation) => reservation.reservation_id === reservationId);
  if (reservationIndex < 0) {
    throw workspaceError(409, "Workspace capacity reservation expired. Try again.", "agent_workspace_reservation_expired");
  }
  const ids = [...new Set(agentIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const merged = [...new Set([...workspace.agent_ids, ...ids])];
  const reservation = workspace.reservations[reservationIndex];
  const additions = merged.length - workspace.agent_ids.length;
  if (additions > Number(reservation.count || 0)) {
    throw workspaceError(409, "Workspace membership changed while agents were being created. Try again.", "agent_workspace_reservation_conflict");
  }
  if (merged.length > AGENT_WORKSPACE_MAX_AGENTS) {
    throw workspaceError(409, `A workspace can contain at most ${AGENT_WORKSPACE_MAX_AGENTS} agents.`, "agent_workspace_capacity_exceeded");
  }
  workspace.agent_ids = merged;
  workspace.reservations.splice(reservationIndex, 1);
  workspace.updated_at = nowIso();
  return workspace;
}

export function releaseAgentWorkspaceReservation(data, workspaceId, actor, reservationId) {
  const workspace = findAgentWorkspace(data, workspaceId, actor, { mutable: true });
  workspace.reservations = workspace.reservations.filter((reservation) => reservation.reservation_id !== reservationId);
  workspace.updated_at = nowIso();
  return workspace;
}

export function removeAgentFromAllWorkspaces(data, agentId) {
  for (const workspace of data.agentWorkspaces || []) {
    const next = (workspace.agent_ids || []).filter((id) => id !== agentId);
    if (next.length !== (workspace.agent_ids || []).length) {
      workspace.agent_ids = next;
      workspace.updated_at = nowIso();
    }
  }
}

export function deleteAgentWorkspace(data, workspaceId, actor) {
  const workspace = findAgentWorkspace(data, workspaceId, actor, { mutable: true });
  if (workspace.is_general) {
    throw workspaceError(409, "The General workspace cannot be deleted.", "agent_workspace_general_immutable");
  }
  if (workspace.reservations.length) {
    throw workspaceError(409, "Wait for agent setup to finish before deleting this workspace.", "agent_workspace_setup_in_progress");
  }
  if (workspace.copy_status === "copying") {
    throw workspaceError(409, "Wait for the Marketplace workspace copy to finish.", "agent_workspace_copy_in_progress");
  }
  const general = ensureGeneralAgentWorkspace(data, actor);
  data.agentWorkspaces = data.agentWorkspaces.filter((candidate) => candidate.agent_workspace_id !== workspace.agent_workspace_id);
  for (const session of data.sessions || []) {
    if (
      session.agent_workspace_id === workspace.agent_workspace_id
      && String(session.workspace_id || "") === String(actor.workspace_id || "")
      && session.created_by === actor.user_id
    ) {
      session.agent_workspace_id = general.agent_workspace_id;
      session.updated_at = nowIso();
    }
  }
  data.agentWorkspaceRatings = (data.agentWorkspaceRatings || []).filter((rating) => (
    rating.listing_id !== workspace.marketplace?.listing_id
  ));
  return { deleted: workspace, fallback: general };
}

export function activeAgentWorkspaceForSession(data, session) {
  if (!session?.agent_workspace_id) return null;
  return (data.agentWorkspaces || []).find((workspace) => (
    workspace.agent_workspace_id === session.agent_workspace_id
    && String(workspace.workspace_id || "") === String(session.workspace_id || "")
    && workspace.created_by === session.created_by
  )) || null;
}
