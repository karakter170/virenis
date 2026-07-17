function boundedString(value) {
  return String(value ?? "").trim();
}

function timestampRank(value) {
  const parsed = Date.parse(boundedString(value));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function deterministicRatingRank(rating = {}) {
  return [
    boundedString(rating.updated_at),
    boundedString(rating.created_at),
    boundedString(rating.rating_id),
    boundedString(rating.score),
    boundedString(rating.workspace_id),
    boundedString(rating.listing_id)
  ].join("\0");
}

function preferRating(left, right) {
  const leftUpdated = timestampRank(left.updated_at || left.created_at);
  const rightUpdated = timestampRank(right.updated_at || right.created_at);
  if (leftUpdated !== rightUpdated) return leftUpdated > rightUpdated ? left : right;

  const leftCreated = timestampRank(left.created_at);
  const rightCreated = timestampRank(right.created_at);
  if (leftCreated !== rightCreated) return leftCreated > rightCreated ? left : right;

  return deterministicRatingRank(left) >= deterministicRatingRank(right)
    ? left
    : right;
}

function resolveRatingSubject(rating, subjects, {
  subjectIdField,
  subjectId,
  listingId,
  subjectWorkspaceId
}) {
  const ratingListingId = boundedString(rating.listing_id);
  if (ratingListingId) {
    const listingMatches = subjects.filter((subject) => boundedString(listingId(subject)) === ratingListingId);
    if (listingMatches.length === 1) return listingMatches[0];
    // An explicit listing id is an immutable revision identity. Never fall
    // back to the subject id when that revision no longer exists, otherwise
    // a legacy rating is silently moved onto a newly published revision.
    return null;
  }

  const legacySubjectId = boundedString(rating[subjectIdField]);
  if (!legacySubjectId) return null;
  const subjectMatches = subjects.filter((subject) => boundedString(subjectId(subject)) === legacySubjectId);
  if (subjectMatches.length === 1) return subjectMatches[0];
  if (subjectMatches.length < 2) return null;

  // Legacy subject ids were not globally unique. The old workspace field may
  // disambiguate the listing during migration, but it is never part of the
  // resulting public rating identity.
  const ratingWorkspaceId = boundedString(rating.workspace_id);
  if (!ratingWorkspaceId) return null;
  const scopedMatches = subjectMatches.filter((subject) => (
    boundedString(subjectWorkspaceId(subject)) === ratingWorkspaceId
  ));
  return scopedMatches.length === 1 ? scopedMatches[0] : null;
}

/**
 * Normalize public Marketplace ratings to one row per listing and public user.
 *
 * `workspace_id` remains optional provenance on legacy rows, but never
 * participates in identity. When old data contains duplicates, the newest
 * update wins; stable field ordering breaks equal-timestamp ties so migration
 * is independent of input order.
 */
export function normalizePublicMarketplaceRatings(rows, {
  subjects = [],
  subjectIdField,
  subjectId,
  listingId,
  publisherIds,
  subjectWorkspaceId = () => ""
}) {
  const normalized = [];
  const identityIndexes = new Map();
  for (const value of Array.isArray(rows) ? rows : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rating = { ...value };
    delete rating.review;
    delete rating.comment;
    delete rating.comments;

    const subject = resolveRatingSubject(rating, subjects, {
      subjectIdField,
      subjectId,
      listingId,
      subjectWorkspaceId
    });
    if (subject) {
      const canonicalListingId = boundedString(listingId(subject));
      const canonicalSubjectId = boundedString(subjectId(subject));
      if (canonicalListingId) rating.listing_id = canonicalListingId;
      if (canonicalSubjectId) rating[subjectIdField] = canonicalSubjectId;
      const ratingUserId = boundedString(rating.created_by);
      const rawPublisherIds = publisherIds(subject);
      const subjectPublisherIds = (Array.isArray(rawPublisherIds)
        ? rawPublisherIds
        : [rawPublisherIds])
        .map(boundedString)
        .filter(Boolean);
      if (ratingUserId && subjectPublisherIds.includes(ratingUserId)) {
        continue;
      }
    }

    const canonicalListingId = boundedString(rating.listing_id);
    const publicUserId = boundedString(rating.created_by);
    const identity = canonicalListingId && publicUserId
      ? `${canonicalListingId}\0${publicUserId}`
      : null;
    if (!identity) {
      normalized.push(rating);
      continue;
    }
    const existingIndex = identityIndexes.get(identity);
    if (existingIndex === undefined) {
      identityIndexes.set(identity, normalized.length);
      normalized.push(rating);
      continue;
    }
    normalized[existingIndex] = preferRating(normalized[existingIndex], rating);
  }
  return normalized;
}
