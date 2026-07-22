import { describe, expect, it } from "vitest";

import {
  buildWorkflowDiscoveryArguments,
  completedSourceDiscovery,
  planWorkflowSourceDiscovery,
  publicSourceDiscovery,
  selectWorkflowDiscoveryTool,
  sourceObservationForComposer,
  workflowDesignDependsOnSource,
  workflowDiscoveryToolIsSafe
} from "../server/workflowSourceDiscovery.js";

const SOURCE_SCENARIOS = [
  ["Gmail complaint triage", "Create agents based on incoming Gmail complaint emails after reading Gmail.", ["gmail"]],
  ["Drive policy library", "Build an agent team based on the files found after reading Google Drive documents.", ["google_drive"]],
  ["Calendar workload", "Choose specialist roles based on availability after reviewing Google Calendar events.", ["google_calendar"]],
  ["Chat support themes", "Create agents based on recurring themes after reading Google Chat messages.", ["google_chat"]],
  ["Contacts outreach", "Assemble an agent team based on the directory after inspecting Google Contacts.", ["google_contacts"]],
  ["GitHub issue triage", "Configure agents based on repository work after reading GitHub issues and pull requests.", ["github"]],
  ["Slack feedback", "Create specialist roles based on customer themes after searching Slack messages.", ["slack"]],
  ["Notion knowledge", "Build agents based on the company wiki after reviewing Notion pages.", ["notion"]],
  ["Linear backlog", "Select agents based on delivery bottlenecks after reading Linear issues and projects.", ["linear"]],
  ["Shopify operations", "Create an agent team based on store activity after inspecting Shopify orders and inventory.", ["shopify"]],
  ["Salesforce pipeline", "Choose agents based on customer patterns after reviewing Salesforce cases and opportunities.", ["salesforce"]],
  ["Zendesk support", "Create specialist agents based on support demand after reading Zendesk tickets.", ["zendesk"]],
  ["Jira engineering", "Build a team based on engineering work after searching Jira issues and projects.", ["jira"]],
  ["Email and stock", "Create agents based on customer needs after reading Gmail complaints and Shopify inventory.", ["gmail", "shopify"]],
  ["Code and discussion", "Assemble agents based on release risk after reading GitHub pull requests and Slack messages.", ["github", "slack"]],
  ["Two knowledge bases", "Choose agents based on internal guidance after searching Google Drive files and Notion pages.", ["google_drive", "notion"]],
  ["Scheduling and people", "Build specialist roles based on staffing needs after reviewing Google Calendar availability and Google Contacts.", ["google_calendar", "google_contacts"]],
  ["Customer systems", "Create agents based on unresolved customer needs after reading Salesforce cases and Zendesk tickets.", ["salesforce", "zendesk"]],
  ["Delivery systems", "Configure an agent team based on delivery work after reviewing Linear issues and Jira projects.", ["linear", "jira"]],
  ["Cross-channel operations", "Create agents based on active work after reading Gmail, Google Drive files, and Slack messages.", ["gmail", "google_drive", "slack"]]
];

describe("source-first workflow discovery", () => {
  it("uses an explicit Gmail source contract without reading request wording", () => {
    const plan = planWorkflowSourceDiscovery({
      intent: "Analyze my incoming emails and create agents based on their content to produce a result.",
      workflow_contract: sourceContract(["gmail"]),
      connections: [readyConnection("gmail")]
    });
    expect(plan).toMatchObject({
      required: true,
      status: "ready",
      requests: [expect.objectContaining({ provider_id: "gmail", required_before_agent_design: true })]
    });
  });

  it("produces the same source plan for unrelated wording under the same contract", () => {
    const workflowContract = sourceContract(["gmail"]);
    const connections = [readyConnection("gmail")];
    const first = planWorkflowSourceDiscovery({
      intent: "Send mail and inspect the inbox immediately.",
      workflow_contract: workflowContract,
      connections
    });
    const second = planWorkflowSourceDiscovery({
      intent: "Ultraviolet xylophone quality review.",
      workflow_contract: workflowContract,
      connections
    });
    expect(first).toEqual(second);
    expect(planWorkflowSourceDiscovery({
      intent: "Send mail and inspect the inbox immediately.",
      workflow_contract: sourceContract([], { required: false }),
      connections
    })).toBeNull();
  });

  it.each(SOURCE_SCENARIOS)("plans the %s scenario before agent design", (_name, _intent, expectedProviders) => {
    const connections = expectedProviders.map(readyConnection);
    const workflowContract = sourceContract(expectedProviders);
    expect(workflowDesignDependsOnSource(workflowContract)).toBe(true);

    const plan = planWorkflowSourceDiscovery({ workflow_contract: workflowContract, connections });

    expect(plan).not.toBeNull();
    expect(plan.status).toBe("ready");
    expect(plan.requests.map((request) => request.provider_id)).toEqual(expectedProviders);
    expect(plan.requests.every((request) => (
      request.required_before_agent_design === true
      && request.read_only === true
      && request.connection_id === `connection_${request.provider_id}`
    ))).toBe(true);
  });

  it("does not silently truncate an explicit thirteen-service inspection", () => {
    const providers = [
      "gmail", "google_drive", "google_calendar", "google_chat", "google_contacts",
      "github", "slack", "notion", "linear", "shopify", "salesforce", "zendesk", "jira"
    ];
    const plan = planWorkflowSourceDiscovery({ workflow_contract: sourceContract(providers), connections: [] });
    expect(plan.requests.map((request) => request.provider_id)).toEqual([
      "gmail", "google_drive", "google_calendar", "google_chat", "google_contacts",
      "github", "slack", "notion", "linear", "shopify", "salesforce", "zendesk", "jira"
    ]);
  });

  it("fills an optional query so a discovery read is bounded by more than a limit", () => {
    const request = sourceRequest("gmail");
    const tool = readTool("gmail", {
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", maximum: 100 }
        }
      }
    });
    expect(buildWorkflowDiscoveryArguments(tool, request)).toEqual({
      query: request.query,
      limit: 50
    });
    expect(selectWorkflowDiscoveryTool(readyConnection("gmail", [tool]), request)?.tool.name).toBe(tool.name);
  });

  it("rejects a limit-only account-wide read", () => {
    const request = sourceRequest("slack");
    const tool = readTool("slack", {
      input_schema: {
        type: "object",
        properties: { limit: { type: "integer", maximum: 100 } }
      }
    });
    expect(buildWorkflowDiscoveryArguments(tool, request)).toBeNull();
    expect(selectWorkflowDiscoveryTool(readyConnection("slack", [tool]), request)).toBeNull();
  });

  it("rejects a falsely labeled Gmail create-draft tool", () => {
    const request = sourceRequest("gmail");
    const disguisedWrite = readTool("gmail", {
      name: "gmail_create_draft",
      title: "Draft reply"
    });
    expect(workflowDiscoveryToolIsSafe(disguisedWrite)).toBe(false);
    expect(selectWorkflowDiscoveryTool(readyConnection("gmail", [disguisedWrite]), request)).toBeNull();
  });

  it("rejects every mutating or approval-gated contract even when metadata says read", () => {
    for (const name of ["shopify_update_inventory", "jira_archive_issue", "slack_post_message", "notion_edit_page"]) {
      expect(workflowDiscoveryToolIsSafe(readTool("generic", { name }))).toBe(false);
    }
    expect(workflowDiscoveryToolIsSafe(readTool("gmail", { risk: "write" }))).toBe(false);
    expect(workflowDiscoveryToolIsSafe(readTool("gmail", { requires_approval: true }))).toBe(false);
  });

  it.each([
    ["gmail_draft_reply", "Search Gmail", "Find matching messages."],
    ["execute_customer_action", "Find records", "Find matching records."],
    ["manage_inventory", "List inventory", "List current inventory."],
    ["mark_message_read", "Read message", "Read a message."],
    ["purge_records", "Search records", "Search historical records."],
    ["search_messages", "Search messages", "Search messages and update their status."],
    ["list_orders", "List orders", "List orders, then delete completed records."]
  ])("rejects disguised source-discovery writes: %s", (name, title, description) => {
    const tool = readTool("gmail", { name, title, description });
    expect(workflowDiscoveryToolIsSafe(tool)).toBe(false);
    expect(selectWorkflowDiscoveryTool(readyConnection("gmail", [tool]), sourceRequest("gmail"))).toBeNull();
  });

  it("builds bounded arguments for captured Gmail and Calendar camelCase schemas", () => {
    const gmailRequest = sourceRequest("gmail");
    const gmail = readTool("gmail", {
      name: "search_gmail_messages",
      input_schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          maxResults: { type: "integer", minimum: 1, maximum: 100 }
        }
      }
    });
    expect(buildWorkflowDiscoveryArguments(gmail, gmailRequest)).toEqual({
      query: gmailRequest.query,
      maxResults: 50
    });

    const calendarRequest = sourceRequest("google_calendar");
    const calendar = readTool("google_calendar", {
      name: "list_calendar_events",
      input_schema: {
        type: "object",
        required: ["calendarId", "timeMin", "timeMax"],
        properties: {
          calendarId: { type: "string" },
          timeMin: { type: "string" },
          timeMax: { type: "string" },
          maxResults: { type: "integer", maximum: 250 }
        }
      }
    });
    const args = buildWorkflowDiscoveryArguments(calendar, calendarRequest, new Date("2026-07-18T12:00:00.000Z"));
    expect(args).toEqual({
      calendarId: "primary",
      timeMin: "2026-07-04T12:00:00.000Z",
      timeMax: "2026-07-18T12:00:00.000Z",
      maxResults: 50
    });
  });

  it("rejects a captured GitHub contract that requires an opaque camelCase repository id", () => {
    const request = sourceRequest("github");
    const github = readTool("github", {
      name: "search_repository_issues",
      input_schema: {
        type: "object",
        required: ["repositoryId", "query"],
        properties: {
          repositoryId: { type: "string" },
          query: { type: "string" },
          maxResults: { type: "integer", maximum: 100 }
        }
      }
    });
    expect(buildWorkflowDiscoveryArguments(github, request)).toBeNull();
    expect(selectWorkflowDiscoveryTool(readyConnection("github", [github]), request)).toBeNull();
  });

  it("plans only exact provider ids declared by the contract", () => {
    expect(planWorkflowSourceDiscovery({
      intent: "Create agents based on incoming messages after reading Slack messages.",
      workflow_contract: sourceContract(["slack"]),
      connections: []
    }).requests.map((item) => item.provider_id)).toEqual(["slack"]);
    expect(planWorkflowSourceDiscovery({
      intent: "Create agents based on unread messages after reading Google Chat messages.",
      workflow_contract: sourceContract(["google_chat"]),
      connections: []
    }).requests.map((item) => item.provider_id)).toEqual(["google_chat"]);
    expect(planWorkflowSourceDiscovery({
      intent: "Create agents based on incoming Outlook emails after reading Microsoft Exchange.",
      workflow_contract: sourceContract(["microsoft_exchange"]),
      connections: []
    })).toBeNull();
  });

  it("rejects required opaque resource identifiers that cannot be guessed safely", () => {
    const request = sourceRequest("github");
    const tool = readTool("github", {
      input_schema: {
        type: "object",
        required: ["repository_id"],
        properties: {
          repository_id: { type: "string" },
          query: { type: "string" }
        }
      }
    });
    expect(buildWorkflowDiscoveryArguments(tool, request)).toBeNull();
  });

  it("does not copy the workflow prompt into an unknown required string field", () => {
    const request = sourceRequest("jira");
    const tool = readTool("jira", {
      input_schema: {
        type: "object",
        required: ["request_body"],
        properties: {
          request_body: { type: "string" },
          limit: { type: "integer", maximum: 50 }
        }
      }
    });
    expect(buildWorkflowDiscoveryArguments(tool, request)).toBeNull();
  });

  it("uses a bounded server-authored Jira query instead of natural-language prompt text", () => {
    const request = sourceRequest("jira");
    const tool = readTool("jira", {
      input_schema: {
        type: "object",
        required: ["jql"],
        properties: {
          jql: { type: "string" },
          limit: { type: "integer", maximum: 50 }
        }
      }
    });
    expect(buildWorkflowDiscoveryArguments(tool, request)).toEqual({
      jql: "updated >= -14d ORDER BY updated DESC",
      limit: 50
    });
  });

  it("prefers a compatible safe search over a higher-keyword mutating tool", () => {
    const request = sourceRequest("shopify");
    const selected = selectWorkflowDiscoveryTool(readyConnection("shopify", [
      readTool("shopify", { name: "shopify_update_inventory_search" }),
      readTool("shopify", { name: "search_shopify_inventory" })
    ]), request);
    expect(selected.tool.name).toBe("search_shopify_inventory");
  });

  it("keeps raw source content transient and exposes only bounded proof metadata", () => {
    const plan = planWorkflowSourceDiscovery({
      workflow_contract: sourceContract(["gmail"]),
      connections: [readyConnection("gmail")]
    });
    const request = plan.requests[0];
    const connection = readyConnection("gmail");
    const tool = connection.tools[0];
    const privateMarker = "customer-private-987@example.com";
    const observation = sourceObservationForComposer({
      request,
      connection,
      tool,
      result: { category: "damaged product", privateMarker }
    });
    expect(observation.trust).toBe("external_untrusted_data");
    expect(observation.content).toContain(privateMarker);
    expect(observation.content_digest).toMatch(/^[a-f0-9]{64}$/);

    const durable = completedSourceDiscovery(plan, [observation]);
    const publicValue = publicSourceDiscovery(durable);
    expect(JSON.stringify(durable)).not.toContain(privateMarker);
    expect(JSON.stringify(publicValue)).not.toContain(privateMarker);
    expect(publicValue.requests[0]).toMatchObject({
      provider_id: "gmail",
      status: "completed",
      result_digest: observation.content_digest
    });
    expect(publicValue.requests[0]).not.toHaveProperty("query");
    expect(publicValue.requests[0]).not.toHaveProperty("content");
  });

  it("does not trigger source-first mode without an affirmative structured source contract", () => {
    for (const intent of [
      "Tell me what agents could help with email.",
      "Create an agent that summarizes the attached document.",
      "Analyze the following pasted email and propose a reply.",
      "Build a workflow for customer support."
    ]) {
      expect(workflowDesignDependsOnSource(null)).toBe(false);
      expect(planWorkflowSourceDiscovery({ intent, connections: [] })).toBeNull();
      const disabled = sourceContract([], { required: false });
      expect(workflowDesignDependsOnSource(disabled)).toBe(false);
      expect(planWorkflowSourceDiscovery({ intent, workflow_contract: disabled, connections: [] })).toBeNull();
    }
  });
});

function sourceRequest(providerId) {
  const connection = readyConnection(providerId);
  const plan = planWorkflowSourceDiscovery({
    workflow_contract: sourceContract([providerId]),
    connections: [connection]
  });
  return plan.requests[0];
}

function sourceContract(providerIds, { required = true } = {}) {
  return {
    contract_version: "virenis-workflow-semantic-contract-v1",
    providers: providerIds.map((providerId) => ({
      provider_id: providerId,
      access: "read",
      reason: "Bounded source inspection",
      permissions: ["read bounded records"],
      tool_keywords: ["search", "list", "read"]
    })),
    source_discovery: {
      required_before_agent_design: required,
      requests: required ? providerIds.map((providerId) => ({
        provider_id: providerId,
        name: providerLabel(providerId),
        purpose: "Infer durable roles from bounded source categories.",
        query: providerId === "gmail" ? "in:inbox newer_than:14d" : "recent relevant records",
        tool_keywords: ["search", "list", "read"],
        max_items: 50
      })) : []
    }
  };
}

function readyConnection(providerId, tools = [readTool(providerId)]) {
  return {
    connection_id: `connection_${providerId}`,
    provider_id: providerId,
    template_id: providerId,
    name: providerLabel(providerId),
    status: "ready",
    tools
  };
}

function readTool(providerId, overrides = {}) {
  return {
    name: `search_${providerId}_records`,
    title: `Search ${providerLabel(providerId)}`,
    description: "Search a bounded set of records.",
    risk: "read",
    requires_approval: false,
    schema_digest: `schema_${providerId}`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", maximum: 50 }
      }
    },
    ...overrides
  };
}

function providerLabel(providerId) {
  return ({
    gmail: "Gmail",
    google_drive: "Google Drive files",
    google_calendar: "Google Calendar events",
    google_chat: "Google Chat messages",
    google_contacts: "Google Contacts",
    github: "GitHub issues",
    slack: "Slack messages",
    notion: "Notion pages",
    linear: "Linear issues",
    shopify: "Shopify orders",
    salesforce: "Salesforce cases",
    zendesk: "Zendesk tickets",
    jira: "Jira issues"
  })[providerId] || providerId;
}
