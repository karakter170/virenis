# Agent workspaces

Agent workspaces are per-user agent teams. They are intentionally separate from
the identity tenant stored in `workspace_id`:

- `workspace_id` remains the security, billing, and data-isolation boundary.
- `agent_workspace_id` identifies the selected team inside that boundary.
- Each user receives one undeletable `General` agent workspace and may create
  private custom workspaces.
- A workspace can contain at most 16 agents. Capacity reservations make this
  limit safe when agent registrations or workflow activations happen
  concurrently.

## Session and routing behavior

New Studio chats select an agent workspace explicitly. The session stores that
selection, and every queued run snapshots it so changing the UI while a run is
in flight cannot change that run's agent boundary. The web controller sends the
Runtime an `allowed_adapters` list derived from the selected workspace. Chat
documents and knowledge-resource agents retain their existing session and
ownership checks.

Older API sessions that have no `agent_workspace_id` keep their legacy routing
behavior until a workspace is selected. This prevents a deployment migration
from silently changing an already open conversation.

`PATCH /api/chat/sessions/:session_id/agent-workspace` switches the active team
without clearing messages, shared memory, checkpoints, or MCP continuation
state. Activating a workflow switches its session back to the workspace chosen
when that workflow was composed.

## Commands

The web composer intercepts `/workflow` and `/agent` before submission and asks
the user to choose an existing workspace or create a new one. The selected
workspace is stored on the workflow draft. Generated agents, Marketplace
copies, and handoffs are committed to that workspace only after confirmation.
Legacy API clients that do not select a workspace receive a dedicated workspace
when they approve the draft.

## Marketplace

Agent workspaces can be published, described, rated, unpublished, and copied.
The listing snapshot includes at most 16 sanitized agent contracts and the
handoffs between them. It excludes source text, uploaded/private knowledge,
credentials, MCP bindings, and live connection identifiers. Copying creates an
independent workspace, independent agents, and remapped handoffs. Self-ratings
are rejected, and only the publisher can edit or unpublish the listing.

## API summary

- `GET /api/agent-workspaces`
- `POST /api/agent-workspaces`
- `GET /api/agent-workspaces/:agent_workspace_id`
- `PATCH /api/agent-workspaces/:agent_workspace_id`
- `DELETE /api/agent-workspaces/:agent_workspace_id`
- `PATCH /api/chat/sessions/:session_id/agent-workspace`
- Existing `/api/marketplace/items/:id` publish, detail, rating, copy, and
  unpublish routes accept both `agent` and `workspace` items.

Custom workspace deletion never deletes its agents. Sessions selecting the
deleted workspace move to the owner's General workspace. General itself cannot
be renamed or deleted.
