export async function loadAuthenticatedResourceBatch(apiClient, resourcePaths) {
  if (!apiClient?.get) throw new TypeError("An API client with a get method is required.");
  const identity = await apiClient.get("/api/auth/me");
  const resources = await Promise.allSettled(
    resourcePaths.map((path) => apiClient.get(path))
  );
  return { identity, resources };
}
