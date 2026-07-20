export function workspacePayloadDiffers(workspace, payload) {
  if (!workspace) return true;
  return workspace.name !== payload.name
    || (workspace.description || "") !== (payload.description || "")
    || JSON.stringify(workspace.agent_ids || []) !== JSON.stringify(payload.agent_ids || []);
}
