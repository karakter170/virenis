import crypto from "node:crypto";

const MICROS_PER_CREDIT = 1_000_000;
const TOKENS_PER_RATE_UNIT = 1_000;
const MAX_SAFE_MICROS = 9_000_000_000_000_000;
const MAX_ACCOUNT_CREDITS = 1_000_000_000;
const MAX_TOKEN_CALLS = 256;
const MAX_TOKENS_PER_CALL = 100_000_000;
const DEFAULT_WELCOME_CREDITS = "1000";
const DEFAULT_PROMPT_CREDITS_PER_1K = "0.10";
const DEFAULT_COMPLETION_CREDITS_PER_1K = "0.20";
const DEFAULT_CACHED_CREDITS_PER_1K = "0.02";
const DEFAULT_MINIMUM_RESERVATION_CREDITS = "0.10";

export class BillingError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ensureBillingCollections(data) {
  data.billingAccounts ||= [];
  data.billingPricingVersions ||= [];
  data.billingLedgerEntries ||= [];
  data.billingReservations ||= [];
  data.billingUsageRecords ||= [];
  data.billingFundingEvents ||= [];
  return data;
}

export function ensureBillingAccount(data, actor, { welcomeGrant = true } = {}) {
  ensureBillingCollections(data);
  const identity = billingIdentity(actor);
  let account = data.billingAccounts.find((candidate) => (
    candidate.workspace_id === identity.workspace_id
    && candidate.user_id === identity.user_id
  ));
  if (account) return account;

  const now = new Date().toISOString();
  account = {
    account_id: stableId("billing_account", identity.workspace_id, identity.user_id),
    workspace_id: identity.workspace_id,
    user_id: identity.user_id,
    unit: "credit",
    available_micros: 0,
    reserved_micros: 0,
    lifetime_credited_micros: 0,
    lifetime_debited_micros: 0,
    status: "active",
    revision: 0,
    ledger_head_hash: null,
    created_at: now,
    updated_at: now
  };
  data.billingAccounts.push(account);
  if (welcomeGrant) {
    const amountMicros = parseCredits(
      process.env.APP_BILLING_WELCOME_CREDITS ?? DEFAULT_WELCOME_CREDITS,
      "APP_BILLING_WELCOME_CREDITS",
      { allowZero: true }
    );
    if (amountMicros > 0) {
      appendLedgerEntry(data, account, {
        type: "welcome_grant",
        availableDeltaMicros: amountMicros,
        reservedDeltaMicros: 0,
        creditedMicros: amountMicros,
        reference: `welcome:${account.account_id}`,
        actorId: "system",
        metadata: { source: "account_creation" }
      });
    }
  }
  return account;
}

export function publicBillingAccount(account, { recentEntries = [] } = {}) {
  if (!account) return null;
  return {
    account_id: account.account_id,
    workspace_id: account.workspace_id,
    user_id: account.user_id,
    unit: "credit",
    status: account.status,
    balance_micros: safeMicros(account.available_micros, "Account balance", { allowNegative: true }),
    balance_credits: formatCredits(account.available_micros),
    reserved_micros: safeMicros(account.reserved_micros, "Reserved balance"),
    reserved_credits: formatCredits(account.reserved_micros),
    lifetime_credited_micros: safeMicros(account.lifetime_credited_micros, "Lifetime credits"),
    lifetime_credited_credits: formatCredits(account.lifetime_credited_micros),
    lifetime_debited_micros: safeMicros(account.lifetime_debited_micros, "Lifetime usage"),
    lifetime_debited_credits: formatCredits(account.lifetime_debited_micros),
    revision: Number(account.revision) || 0,
    updated_at: account.updated_at,
    recent_entries: recentEntries.map(publicLedgerEntry)
  };
}

export function billingAccountSnapshot(data, actor, { recentLimit = 20 } = {}) {
  const account = ensureBillingAccount(data, actor);
  const entries = data.billingLedgerEntries
    .filter((entry) => entry.account_id === account.account_id)
    .slice(-boundedInteger(recentLimit, 20, 0, 100))
    .reverse();
  return {
    account: publicBillingAccount(account, { recentEntries: entries }),
    pricing: publicPricingVersion(activePricingVersion(data))
  };
}

export function listBillingAccounts(data) {
  ensureBillingCollections(data);
  return data.billingAccounts
    .map((account) => publicBillingAccount(account))
    .sort((left, right) => left.user_id.localeCompare(right.user_id));
}

export function listBillingLedger(data, actor, { limit = 50, offset = 0 } = {}) {
  const account = ensureBillingAccount(data, actor);
  const boundedLimit = boundedInteger(limit, 50, 1, 200);
  const boundedOffset = boundedInteger(offset, 0, 0, 1_000_000);
  const all = data.billingLedgerEntries
    .filter((entry) => entry.account_id === account.account_id)
    .slice()
    .reverse();
  return {
    account: publicBillingAccount(account),
    entries: all.slice(boundedOffset, boundedOffset + boundedLimit).map(publicLedgerEntry),
    total: all.length,
    limit: boundedLimit,
    offset: boundedOffset,
    integrity_valid: verifyBillingLedger(data, account.account_id).valid
  };
}

export function activePricingVersion(data) {
  ensureBillingCollections(data);
  if (data.billingPricingVersions.length === 0) {
    const createdAt = new Date().toISOString();
    data.billingPricingVersions.push({
      pricing_version_id: stableId("billing_pricing", "default-v1"),
      schema_version: "virenis-credit-pricing-v1",
      supersedes_version_id: null,
      rules: [{
        model_pattern: "*",
        prompt_micros_per_1k: parseCredits(process.env.APP_BILLING_PROMPT_CREDITS_PER_1K ?? DEFAULT_PROMPT_CREDITS_PER_1K, "Default prompt rate", { allowZero: true }),
        completion_micros_per_1k: parseCredits(process.env.APP_BILLING_COMPLETION_CREDITS_PER_1K ?? DEFAULT_COMPLETION_CREDITS_PER_1K, "Default completion rate", { allowZero: true }),
        cached_micros_per_1k: parseCredits(process.env.APP_BILLING_CACHED_CREDITS_PER_1K ?? DEFAULT_CACHED_CREDITS_PER_1K, "Default cached rate", { allowZero: true }),
        unclassified_micros_per_1k: parseCredits(process.env.APP_BILLING_UNCLASSIFIED_CREDITS_PER_1K ?? process.env.APP_BILLING_COMPLETION_CREDITS_PER_1K ?? DEFAULT_COMPLETION_CREDITS_PER_1K, "Default unclassified rate", { allowZero: true })
      }],
      minimum_reservation_micros: parseCredits(process.env.APP_BILLING_MINIMUM_RESERVATION_CREDITS ?? DEFAULT_MINIMUM_RESERVATION_CREDITS, "Default minimum reservation", { allowZero: true }),
      created_by: "system",
      created_at: createdAt,
      reason: "Initial server-owned pricing"
    });
  }
  return data.billingPricingVersions[data.billingPricingVersions.length - 1];
}

export function createPricingVersion(data, { actor, body = {}, idempotencyKey }) {
  ensureBillingCollections(data);
  const safeKey = requireIdempotencyKey(idempotencyKey);
  const digest = idempotencyDigest("pricing", safeKey);
  const requested = pricingPayload(body);
  const payloadDigest = digestValue(requested);
  const existing = data.billingPricingVersions.find((version) => version.idempotency_key_digest === digest);
  if (existing) {
    if (existing.request_digest !== payloadDigest) {
      throw new BillingError(409, "billing_idempotency_conflict", "This pricing idempotency key was already used for different values.");
    }
    return { pricing: publicPricingVersion(existing, { includeAudit: true }), duplicate: true };
  }
  const previous = activePricingVersion(data);
  const version = {
    pricing_version_id: makeId("pricing"),
    schema_version: "virenis-credit-pricing-v1",
    supersedes_version_id: previous.pricing_version_id,
    rules: mergedPricingRules(previous.rules, requested.rule),
    minimum_reservation_micros: requested.minimum_reservation_micros,
    created_by: billingIdentity(actor).user_id,
    created_at: new Date().toISOString(),
    reason: boundedText(body.reason, 500) || "Administrator pricing update",
    idempotency_key_digest: digest,
    request_digest: payloadDigest
  };
  data.billingPricingVersions.push(version);
  return { pricing: publicPricingVersion(version, { includeAudit: true }), duplicate: false };
}

export function publicPricingVersion(version, { includeAudit = false } = {}) {
  if (!version) return null;
  const result = {
    pricing_version_id: version.pricing_version_id,
    schema_version: version.schema_version,
    supersedes_version_id: version.supersedes_version_id || null,
    rules: (version.rules || []).map((rule) => ({
      model_pattern: rule.model_pattern,
      prompt_micros_per_1k: rule.prompt_micros_per_1k,
      prompt_credits_per_1k: formatCredits(rule.prompt_micros_per_1k),
      completion_micros_per_1k: rule.completion_micros_per_1k,
      completion_credits_per_1k: formatCredits(rule.completion_micros_per_1k),
      cached_micros_per_1k: rule.cached_micros_per_1k,
      cached_credits_per_1k: formatCredits(rule.cached_micros_per_1k),
      unclassified_micros_per_1k: rule.unclassified_micros_per_1k,
      unclassified_credits_per_1k: formatCredits(rule.unclassified_micros_per_1k)
    })),
    minimum_reservation_micros: version.minimum_reservation_micros,
    minimum_reservation_credits: formatCredits(version.minimum_reservation_micros),
    created_at: version.created_at,
    reason: version.reason
  };
  if (includeAudit) result.created_by = version.created_by;
  return result;
}

export function reserveRunCredits(data, { run, actor, options = {}, kind = "chat" }) {
  ensureBillingCollections(data);
  const account = ensureBillingAccount(data, actor);
  if (account.status !== "active") {
    throw new BillingError(403, "billing_account_unavailable", "This billing account is not active.");
  }
  const existing = data.billingReservations.find((reservation) => reservation.run_id === run.run_id);
  if (existing) {
    if (existing.account_id !== account.account_id) {
      throw new BillingError(409, "billing_reservation_conflict", "The run already belongs to another billing account.");
    }
    attachReservationToRun(run, existing, account);
    return existing;
  }
  const pricing = activePricingVersion(data);
  const estimated = estimateReservation(pricing, options, kind);
  if (account.available_micros < estimated.amount_micros) {
    throw new BillingError(402, "insufficient_balance", "Your balance is too low to start this request. Add credits or ask an administrator to adjust the balance.", {
      available_micros: account.available_micros,
      required_micros: estimated.amount_micros
    });
  }
  const reservation = {
    reservation_id: makeId("reservation"),
    account_id: account.account_id,
    workspace_id: account.workspace_id,
    user_id: account.user_id,
    run_id: run.run_id,
    kind,
    status: "active",
    authorized_micros: estimated.amount_micros,
    actual_charge_micros: null,
    pricing_version_id: pricing.pricing_version_id,
    pricing_snapshot: pricingSnapshot(pricing),
    estimated_token_ceiling: estimated.token_ceiling,
    created_at: new Date().toISOString(),
    settled_at: null,
    released_at: null
  };
  appendLedgerEntry(data, account, {
    type: "usage_reservation",
    availableDeltaMicros: -reservation.authorized_micros,
    reservedDeltaMicros: reservation.authorized_micros,
    reference: `reservation:${reservation.reservation_id}`,
    actorId: account.user_id,
    runId: run.run_id,
    pricingVersionId: pricing.pricing_version_id,
    metadata: { kind, estimated_token_ceiling: estimated.token_ceiling }
  });
  data.billingReservations.push(reservation);
  attachReservationToRun(run, reservation, account);
  return reservation;
}

export function settleRunCredits(data, run, rawTokenAccounting) {
  ensureBillingCollections(data);
  const reservation = data.billingReservations.find((candidate) => candidate.run_id === run?.run_id);
  if (!reservation) {
    run.billing = { status: "not_reserved", charged_micros: 0, charged_credits: formatCredits(0) };
    run.usage_receipt = buildUsageReceipt(rawTokenAccounting, zeroPricingVersion(), null);
    return run.usage_receipt;
  }
  const existing = data.billingUsageRecords.find((record) => record.reservation_id === reservation.reservation_id);
  if (existing) {
    run.usage_receipt = publicUsageRecord(existing);
    const account = billingAccountById(data, reservation.account_id);
    attachSettlementToRun(run, reservation, account, existing);
    return run.usage_receipt;
  }
  if (reservation.status !== "active") {
    throw new BillingError(409, "billing_reservation_not_active", "The run reservation is no longer active.");
  }
  const account = billingAccountById(data, reservation.account_id);
  const pricing = pricingById(data, reservation.pricing_version_id);
  const normalized = normalizeTokenAccounting(rawTokenAccounting);
  const priced = priceTokenCalls(normalized.calls, pricing);
  const chargeMicros = priced.total_charge_micros;
  const authorized = reservation.authorized_micros;
  appendLedgerEntry(data, account, {
    type: "usage_settlement",
    availableDeltaMicros: authorized - chargeMicros,
    reservedDeltaMicros: -authorized,
    debitedMicros: chargeMicros,
    allowNegative: chargeMicros > authorized,
    reference: `settlement:${reservation.reservation_id}`,
    actorId: "system",
    runId: run.run_id,
    pricingVersionId: pricing.pricing_version_id,
    metadata: {
      provider_reported: normalized.provider_reported,
      accounting_complete: normalized.complete,
      token_total: normalized.totals.total_tokens,
      overage_micros: Math.max(0, chargeMicros - authorized)
    }
  });
  const now = new Date().toISOString();
  reservation.status = "settled";
  reservation.actual_charge_micros = chargeMicros;
  reservation.settled_at = now;
  const record = {
    usage_record_id: makeId("usage"),
    reservation_id: reservation.reservation_id,
    account_id: reservation.account_id,
    workspace_id: reservation.workspace_id,
    user_id: reservation.user_id,
    run_id: run.run_id,
    status: normalized.calls.length === 0
      ? "unreported"
      : normalized.complete ? "charged" : "partial",
    pricing_version_id: pricing.pricing_version_id,
    token_accounting: normalized,
    component_costs: priced.components,
    total_charge_micros: chargeMicros,
    balance_after_micros: account.available_micros,
    created_at: now
  };
  data.billingUsageRecords.push(record);
  run.usage_receipt = publicUsageRecord(record);
  attachSettlementToRun(run, reservation, account, record);
  return run.usage_receipt;
}

export function releaseRunReservation(data, run, { reason = "run_failed" } = {}) {
  ensureBillingCollections(data);
  const reservation = data.billingReservations.find((candidate) => candidate.run_id === run?.run_id);
  if (!reservation) return null;
  if (reservation.status !== "active") return reservation;
  const account = billingAccountById(data, reservation.account_id);
  appendLedgerEntry(data, account, {
    type: "reservation_release",
    availableDeltaMicros: reservation.authorized_micros,
    reservedDeltaMicros: -reservation.authorized_micros,
    reference: `release:${reservation.reservation_id}`,
    actorId: "system",
    runId: run.run_id,
    pricingVersionId: reservation.pricing_version_id,
    metadata: { reason: boundedText(reason, 160) }
  });
  reservation.status = "released";
  reservation.released_at = new Date().toISOString();
  reservation.release_reason = boundedText(reason, 160);
  run.billing = {
    status: "released",
    reservation_id: reservation.reservation_id,
    charged_micros: 0,
    charged_credits: formatCredits(0),
    account_revision: account.revision,
    balance_after_micros: account.available_micros,
    balance_after_credits: formatCredits(account.available_micros),
    reserved_after_micros: account.reserved_micros,
    reserved_after_credits: formatCredits(account.reserved_micros)
  };
  return reservation;
}

export function createAdminAdjustment(data, {
  actor,
  targetUserId,
  targetWorkspaceId,
  amountCredits,
  reason,
  idempotencyKey
}) {
  ensureBillingCollections(data);
  const safeKey = requireIdempotencyKey(idempotencyKey);
  const target = billingIdentity({ user_id: targetUserId, workspace_id: targetWorkspaceId });
  const adminIdentity = billingIdentity(actor);
  const amountMicros = parseCredits(amountCredits, "Adjustment amount", { allowNegative: true, allowZero: false });
  const safeReason = boundedText(reason, 500);
  if (!safeReason) throw new BillingError(400, "billing_reason_required", "A reason is required for a balance adjustment.");
  const accountId = stableId("billing_account", target.workspace_id, target.user_id);
  const reference = `admin_adjustment:${idempotencyDigest("adjustment", safeKey)}`;
  const existing = data.billingLedgerEntries.find((entry) => entry.reference === reference);
  const requestDigest = digestValue({
    account_id: accountId,
    amount_micros: amountMicros,
    reason: safeReason
  });
  if (existing) {
    if (existing.metadata?.request_digest !== requestDigest) {
      throw new BillingError(409, "billing_idempotency_conflict", "This adjustment idempotency key was already used for another request.");
    }
    return {
      account: publicBillingAccount(billingAccountById(data, existing.account_id)),
      entry: publicLedgerEntry(existing),
      duplicate: true
    };
  }
  const account = ensureBillingAccount(data, target);
  if (amountMicros < 0 && account.available_micros + amountMicros < 0) {
    throw new BillingError(409, "billing_adjustment_exceeds_balance", "The adjustment would make the available balance negative.");
  }
  const entry = appendLedgerEntry(data, account, {
    type: "admin_adjustment",
    availableDeltaMicros: amountMicros,
    reservedDeltaMicros: 0,
    creditedMicros: amountMicros > 0 ? amountMicros : 0,
    debitedMicros: amountMicros < 0 ? -amountMicros : 0,
    reference,
    actorId: adminIdentity.user_id,
    metadata: { reason: safeReason, request_digest: requestDigest }
  });
  return { account: publicBillingAccount(account), entry: publicLedgerEntry(entry), duplicate: false };
}

export function recordFundingEvent(data, {
  actor,
  targetUserId,
  targetWorkspaceId,
  provider,
  externalReference,
  providerEventId,
  status,
  amountCredits,
  idempotencyKey
}) {
  ensureBillingCollections(data);
  const safeKey = requireIdempotencyKey(idempotencyKey);
  const target = billingIdentity({ user_id: targetUserId, workspace_id: targetWorkspaceId });
  const recordedBy = billingIdentity(actor).user_id;
  const safeProvider = boundedIdentifier(provider, "Funding provider", 80);
  const safeEventId = boundedIdentifier(providerEventId, "Provider event id", 200, /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/);
  const safeReference = boundedIdentifier(externalReference, "External funding reference", 200, /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/);
  const safeStatus = String(status || "").trim().toLowerCase();
  if (!new Set(["pending", "succeeded", "failed", "cancelled"]).has(safeStatus)) {
    throw new BillingError(400, "billing_funding_status_invalid", "Funding status must be pending, succeeded, failed, or cancelled.");
  }
  const amountMicros = parseCredits(amountCredits, "Funding amount", { allowZero: false });
  const accountId = stableId("billing_account", target.workspace_id, target.user_id);
  const eventIdentity = `${safeProvider}:${safeEventId}`;
  const request = {
    account_id: accountId,
    provider: safeProvider,
    external_reference: safeReference,
    provider_event_id: safeEventId,
    status: safeStatus,
    amount_micros: amountMicros
  };
  const requestDigest = digestValue(request);
  const existing = data.billingFundingEvents.find((event) => event.event_identity === eventIdentity);
  if (existing) {
    if (existing.request_digest !== requestDigest) {
      throw new BillingError(409, "billing_provider_event_conflict", "This provider event id was already recorded with different data.");
    }
    return { event: publicFundingEvent(existing), account: publicBillingAccount(billingAccountById(data, existing.account_id)), duplicate: true };
  }
  const keyDigest = idempotencyDigest("funding", safeKey);
  const keyReplay = data.billingFundingEvents.find((event) => event.idempotency_key_digest === keyDigest);
  if (keyReplay) {
    if (keyReplay.request_digest !== requestDigest) {
      throw new BillingError(409, "billing_idempotency_conflict", "This funding idempotency key was already used for another event.");
    }
    return { event: publicFundingEvent(keyReplay), account: publicBillingAccount(billingAccountById(data, keyReplay.account_id)), duplicate: true };
  }
  const account = ensureBillingAccount(data, target);
  const event = {
    funding_event_id: makeId("funding"),
    event_identity: eventIdentity,
    ...request,
    idempotency_key_digest: keyDigest,
    request_digest: requestDigest,
    recorded_by: recordedBy,
    created_at: new Date().toISOString()
  };
  if (safeStatus === "succeeded") {
    const entry = appendLedgerEntry(data, account, {
      type: "external_funding",
      availableDeltaMicros: amountMicros,
      reservedDeltaMicros: 0,
      creditedMicros: amountMicros,
      reference: `funding:${eventIdentity}`,
      actorId: recordedBy,
      metadata: {
        provider: safeProvider,
        external_reference: safeReference,
        provider_event_id: safeEventId,
        request_digest: requestDigest
      }
    });
    event.ledger_entry_id = entry.entry_id;
  }
  data.billingFundingEvents.push(event);
  return { event: publicFundingEvent(event), account: publicBillingAccount(account), duplicate: false };
}

export function normalizeTokenAccounting(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawCalls = Array.isArray(source.calls) ? source.calls.slice(0, MAX_TOKEN_CALLS) : [];
  const anomalies = [];
  if (Array.isArray(source.calls) && source.calls.length > MAX_TOKEN_CALLS) anomalies.push("call_limit_exceeded");
  const calls = rawCalls.map((call, index) => normalizeTokenCall(call, index, anomalies)).filter(Boolean);
  if (source.provider_reported === true && source.complete === true && rawCalls.length === 0) {
    anomalies.push("provider_calls_missing");
  }
  const totals = tokenTotals(calls);
  const rawTotal = nonNegativeSafeInteger(source.totals?.total_tokens, null, MAX_TOKENS_PER_CALL * MAX_TOKEN_CALLS);
  if (rawTotal !== null && rawTotal !== totals.total_tokens) anomalies.push("provider_total_mismatch");
  if (Number.isSafeInteger(Number(source.call_count)) && Number(source.call_count) !== calls.length) anomalies.push("provider_call_count_mismatch");
  const missingUsage = Array.isArray(source.missing_usage)
    ? source.missing_usage.slice(0, MAX_TOKEN_CALLS).map((value) => boundedText(value, 200)).filter(Boolean)
    : [];
  return {
    schema_version: "router-token-accounting-v1",
    provider_reported: source.provider_reported === true,
    complete: source.provider_reported === true && source.complete === true && missingUsage.length === 0 && anomalies.length === 0,
    call_count: calls.length,
    calls,
    totals,
    missing_usage: missingUsage,
    anomalies
  };
}

export function usageForRunStep(usageReceipt, step) {
  if (!usageReceipt || !step) return null;
  const components = (usageReceipt.components || []).filter((component) => (
    component.kind === "agent"
    && (
      (component.step_id && component.step_id === step.step_id)
      || (!component.step_id && component.agent_id === step.adapter)
    )
  ));
  if (components.length === 0) return {
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    charged_micros: 0,
    charged_credits: formatCredits(0),
    reported: false
  };
  return aggregateUsageComponents(components);
}

export function verifyBillingLedger(data, accountId = null) {
  ensureBillingCollections(data);
  const accountIds = accountId
    ? [accountId]
    : data.billingAccounts.map((account) => account.account_id);
  const errors = [];
  const knownAccountIds = new Set(data.billingAccounts.map((account) => account.account_id));
  const entryIds = new Set();
  for (const entry of data.billingLedgerEntries) {
    if (!knownAccountIds.has(entry?.account_id)) errors.push(`orphan_entry:${entry?.entry_id || "missing"}`);
    if (!entry?.entry_id || entryIds.has(entry.entry_id)) errors.push(`duplicate_entry:${entry?.entry_id || "missing"}`);
    entryIds.add(entry?.entry_id);
  }
  for (const id of accountIds) {
    const account = data.billingAccounts.find((candidate) => candidate.account_id === id);
    if (!account) {
      errors.push(`missing_account:${id}`);
      continue;
    }
    const accountMicros = [
      account.available_micros,
      account.reserved_micros,
      account.lifetime_credited_micros,
      account.lifetime_debited_micros
    ];
    if (accountMicros.some((value) => !Number.isSafeInteger(value))) errors.push(`account_amount:${id}`);
    if (!Number.isSafeInteger(account.revision) || account.revision < 0) errors.push(`account_revision:${id}`);
    if (Number.isSafeInteger(account.reserved_micros) && account.reserved_micros < 0) errors.push(`account_reserved_negative:${id}`);
    if (Number.isSafeInteger(account.lifetime_credited_micros) && account.lifetime_credited_micros < 0) errors.push(`account_credited_negative:${id}`);
    if (Number.isSafeInteger(account.lifetime_debited_micros) && account.lifetime_debited_micros < 0) errors.push(`account_debited_negative:${id}`);
    let available = 0;
    let reserved = 0;
    let credited = 0;
    let debited = 0;
    let previousHash = null;
    const entries = data.billingLedgerEntries.filter((entry) => entry.account_id === id);
    const references = new Set();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.workspace_id !== account.workspace_id || entry.user_id !== account.user_id) {
        errors.push(`entry_owner:${id}:${index + 1}`);
      }
      if (!entry.reference || references.has(entry.reference)) errors.push(`entry_reference:${id}:${index + 1}`);
      references.add(entry.reference);
      if (entry.sequence !== index + 1) errors.push(`sequence:${id}:${index + 1}`);
      if ((entry.previous_hash || null) !== previousHash) errors.push(`previous_hash:${id}:${index + 1}`);
      if (entry.entry_hash !== ledgerEntryHash(entry)) errors.push(`entry_hash:${id}:${index + 1}`);
      const amounts = [
        entry.available_delta_micros,
        entry.reserved_delta_micros,
        entry.credited_micros,
        entry.debited_micros,
        entry.available_after_micros,
        entry.reserved_after_micros
      ];
      if (amounts.some((value) => !Number.isSafeInteger(value))) {
        errors.push(`entry_amount:${id}:${index + 1}`);
        previousHash = entry.entry_hash;
        continue;
      }
      if (entry.credited_micros < 0 || entry.debited_micros < 0 || entry.reserved_after_micros < 0) {
        errors.push(`entry_amount_negative:${id}:${index + 1}`);
      }
      available += entry.available_delta_micros;
      reserved += entry.reserved_delta_micros;
      credited += entry.credited_micros;
      debited += entry.debited_micros;
      if (![available, reserved, credited, debited].every(Number.isSafeInteger)) {
        errors.push(`entry_amount_overflow:${id}:${index + 1}`);
      }
      if (entry.available_after_micros !== available || entry.reserved_after_micros !== reserved) {
        errors.push(`running_balance:${id}:${index + 1}`);
      }
      previousHash = entry.entry_hash;
    }
    if (
      account.available_micros !== available
      || account.reserved_micros !== reserved
      || account.lifetime_credited_micros !== credited
      || account.lifetime_debited_micros !== debited
      || account.revision !== entries.length
      || (account.ledger_head_hash || null) !== previousHash
    ) errors.push(`account_projection:${id}`);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function verifyBillingState(data) {
  ensureBillingCollections(data);
  const errors = [...verifyBillingLedger(data).errors];
  const pricingIds = new Set();
  const pricingKeys = new Set();
  for (let pricingIndex = 0; pricingIndex < data.billingPricingVersions.length; pricingIndex += 1) {
    const pricing = data.billingPricingVersions[pricingIndex];
    if (!pricing?.pricing_version_id || pricingIds.has(pricing.pricing_version_id)) {
      errors.push(`duplicate_pricing:${pricing?.pricing_version_id || "missing"}`);
    }
    pricingIds.add(pricing?.pricing_version_id);
    const expectedSupersedes = pricingIndex === 0 ? null : data.billingPricingVersions[pricingIndex - 1]?.pricing_version_id;
    if ((pricing?.supersedes_version_id || null) !== expectedSupersedes) {
      errors.push(`pricing_chain:${pricing?.pricing_version_id || "missing"}`);
    }
    if (!Number.isSafeInteger(pricing?.minimum_reservation_micros) || pricing.minimum_reservation_micros < 0) {
      errors.push(`pricing_minimum:${pricing?.pricing_version_id || "missing"}`);
    }
    if (!Array.isArray(pricing?.rules) || pricing.rules.length === 0 || pricing.rules.length > 100) {
      errors.push(`pricing_rules:${pricing?.pricing_version_id || "missing"}`);
    } else {
      const patterns = new Set();
      for (const rule of pricing.rules) {
        const pattern = String(rule?.model_pattern || "");
        if (!pattern || patterns.has(pattern)) errors.push(`pricing_pattern:${pricing.pricing_version_id}`);
        patterns.add(pattern);
        const rates = [
          rule?.prompt_micros_per_1k,
          rule?.completion_micros_per_1k,
          rule?.cached_micros_per_1k,
          rule?.unclassified_micros_per_1k
        ];
        if (rates.some((value) => !Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_MICROS)) {
          errors.push(`pricing_rate:${pricing.pricing_version_id}`);
        }
      }
    }
    if (pricing?.idempotency_key_digest) {
      if (pricingKeys.has(pricing.idempotency_key_digest)) errors.push(`duplicate_pricing_key:${pricing.pricing_version_id}`);
      pricingKeys.add(pricing.idempotency_key_digest);
    }
  }
  const accountIds = new Set();
  const ownerKeys = new Set();
  for (const account of data.billingAccounts) {
    if (!account?.account_id || accountIds.has(account.account_id)) {
      errors.push(`duplicate_account:${account?.account_id || "missing"}`);
      continue;
    }
    accountIds.add(account.account_id);
    if (!account.workspace_id || !account.user_id || account.unit !== "credit") errors.push(`account_identity:${account.account_id}`);
    if (!["active", "suspended", "closing", "retired"].includes(account.status)) {
      errors.push(`account_status:${account.account_id}`);
    }
    const ownerKey = `${account.workspace_id}\0${account.user_id}`;
    if (ownerKeys.has(ownerKey)) errors.push(`duplicate_account_owner:${account.account_id}`);
    ownerKeys.add(ownerKey);
    const activeReserved = data.billingReservations
      .filter((reservation) => reservation.account_id === account.account_id && reservation.status === "active")
      .reduce((total, reservation) => total + Number(reservation.authorized_micros || 0), 0);
    if (!Number.isSafeInteger(activeReserved) || activeReserved !== account.reserved_micros) {
      errors.push(`reservation_projection:${account.account_id}`);
    }
  }
  const runIds = new Set();
  const reservationIds = new Set();
  for (const reservation of data.billingReservations) {
    if (!reservation?.reservation_id || reservationIds.has(reservation.reservation_id)) {
      errors.push(`duplicate_reservation:${reservation?.reservation_id || "missing"}`);
    }
    reservationIds.add(reservation?.reservation_id);
    const account = data.billingAccounts.find((candidate) => candidate.account_id === reservation?.account_id);
    if (!account) errors.push(`reservation_account:${reservation?.reservation_id || "missing"}`);
    else if (account.workspace_id !== reservation.workspace_id || account.user_id !== reservation.user_id) {
      errors.push(`reservation_owner:${reservation.reservation_id}`);
    }
    if (!pricingIds.has(reservation?.pricing_version_id)) errors.push(`reservation_pricing:${reservation?.reservation_id || "missing"}`);
    if (!reservation?.run_id || runIds.has(reservation.run_id)) errors.push(`duplicate_reservation_run:${reservation?.run_id || "missing"}`);
    runIds.add(reservation?.run_id);
    if (!["active", "settled", "released"].includes(reservation?.status)) {
      errors.push(`reservation_status:${reservation?.reservation_id || "missing"}`);
    }
    if (!Number.isSafeInteger(reservation?.authorized_micros) || reservation.authorized_micros < 0) {
      errors.push(`reservation_amount:${reservation?.reservation_id || "missing"}`);
    }
    if (reservation?.actual_charge_micros !== null && (
      !Number.isSafeInteger(reservation.actual_charge_micros) || reservation.actual_charge_micros < 0
    )) errors.push(`reservation_charge:${reservation?.reservation_id || "missing"}`);
    const terminalShapeValid = (
      (reservation?.status === "active" && reservation.actual_charge_micros === null && !reservation.settled_at && !reservation.released_at)
      || (reservation?.status === "settled" && Number.isSafeInteger(reservation.actual_charge_micros) && Boolean(reservation.settled_at) && !reservation.released_at)
      || (reservation?.status === "released" && reservation.actual_charge_micros === null && !reservation.settled_at && Boolean(reservation.released_at))
    );
    if (!terminalShapeValid) errors.push(`reservation_terminal:${reservation?.reservation_id || "missing"}`);
    if (reservation?.pricing_snapshot?.pricing_version_id !== reservation?.pricing_version_id) {
      errors.push(`reservation_snapshot:${reservation?.reservation_id || "missing"}`);
    }
  }
  const usageReservations = new Set();
  const usageIds = new Set();
  for (const record of data.billingUsageRecords) {
    if (!record?.usage_record_id || usageIds.has(record.usage_record_id)) {
      errors.push(`duplicate_usage:${record?.usage_record_id || "missing"}`);
    }
    usageIds.add(record?.usage_record_id);
    if (!reservationIds.has(record?.reservation_id)) errors.push(`usage_reservation:${record?.usage_record_id || "missing"}`);
    if (usageReservations.has(record?.reservation_id)) errors.push(`duplicate_usage_reservation:${record?.reservation_id || "missing"}`);
    usageReservations.add(record?.reservation_id);
    const reservation = data.billingReservations.find((candidate) => candidate.reservation_id === record?.reservation_id);
    if (reservation && reservation.status !== "settled") errors.push(`usage_unsettled:${record?.usage_record_id || "missing"}`);
    if (reservation && (
      reservation.account_id !== record.account_id
      || reservation.workspace_id !== record.workspace_id
      || reservation.user_id !== record.user_id
      || reservation.run_id !== record.run_id
      || reservation.pricing_version_id !== record.pricing_version_id
    )) errors.push(`usage_owner:${record?.usage_record_id || "missing"}`);
    if (!Number.isSafeInteger(record?.total_charge_micros) || record.total_charge_micros < 0) {
      errors.push(`usage_charge:${record?.usage_record_id || "missing"}`);
    }
    if (!Number.isSafeInteger(record?.balance_after_micros)) errors.push(`usage_balance:${record?.usage_record_id || "missing"}`);
    if (!["charged", "partial", "unreported"].includes(record?.status)) errors.push(`usage_status:${record?.usage_record_id || "missing"}`);
    const normalized = normalizeTokenAccounting(record?.token_accounting);
    if (digestValue(normalized.calls) !== digestValue(record?.token_accounting?.calls || [])
      || digestValue(normalized.totals) !== digestValue(record?.token_accounting?.totals || {})) {
      errors.push(`usage_tokens:${record?.usage_record_id || "missing"}`);
    }
    const componentCosts = Array.isArray(record?.component_costs) ? record.component_costs : [];
    const componentCharge = componentCosts.reduce((total, component) => {
      const amount = component?.charged_micros;
      return Number.isSafeInteger(total) && Number.isSafeInteger(amount) && amount >= 0 ? total + amount : Number.NaN;
    }, 0);
    if (!Number.isSafeInteger(componentCharge) || componentCharge !== record?.total_charge_micros) {
      errors.push(`usage_component_charge:${record?.usage_record_id || "missing"}`);
    }
    if (reservation && reservation.actual_charge_micros !== record?.total_charge_micros) {
      errors.push(`usage_reservation_charge:${record?.usage_record_id || "missing"}`);
    }
    const settlement = reservation && data.billingLedgerEntries.find((entry) => (
      entry.account_id === reservation.account_id
      && entry.reference === `settlement:${reservation.reservation_id}`
    ));
    if (!settlement || settlement.debited_micros !== record?.total_charge_micros) {
      errors.push(`usage_settlement:${record?.usage_record_id || "missing"}`);
    }
  }
  for (const reservation of data.billingReservations) {
    if (reservation.status === "settled" && !usageReservations.has(reservation.reservation_id)) {
      errors.push(`settlement_usage_missing:${reservation.reservation_id}`);
    }
  }
  const fundingIdentities = new Set();
  const fundingKeys = new Set();
  for (const event of data.billingFundingEvents) {
    if (!event?.event_identity || fundingIdentities.has(event.event_identity)) {
      errors.push(`duplicate_funding_event:${event?.event_identity || "missing"}`);
    }
    fundingIdentities.add(event?.event_identity);
    if (!event?.idempotency_key_digest || fundingKeys.has(event.idempotency_key_digest)) {
      errors.push(`duplicate_funding_key:${event?.funding_event_id || "missing"}`);
    }
    fundingKeys.add(event?.idempotency_key_digest);
    const account = data.billingAccounts.find((candidate) => candidate.account_id === event?.account_id);
    if (!account) errors.push(`funding_account:${event?.funding_event_id || "missing"}`);
    if (!Number.isSafeInteger(event?.amount_micros) || event.amount_micros <= 0) {
      errors.push(`funding_amount:${event?.funding_event_id || "missing"}`);
    }
    if (!["pending", "succeeded", "failed", "cancelled"].includes(event?.status)) {
      errors.push(`funding_status:${event?.funding_event_id || "missing"}`);
    }
    if (event?.status === "succeeded" && !event.ledger_entry_id) errors.push(`funding_ledger_missing:${event?.funding_event_id || "missing"}`);
    if (event?.status !== "succeeded" && event?.ledger_entry_id) errors.push(`funding_ledger_unexpected:${event?.funding_event_id || "missing"}`);
    if (event?.ledger_entry_id && !data.billingLedgerEntries.some((entry) => (
      entry.entry_id === event.ledger_entry_id && entry.account_id === event.account_id
    ))) errors.push(`funding_ledger_invalid:${event?.funding_event_id || "missing"}`);
    if (event?.ledger_entry_id && !data.billingLedgerEntries.some((entry) => (
      entry.entry_id === event.ledger_entry_id
      && entry.type === "external_funding"
      && entry.credited_micros === event.amount_micros
      && entry.available_delta_micros === event.amount_micros
    ))) errors.push(`funding_ledger_amount:${event?.funding_event_id || "missing"}`);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function parseCredits(value, label = "Credits", {
  allowNegative = false,
  allowZero = false
} = {}) {
  const text = String(value ?? "").trim();
  const pattern = allowNegative ? /^-?(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/ : /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/;
  if (!pattern.test(text)) {
    throw new BillingError(400, "billing_amount_invalid", `${label} must be a plain decimal with at most six fractional digits.`);
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const micros = Number(BigInt(whole) * BigInt(MICROS_PER_CREDIT) + BigInt(fraction.padEnd(6, "0")));
  if (!Number.isSafeInteger(micros) || micros > MAX_ACCOUNT_CREDITS * MICROS_PER_CREDIT) {
    throw new BillingError(400, "billing_amount_invalid", `${label} is too large.`);
  }
  const signed = negative ? -micros : micros;
  if (!allowZero && signed === 0) {
    throw new BillingError(400, "billing_amount_invalid", `${label} must not be zero.`);
  }
  return signed;
}

export function formatCredits(value) {
  const micros = safeMicros(value, "Credit value", { allowNegative: true });
  const negative = micros < 0;
  const absolute = Math.abs(micros);
  const whole = Math.floor(absolute / MICROS_PER_CREDIT);
  const fraction = String(absolute % MICROS_PER_CREDIT).padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function appendLedgerEntry(data, account, {
  type,
  availableDeltaMicros,
  reservedDeltaMicros,
  creditedMicros = 0,
  debitedMicros = 0,
  allowNegative = false,
  reference,
  actorId,
  runId = null,
  pricingVersionId = null,
  metadata = {}
}) {
  const existing = data.billingLedgerEntries.find((entry) => entry.account_id === account.account_id && entry.reference === reference);
  if (existing) return existing;
  const availableDelta = safeMicros(availableDeltaMicros, "Available balance delta", { allowNegative: true });
  const reservedDelta = safeMicros(reservedDeltaMicros, "Reserved balance delta", { allowNegative: true });
  const nextAvailable = safeMicros(account.available_micros + availableDelta, "Available balance", { allowNegative: true });
  const nextReserved = safeMicros(account.reserved_micros + reservedDelta, "Reserved balance");
  if (!allowNegative && nextAvailable < 0) {
    throw new BillingError(402, "insufficient_balance", "The available balance is too low for this operation.");
  }
  const createdAt = new Date().toISOString();
  const entry = {
    entry_id: makeId("ledger"),
    account_id: account.account_id,
    workspace_id: account.workspace_id,
    user_id: account.user_id,
    sequence: Number(account.revision || 0) + 1,
    type: boundedIdentifier(type, "Ledger entry type", 80),
    available_delta_micros: availableDelta,
    reserved_delta_micros: reservedDelta,
    credited_micros: safeMicros(creditedMicros, "Credited amount"),
    debited_micros: safeMicros(debitedMicros, "Debited amount"),
    available_after_micros: nextAvailable,
    reserved_after_micros: nextReserved,
    reference: boundedIdentifier(reference, "Ledger reference", 240, /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/),
    actor_id: boundedText(actorId, 160) || "system",
    run_id: runId ? boundedText(runId, 160) : null,
    pricing_version_id: pricingVersionId ? boundedText(pricingVersionId, 160) : null,
    metadata: boundedJson(metadata, 20_000),
    previous_hash: account.ledger_head_hash || null,
    created_at: createdAt
  };
  entry.entry_hash = ledgerEntryHash(entry);
  data.billingLedgerEntries.push(entry);
  account.available_micros = nextAvailable;
  account.reserved_micros = nextReserved;
  account.lifetime_credited_micros = safeMicros(account.lifetime_credited_micros + entry.credited_micros, "Lifetime credits");
  account.lifetime_debited_micros = safeMicros(account.lifetime_debited_micros + entry.debited_micros, "Lifetime debits");
  account.revision = entry.sequence;
  account.ledger_head_hash = entry.entry_hash;
  account.updated_at = createdAt;
  return entry;
}

function publicLedgerEntry(entry) {
  return {
    entry_id: entry.entry_id,
    sequence: entry.sequence,
    type: entry.type,
    available_delta_micros: entry.available_delta_micros,
    available_delta_credits: formatCredits(entry.available_delta_micros),
    reserved_delta_micros: entry.reserved_delta_micros,
    reserved_delta_credits: formatCredits(entry.reserved_delta_micros),
    credited_micros: entry.credited_micros,
    credited_credits: formatCredits(entry.credited_micros),
    debited_micros: entry.debited_micros,
    debited_credits: formatCredits(entry.debited_micros),
    available_after_micros: entry.available_after_micros,
    available_after_credits: formatCredits(entry.available_after_micros),
    reserved_after_micros: entry.reserved_after_micros,
    reserved_after_credits: formatCredits(entry.reserved_after_micros),
    reference: entry.reference,
    run_id: entry.run_id || null,
    pricing_version_id: entry.pricing_version_id || null,
    metadata: entry.metadata,
    previous_hash: entry.previous_hash,
    entry_hash: entry.entry_hash,
    created_at: entry.created_at
  };
}

function ledgerEntryHash(entry) {
  const { entry_hash: _entryHash, ...material } = entry;
  return digestValue(material);
}

function attachReservationToRun(run, reservation, account) {
  run.billing = {
    status: reservation.status,
    reservation_id: reservation.reservation_id,
    pricing_version_id: reservation.pricing_version_id,
    reserved_micros: reservation.authorized_micros,
    reserved_credits: formatCredits(reservation.authorized_micros),
    account_revision: account.revision,
    balance_after_micros: account.available_micros,
    balance_after_credits: formatCredits(account.available_micros),
    reserved_after_micros: account.reserved_micros,
    reserved_after_credits: formatCredits(account.reserved_micros)
  };
}

function attachSettlementToRun(run, reservation, account, usageRecord) {
  run.billing = {
    status: reservation.status,
    reservation_id: reservation.reservation_id,
    usage_record_id: usageRecord.usage_record_id,
    pricing_version_id: reservation.pricing_version_id,
    charged_micros: usageRecord.total_charge_micros,
    charged_credits: formatCredits(usageRecord.total_charge_micros),
    account_revision: account.revision,
    balance_after_micros: account.available_micros,
    balance_after_credits: formatCredits(account.available_micros),
    reserved_after_micros: account.reserved_micros,
    reserved_after_credits: formatCredits(account.reserved_micros),
    accounting_status: usageRecord.status
  };
}

function publicUsageRecord(record) {
  if (!record) return null;
  const normalized = record.token_accounting;
  return {
    usage_record_id: record.usage_record_id,
    status: record.status,
    provider_reported: normalized.provider_reported,
    complete: normalized.complete,
    call_count: normalized.call_count,
    prompt_tokens: normalized.totals.prompt_tokens,
    completion_tokens: normalized.totals.completion_tokens,
    total_tokens: normalized.totals.total_tokens,
    cached_tokens: normalized.totals.cached_tokens || 0,
    components: record.component_costs.map(publicUsageComponent),
    charged_micros: record.total_charge_micros,
    charged_credits: formatCredits(record.total_charge_micros),
    balance_after_micros: record.balance_after_micros,
    balance_after_credits: formatCredits(record.balance_after_micros),
    pricing_version_id: record.pricing_version_id,
    missing_usage: normalized.missing_usage,
    anomalies: normalized.anomalies,
    created_at: record.created_at
  };
}

function buildUsageReceipt(raw, pricing, balanceAfter) {
  const normalized = normalizeTokenAccounting(raw);
  const priced = pricing ? priceTokenCalls(normalized.calls, pricing) : { components: [], total_charge_micros: 0 };
  return {
    status: normalized.calls.length ? "not_charged" : "unreported",
    provider_reported: normalized.provider_reported,
    complete: normalized.complete,
    call_count: normalized.call_count,
    ...normalized.totals,
    components: priced.components.map(publicUsageComponent),
    charged_micros: priced.total_charge_micros,
    charged_credits: formatCredits(priced.total_charge_micros),
    balance_after_micros: balanceAfter,
    balance_after_credits: balanceAfter === null ? null : formatCredits(balanceAfter),
    missing_usage: normalized.missing_usage,
    anomalies: normalized.anomalies
  };
}

function zeroPricingVersion() {
  return {
    rules: [{
      model_pattern: "*",
      prompt_micros_per_1k: 0,
      completion_micros_per_1k: 0,
      cached_micros_per_1k: 0,
      unclassified_micros_per_1k: 0
    }],
    minimum_reservation_micros: 0
  };
}

function publicUsageComponent(component) {
  return {
    component_key: component.component_key,
    component: component.component,
    kind: component.kind,
    agent_id: component.agent_id || null,
    step_id: component.step_id || null,
    model: component.model || null,
    calls: component.calls,
    prompt_tokens: component.prompt_tokens,
    completion_tokens: component.completion_tokens,
    total_tokens: component.total_tokens,
    cached_tokens: component.cached_tokens,
    charged_micros: component.charged_micros,
    charged_credits: formatCredits(component.charged_micros)
  };
}

function priceTokenCalls(calls, pricing) {
  const byComponent = new Map();
  for (const call of calls) {
    const classification = classifyComponent(call);
    const rule = pricingRuleForModel(pricing, call.model);
    const cached = Math.min(call.cached_tokens || 0, call.prompt_tokens || 0);
    const prompt = Math.max(0, (call.prompt_tokens || 0) - cached);
    const completion = call.completion_tokens || 0;
    const unclassified = Math.max(0, (call.total_tokens || 0) - (call.prompt_tokens || 0) - completion);
    const charged = safeMicros(
      rateCharge(prompt, rule.prompt_micros_per_1k)
      + rateCharge(cached, rule.cached_micros_per_1k)
      + rateCharge(completion, rule.completion_micros_per_1k)
      + rateCharge(unclassified, rule.unclassified_micros_per_1k),
      "Usage charge"
    );
    const key = classification.component_key;
    const current = byComponent.get(key) || {
      ...classification,
      component: call.component,
      model: call.model,
      calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cached_tokens: 0,
      charged_micros: 0
    };
    current.calls += 1;
    current.prompt_tokens += call.prompt_tokens || 0;
    current.completion_tokens += completion;
    current.total_tokens += call.total_tokens || 0;
    current.cached_tokens += cached;
    current.charged_micros = safeMicros(current.charged_micros + charged, "Component usage charge");
    if (current.model !== call.model) current.model = "multiple";
    byComponent.set(key, current);
  }
  const components = [...byComponent.values()];
  return {
    components,
    total_charge_micros: safeMicros(components.reduce((total, component) => total + component.charged_micros, 0), "Total usage charge")
  };
}

function normalizeTokenCall(value, index, anomalies) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    anomalies.push(`invalid_call:${index + 1}`);
    return null;
  }
  const component = boundedText(value.component, 240) || `unclassified_call_${index + 1}`;
  const prompt = nonNegativeSafeInteger(value.prompt_tokens, 0, MAX_TOKENS_PER_CALL);
  const completion = nonNegativeSafeInteger(value.completion_tokens, 0, MAX_TOKENS_PER_CALL);
  let total = nonNegativeSafeInteger(value.total_tokens, prompt + completion, MAX_TOKENS_PER_CALL);
  if (prompt === null || completion === null || total === null) {
    anomalies.push(`invalid_tokens:${index + 1}`);
    return null;
  }
  if (prompt + completion > MAX_TOKENS_PER_CALL) {
    anomalies.push(`token_limit_exceeded:${index + 1}`);
    return null;
  }
  if (total < prompt + completion) anomalies.push(`call_total_mismatch:${index + 1}`);
  total = Math.max(total, prompt + completion);
  const cached = nonNegativeSafeInteger(value.cached_tokens, 0, MAX_TOKENS_PER_CALL);
  const reasoning = nonNegativeSafeInteger(value.reasoning_tokens, 0, MAX_TOKENS_PER_CALL);
  if (cached === null) anomalies.push(`invalid_cached_tokens:${index + 1}`);
  else if (cached > prompt) anomalies.push(`cached_tokens_exceed_prompt:${index + 1}`);
  if (reasoning === null) anomalies.push(`invalid_reasoning_tokens:${index + 1}`);
  const call = {
    component,
    model: boundedText(value.model, 240),
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: Math.min(cached ?? 0, prompt),
    reasoning_tokens: reasoning ?? 0
  };
  const agentId = boundedText(value.agent_id, 160);
  const stepId = boundedText(value.step_id, 160);
  if (agentId) call.agent_id = agentId;
  if (stepId) call.step_id = stepId;
  return call;
}

function tokenTotals(calls) {
  return calls.reduce((totals, call) => ({
    prompt_tokens: totals.prompt_tokens + call.prompt_tokens,
    completion_tokens: totals.completion_tokens + call.completion_tokens,
    total_tokens: totals.total_tokens + call.total_tokens,
    cached_tokens: totals.cached_tokens + call.cached_tokens,
    reasoning_tokens: totals.reasoning_tokens + call.reasoning_tokens
  }), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 });
}

function classifyComponent(call) {
  const component = call.component;
  const agentMatch = component.match(/^agent:([^:]+):/);
  if (agentMatch || call.agent_id) {
    const agentId = call.agent_id || agentMatch[1];
    const stepId = call.step_id || null;
    return {
      component_key: stepId ? `agent:${agentId}:step:${stepId}` : `agent:${agentId}`,
      kind: "agent",
      agent_id: agentId,
      step_id: stepId
    };
  }
  if (component === "final_synthesis" || component === "conversation_continuation") {
    return { component_key: component, kind: "final_output", agent_id: null, step_id: null };
  }
  if (["session_controller_planning", "route_planning", "workflow_composition"].includes(component)) {
    return { component_key: component, kind: "router", agent_id: null, step_id: null };
  }
  return { component_key: component, kind: "other", agent_id: null, step_id: null };
}

function aggregateUsageComponents(components) {
  const totals = components.reduce((result, component) => ({
    calls: result.calls + component.calls,
    prompt_tokens: result.prompt_tokens + component.prompt_tokens,
    completion_tokens: result.completion_tokens + component.completion_tokens,
    total_tokens: result.total_tokens + component.total_tokens,
    cached_tokens: result.cached_tokens + component.cached_tokens,
    charged_micros: result.charged_micros + component.charged_micros
  }), { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, charged_micros: 0 });
  return { ...totals, charged_credits: formatCredits(totals.charged_micros), reported: true };
}

function estimateReservation(pricing, options, kind) {
  const contextTokens = boundedEnvInteger("ROUTER_SESSION_CONTEXT_TOKENS", boundedEnvInteger("TCAR_MODEL_CONTEXT_TOKENS", 4096, 2048, 2_000_000), 2048, 2_000_000);
  const routeInput = boundedEnvInteger("TCAR_ROUTE_INPUT_MAX_TOKENS", 3000, 1500, 2_000_000);
  const refinerInput = boundedEnvInteger("TCAR_REFINER_INPUT_MAX_TOKENS", 2800, 1500, 2_000_000);
  const defaultRule = pricingRuleForModel(pricing, "");
  let promptTokens;
  let completionTokens;
  if (kind === "workflow_composition") {
    promptTokens = contextTokens;
    completionTokens = boundedEnvInteger("ROUTER_WORKFLOW_COMPOSER_MAX_TOKENS", 1200, 256, 4096);
  } else if (kind === "conversation_continuation") {
    promptTokens = contextTokens;
    completionTokens = boundedEnvInteger("ROUTER_CONTINUATION_MAX_TOKENS", 900, 256, 2048);
  } else {
    const routes = boundedInteger(options.max_routing_adapters, 12, 1, 24) + 1;
    const rounds = boundedEnvInteger("TCAR_TOOL_MAX_ROUNDS", 3, 0, 6) + 1;
    const maxTokens = boundedInteger(options.max_tokens, 256, 16, 512);
    const plannerTokens = boundedInteger(options.planner_max_tokens, 384, 32, 512);
    const refinerTokens = boundedInteger(options.refiner_max_tokens, 384, 32, 1024);
    promptTokens = contextTokens + routes * rounds * routeInput + refinerInput;
    completionTokens = plannerTokens + routes * rounds * maxTokens + refinerTokens;
  }
  promptTokens = Math.ceil(promptTokens * 1.1);
  completionTokens = Math.ceil(completionTokens * 1.1);
  const amount = rateCharge(promptTokens, defaultRule.prompt_micros_per_1k)
    + rateCharge(completionTokens, defaultRule.completion_micros_per_1k);
  return {
    amount_micros: Math.max(pricing.minimum_reservation_micros || 0, safeMicros(amount, "Reservation amount")),
    token_ceiling: { prompt_tokens: promptTokens, completion_tokens: completionTokens }
  };
}

function rateCharge(tokens, microsPer1k) {
  const tokenCount = BigInt(nonNegativeSafeInteger(tokens, 0, MAX_TOKENS_PER_CALL * MAX_TOKEN_CALLS));
  const rate = BigInt(safeMicros(microsPer1k, "Pricing rate"));
  const charged = (tokenCount * rate + BigInt(TOKENS_PER_RATE_UNIT - 1)) / BigInt(TOKENS_PER_RATE_UNIT);
  if (charged > BigInt(MAX_SAFE_MICROS)) {
    throw new BillingError(500, "billing_amount_overflow", "The calculated usage charge exceeds the supported range.");
  }
  return Number(charged);
}

function pricingPayload(body) {
  const modelPattern = String(body.model_pattern || "*").trim();
  if (modelPattern !== "*" && !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,238}\*?$/.test(modelPattern)) {
    throw new BillingError(400, "billing_model_pattern_invalid", "Model pattern must be an exact model id or a safe prefix ending in *.");
  }
  const prompt = parseCredits(body.prompt_credits_per_1k, "Prompt credits per 1,000 tokens", { allowZero: true });
  const completion = parseCredits(body.completion_credits_per_1k, "Completion credits per 1,000 tokens", { allowZero: true });
  const cached = parseCredits(body.cached_credits_per_1k, "Cached credits per 1,000 tokens", { allowZero: true });
  const unclassified = parseCredits(body.unclassified_credits_per_1k ?? body.completion_credits_per_1k, "Unclassified credits per 1,000 tokens", { allowZero: true });
  return {
    rule: {
      model_pattern: modelPattern,
      prompt_micros_per_1k: prompt,
      completion_micros_per_1k: completion,
      cached_micros_per_1k: cached,
      unclassified_micros_per_1k: unclassified
    },
    minimum_reservation_micros: parseCredits(body.minimum_reservation_credits ?? DEFAULT_MINIMUM_RESERVATION_CREDITS, "Minimum reservation credits", { allowZero: true })
  };
}

function mergedPricingRules(previousRules, requestedRule) {
  const byPattern = new Map(
    (Array.isArray(previousRules) ? previousRules : [])
      .filter((rule) => rule?.model_pattern)
      .map((rule) => [rule.model_pattern, boundedJson(rule, 2_000)])
  );
  byPattern.set(requestedRule.model_pattern, requestedRule);
  if (!byPattern.has("*")) {
    throw new BillingError(409, "billing_default_pricing_required", "A catch-all pricing rule must exist before model-specific rates can be added.");
  }
  return [
    byPattern.get("*"),
    ...[...byPattern.entries()]
      .filter(([pattern]) => pattern !== "*")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, rule]) => rule)
  ];
}

function pricingRuleForModel(pricing, model) {
  const rules = Array.isArray(pricing?.rules) ? pricing.rules : [];
  const exact = rules.find((rule) => rule.model_pattern === model);
  if (exact) return exact;
  const prefix = rules
    .filter((rule) => rule.model_pattern?.endsWith("*") && rule.model_pattern !== "*")
    .sort((left, right) => right.model_pattern.length - left.model_pattern.length)
    .find((rule) => String(model || "").startsWith(rule.model_pattern.slice(0, -1)));
  return prefix || rules.find((rule) => rule.model_pattern === "*") || {
    prompt_micros_per_1k: 0,
    completion_micros_per_1k: 0,
    cached_micros_per_1k: 0,
    unclassified_micros_per_1k: 0
  };
}

function pricingSnapshot(pricing) {
  return {
    pricing_version_id: pricing.pricing_version_id,
    rules: boundedJson(pricing.rules, 20_000),
    minimum_reservation_micros: pricing.minimum_reservation_micros
  };
}

function pricingById(data, pricingVersionId) {
  const pricing = data.billingPricingVersions.find((candidate) => candidate.pricing_version_id === pricingVersionId);
  if (!pricing) throw new BillingError(500, "billing_pricing_missing", "The pricing snapshot for this reservation is missing.");
  return pricing;
}

function billingAccountById(data, accountId) {
  const account = data.billingAccounts.find((candidate) => candidate.account_id === accountId);
  if (!account) throw new BillingError(500, "billing_account_missing", "The billing account for this reservation is missing.");
  return account;
}

function billingIdentity(actor) {
  const rawUserId = String(actor?.user_id ?? "");
  const rawWorkspaceId = String(actor?.workspace_id ?? "");
  const userId = rawUserId.trim();
  const workspaceId = rawWorkspaceId.trim();
  if (rawUserId.includes("\0") || rawWorkspaceId.includes("\0")
    || !userId || !workspaceId || userId.length > 160 || workspaceId.length > 160) {
    throw new BillingError(400, "billing_identity_invalid", "A user and workspace are required for billing.");
  }
  return { user_id: userId, workspace_id: workspaceId };
}

function publicFundingEvent(event) {
  return {
    funding_event_id: event.funding_event_id,
    account_id: event.account_id,
    provider: event.provider,
    external_reference: event.external_reference,
    provider_event_id: event.provider_event_id,
    status: event.status,
    amount_micros: event.amount_micros,
    amount_credits: formatCredits(event.amount_micros),
    ledger_entry_id: event.ledger_entry_id || null,
    created_at: event.created_at
  };
}

function requireIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{7,199}$/.test(key)) {
    throw new BillingError(400, "billing_idempotency_required", "A valid Idempotency-Key header is required for this billing operation.");
  }
  return key;
}

function idempotencyDigest(scope, key) {
  return crypto.createHash("sha256").update(`${scope}\0${key}`, "utf8").digest("hex");
}

function stableId(prefix, ...parts) {
  const digest = crypto.createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString("hex")}`;
}

function digestValue(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function boundedJson(value, maxChars) {
  let encoded;
  try {
    encoded = JSON.stringify(value ?? {});
  } catch {
    throw new BillingError(400, "billing_metadata_invalid", "Billing metadata must be JSON serializable.");
  }
  if (encoded.length > maxChars) {
    throw new BillingError(400, "billing_metadata_invalid", "Billing metadata is too large.");
  }
  return JSON.parse(encoded);
}

function boundedIdentifier(value, label, maxChars, pattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/) {
  const raw = String(value ?? "");
  const text = raw.trim();
  if (raw.includes("\0") || !text || text.length > maxChars || !pattern.test(text)) {
    throw new BillingError(400, "billing_identifier_invalid", `${label} has an invalid format.`);
  }
  return text;
}

function boundedText(value, maxChars) {
  return String(value ?? "").replaceAll("\0", "").trim().slice(0, maxChars);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(Math.trunc(number), maximum));
}

function boundedEnvInteger(name, fallback, minimum, maximum) {
  return boundedInteger(process.env[name], fallback, minimum, maximum);
}

function nonNegativeSafeInteger(value, fallback, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) return null;
  return number;
}

function safeMicros(value, label, { allowNegative = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || Math.abs(number) > MAX_SAFE_MICROS || (!allowNegative && number < 0)) {
    throw new BillingError(500, "billing_amount_invalid", `${label} is outside the supported range.`);
  }
  return number;
}
