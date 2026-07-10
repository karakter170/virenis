import { describe, expect, it } from "vitest";
import {
  evidenceQuoteIsValid,
  extractBinaryPrediction,
  findEvidenceQuote,
  outcomeIsDue,
  tomorrowDateValue
} from "../src/outcomeEvidence.js";

describe("outcome evidence UI helpers", () => {
  it("extracts a percent prediction with an exact evidence quote", () => {
    const output = "After reviewing the evidence, there is a 72% chance the threshold will be met. Recheck in Q3.";
    const result = extractBinaryPrediction(output);
    expect(result.probability).toBe(0.72);
    expect(result.percent).toBe("72");
    expect(output).toContain(result.evidenceQuote);
    expect(evidenceQuoteIsValid(output, result.evidenceQuote, 0.72, "binary")).toBe(true);
  });

  it("extracts a decimal only when it is identified as a probability", () => {
    expect(extractBinaryPrediction("Estimated probability: 0.35 based on the current evidence.")?.probability).toBe(0.35);
    expect(extractBinaryPrediction("Revenue was 0.35 million in 2026.")).toBeNull();
    expect(extractBinaryPrediction("Confidence is 80%, but no outcome probability was stated.")).toBeNull();
    expect(extractBinaryPrediction("1. Risk category: high.")).toBeNull();
  });

  it("finds numeric and categorical evidence and rejects altered quotes", () => {
    const output = "The forecast is 125 units. The expected category is delayed.";
    const numeric = findEvidenceQuote(output, 125, "numeric");
    const categorical = findEvidenceQuote(output, "delayed", "categorical");
    expect(evidenceQuoteIsValid(output, numeric, 125, "numeric")).toBe(true);
    expect(evidenceQuoteIsValid(output, categorical, "delayed", "categorical")).toBe(true);
    expect(evidenceQuoteIsValid(output, "The forecast is 126 units.", 126, "numeric")).toBe(false);
  });

  it("returns a local next-day date for the minimum due date", () => {
    expect(tomorrowDateValue(new Date(2026, 6, 9, 23, 30))).toBe("2026-07-10");
  });

  it("only allows settlement at or after the frozen due time", () => {
    const contract = { resolution: { due_at: "2026-07-10T12:00:00.000Z" } };
    expect(outcomeIsDue(contract, Date.parse("2026-07-10T11:59:59.999Z"))).toBe(false);
    expect(outcomeIsDue(contract, Date.parse("2026-07-10T12:00:00.000Z"))).toBe(true);
    expect(outcomeIsDue({ due_at: "not-a-date" }, Date.now())).toBe(false);
  });
});
