import crypto from "node:crypto";

export const PUBLISHER_ID_RE = /^publisher_[a-f0-9]{32}$/;
const DELETED_PUBLISHER_NAME = "Deleted publisher";
const COMMUNITY_PUBLISHER_NAME = "Community publisher";

export function createPublisherId(used = new Set()) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = `publisher_${crypto.randomUUID().replaceAll("-", "")}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("A unique public publisher identity could not be allocated.");
}

export function ensurePublisherPublicId(data, ownerId, displayName = null) {
  const owner = String(ownerId || "").trim();
  const used = collectPublisherIds(data);
  const user = (data.users || []).find((candidate) => String(candidate?.user_id || "") === owner);
  if (user && PUBLISHER_ID_RE.test(String(user.public_publisher_id || ""))) {
    return user.public_publisher_id;
  }

  const existing = marketplaceSubjects(data).find((subject) => (
    String(subject.marketplace?.published_by || "") === owner
    && PUBLISHER_ID_RE.test(String(subject.marketplace?.publisher_id || ""))
  ))?.marketplace?.publisher_id;
  const publisherId = existing || createPublisherId(used);
  if (user) {
    user.public_publisher_id = publisherId;
    if (!user.display_name && displayName) user.display_name = safeDisplayName(displayName, owner);
  }
  return publisherId;
}

export function assignMarketplacePublisher(data, marketplace, {
  ownerId,
  displayName = null
} = {}) {
  const owner = String(ownerId || marketplace?.published_by || "").trim();
  const publisherId = ensurePublisherPublicId(data, owner, displayName);
  marketplace.publisher_id = publisherId;
  marketplace.publisher_display_name = resolvedPublisherDisplayName(data, {
    ownerId: owner,
    storedDisplayName: displayName || marketplace.publisher_display_name
  });
  return publisherId;
}

export function publicPublisher(data, marketplace = {}) {
  const ownerId = String(marketplace.published_by || "").trim();
  const user = (data.users || []).find((candidate) => String(candidate?.user_id || "") === ownerId);
  const publisherId = PUBLISHER_ID_RE.test(String(marketplace.publisher_id || ""))
    ? marketplace.publisher_id
    : PUBLISHER_ID_RE.test(String(user?.public_publisher_id || ""))
      ? user.public_publisher_id
      : null;
  return {
    id: publisherId,
    display_name: resolvedPublisherDisplayName(data, {
      ownerId,
      storedDisplayName: marketplace.publisher_display_name
    }),
    status: marketplace.publisher_status === "deleted" ? "deleted" : "active"
  };
}

export function publicMarketplaceOrigin(origin = {}) {
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) return null;
  return compact({
    listing_id: safeId(origin.listing_id, 160),
    source_agent_id: safeId(origin.source_agent_id, 160),
    source_agent_workspace_id: safeId(origin.source_agent_workspace_id, 160),
    publisher_id: PUBLISHER_ID_RE.test(String(origin.publisher_id || "")) ? origin.publisher_id : null,
    publisher_display_name: safeDisplayName(origin.publisher_display_name, ""),
    publisher_status: origin.publisher_status === "deleted" ? "deleted" : "active",
    copied_at: safeTimestamp(origin.copied_at)
  });
}

export function normalizeMarketplacePublisherIdentities(data) {
  data.users = Array.isArray(data.users) ? data.users : [];
  const used = new Set();
  for (const user of data.users) {
    if (!user || typeof user !== "object") continue;
    const existing = String(user.public_publisher_id || "");
    if (PUBLISHER_ID_RE.test(existing) && !used.has(existing)) {
      used.add(existing);
    } else {
      user.public_publisher_id = createPublisherId(used);
      used.add(user.public_publisher_id);
    }
  }

  const owners = new Map(data.users
    .filter((user) => user?.user_id && PUBLISHER_ID_RE.test(String(user.public_publisher_id || "")))
    .map((user) => [String(user.user_id), user.public_publisher_id]));

  for (const subject of marketplaceSubjects(data)) {
    const marketplace = subject.marketplace;
    const ownerId = String(marketplace.published_by || subject.created_by || "").trim();
    let publisherId = owners.get(ownerId);
    const stored = String(marketplace.publisher_id || "");
    if (!publisherId && PUBLISHER_ID_RE.test(stored) && !used.has(stored)) {
      publisherId = stored;
    }
    if (!publisherId) publisherId = createPublisherId(used);
    owners.set(ownerId, publisherId);
    used.add(publisherId);
    marketplace.publisher_id = publisherId;
    marketplace.publisher_display_name = resolvedPublisherDisplayName(data, {
      ownerId,
      storedDisplayName: marketplace.publisher_display_name
    });
  }

  for (const agent of data.agents || []) {
    if (agent?.marketplace_origin) {
      agent.marketplace_origin = normalizeOrigin(agent.marketplace_origin, owners, used);
    }
  }
  for (const workspace of data.agentWorkspaces || []) {
    if (workspace?.marketplace_origin) {
      workspace.marketplace_origin = normalizeOrigin(workspace.marketplace_origin, owners, used);
    }
  }
  for (const workflow of data.workflows || []) {
    for (const node of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
      if (node?.source !== "marketplace") continue;
      const legacyOwner = String(node.publisher_user_id || node.publisher || "").trim();
      const current = String(node.publisher_id || "");
      const publisherId = PUBLISHER_ID_RE.test(current)
        ? current
        : owners.get(legacyOwner) || createPublisherId(used);
      used.add(publisherId);
      node.publisher_id = publisherId;
      node.publisher = publisherId;
      node.publisher_display_name = safeDisplayName(node.publisher_display_name, legacyOwner) || COMMUNITY_PUBLISHER_NAME;
      delete node.publisher_user_id;
      delete node.publisher_workspace_id;
    }
  }
  return data;
}

export function scrubDeletedPublisherReferences(data, {
  ownerId,
  publisherIds = [],
  listingIds = []
} = {}) {
  const owners = new Set([String(ownerId || "")].filter(Boolean));
  const publicIds = new Set((publisherIds || []).map(String).filter(Boolean));
  const listings = new Set((listingIds || []).map(String).filter(Boolean));
  const matches = (value = {}) => (
    owners.has(String(value.publisher_user_id || ""))
    || publicIds.has(String(value.publisher_id || ""))
    || listings.has(String(value.listing_id || ""))
  );
  let scrubbed = 0;
  const scrubOrigin = (origin) => {
    if (!origin || !matches(origin)) return origin;
    scrubbed += 1;
    const safe = publicMarketplaceOrigin(origin) || {};
    delete safe.publisher_id;
    safe.publisher_display_name = DELETED_PUBLISHER_NAME;
    safe.publisher_status = "deleted";
    return safe;
  };
  for (const agent of data.agents || []) {
    if (agent?.marketplace_origin) agent.marketplace_origin = scrubOrigin(agent.marketplace_origin);
  }
  for (const workspace of data.agentWorkspaces || []) {
    if (workspace?.marketplace_origin) workspace.marketplace_origin = scrubOrigin(workspace.marketplace_origin);
  }
  for (const workflow of data.workflows || []) {
    for (const node of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
      if (node?.source !== "marketplace") continue;
      if (!matches({
        publisher_user_id: node.publisher_user_id || (owners.has(String(node.publisher || "")) ? node.publisher : null),
        publisher_id: node.publisher_id || (publicIds.has(String(node.publisher || "")) ? node.publisher : null),
        listing_id: node.listing_id
      })) continue;
      scrubbed += 1;
      delete node.publisher_id;
      delete node.publisher_user_id;
      delete node.publisher_workspace_id;
      node.publisher = null;
      node.publisher_display_name = DELETED_PUBLISHER_NAME;
      node.publisher_status = "deleted";
    }
  }
  return scrubbed;
}

function normalizeOrigin(origin, owners, used) {
  const legacyOwner = String(origin.publisher_user_id || "").trim();
  let publisherId = PUBLISHER_ID_RE.test(String(origin.publisher_id || ""))
    ? origin.publisher_id
    : owners.get(legacyOwner);
  if (!publisherId) publisherId = createPublisherId(used);
  used.add(publisherId);
  return compact({
    listing_id: safeId(origin.listing_id, 160),
    source_agent_id: safeId(origin.source_agent_id, 160),
    source_agent_workspace_id: safeId(origin.source_agent_workspace_id, 160),
    publisher_id: publisherId,
    publisher_display_name: safeDisplayName(origin.publisher_display_name, legacyOwner) || COMMUNITY_PUBLISHER_NAME,
    publisher_status: origin.publisher_status === "deleted" ? "deleted" : "active",
    copied_at: safeTimestamp(origin.copied_at)
  });
}

function collectPublisherIds(data) {
  return new Set([
    ...(data.users || []).map((user) => user?.public_publisher_id),
    ...marketplaceSubjects(data).map((subject) => subject.marketplace?.publisher_id)
  ].filter((value) => PUBLISHER_ID_RE.test(String(value || ""))));
}

function marketplaceSubjects(data) {
  return [...(data.agents || []), ...(data.agentWorkspaces || [])]
    .filter((subject) => subject?.marketplace && typeof subject.marketplace === "object" && !Array.isArray(subject.marketplace));
}

function resolvedPublisherDisplayName(data, { ownerId, storedDisplayName }) {
  const user = (data.users || []).find((candidate) => String(candidate?.user_id || "") === String(ownerId || ""));
  const candidate = safeDisplayName(user?.display_name, ownerId)
    || safeDisplayName(storedDisplayName, ownerId);
  return candidate || COMMUNITY_PUBLISHER_NAME;
}

function safeDisplayName(value, privateOwnerId) {
  const text = String(value || "").replaceAll("\0", "").trim().slice(0, 80);
  if (!text || text === String(privateOwnerId || "")) return "";
  return text;
}

function safeId(value, limit) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text.slice(0, limit) : null;
}

function safeTimestamp(value) {
  const text = String(value || "").trim();
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== null && child !== undefined && child !== ""));
}
