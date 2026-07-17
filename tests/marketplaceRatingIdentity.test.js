import { describe, expect, it } from "vitest";

import { normalizePublicMarketplaceRatings } from "../server/marketplaceRatingIdentity.js";

const options = {
  subjects: [{ id: "agent_a", marketplace: { listing_id: "listing_new", published_by: "alice" } }],
  subjectIdField: "agent_id",
  subjectId: (agent) => agent.id,
  listingId: (agent) => agent.marketplace?.listing_id,
  publisherIds: (agent) => [agent.marketplace?.published_by, agent.created_by],
  subjectWorkspaceId: (agent) => agent.workspace_id
};

describe("Marketplace rating revision identity", () => {
  it("never relabels an explicit old-revision rating onto a new listing", () => {
    const [rating] = normalizePublicMarketplaceRatings([{
      rating_id: "rating_old",
      listing_id: "listing_old",
      agent_id: "agent_a",
      created_by: "bob",
      score: 4
    }], options);

    expect(rating).toMatchObject({
      listing_id: "listing_old",
      agent_id: "agent_a",
      created_by: "bob",
      score: 4
    });
  });

  it("still upgrades a truly legacy row that has no listing id", () => {
    const [rating] = normalizePublicMarketplaceRatings([{
      rating_id: "rating_legacy",
      agent_id: "agent_a",
      created_by: "bob",
      score: 5
    }], options);

    expect(rating.listing_id).toBe("listing_new");
  });
});
