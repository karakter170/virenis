const PAGINATED_COLLECTIONS = new Map([
  ["/api/chat/sessions", "sessions"],
  ["/api/agents", "agents"],
  ["/api/documents", "documents"],
  ["/api/marketplace", "items"]
]);
const MAX_BOOTSTRAP_COLLECTION_ITEMS = 10_000;

export async function loadCompleteResource(apiClient, resourcePath) {
  const first = await apiClient.get(resourcePath);
  const parsed = new URL(resourcePath, "http://virenis.local");
  const collectionKey = PAGINATED_COLLECTIONS.get(parsed.pathname);
  if (!collectionKey || !Array.isArray(first?.[collectionKey])) return first;
  const total = Number(first.total);
  const firstOffset = Number(first.offset || 0);
  const firstLimit = Number(first.limit || first[collectionKey].length || 0);
  if (!Number.isSafeInteger(total) || total <= first[collectionKey].length || firstOffset !== 0) return first;
  if (total > MAX_BOOTSTRAP_COLLECTION_ITEMS) {
    throw new Error(`This workspace has ${total} ${collectionKey}; refine the collection before loading it.`);
  }

  const combined = [...first[collectionKey]];
  let offset = combined.length;
  const pageSize = Math.max(1, Math.min(500, firstLimit || 100));
  while (offset < total) {
    parsed.searchParams.set("limit", String(Math.min(pageSize, total - offset)));
    parsed.searchParams.set("offset", String(offset));
    const pagePath = `${parsed.pathname}${parsed.search}`;
    const page = await apiClient.get(pagePath);
    const rows = Array.isArray(page?.[collectionKey]) ? page[collectionKey] : [];
    if (!rows.length) {
      throw new Error(`The ${collectionKey} collection changed while it was loading. Refresh and try again.`);
    }
    combined.push(...rows);
    offset = combined.length;
  }
  return { ...first, [collectionKey]: combined, limit: combined.length, offset: 0 };
}

export async function loadAuthenticatedResourceBatch(apiClient, resourcePaths) {
  if (!apiClient?.get) throw new TypeError("An API client with a get method is required.");
  const identity = await apiClient.get("/api/auth/me");
  const resources = await Promise.allSettled(
    resourcePaths.map((path) => loadCompleteResource(apiClient, path))
  );
  return { identity, resources };
}
