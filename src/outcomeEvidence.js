const PROBABILITY_CONTEXT = /\b(probability|chance|likelihood|odds)\b/i;
const CONFIDENCE_CONTEXT = /\bconfidence\b/i;

export function extractBinaryPrediction(recordedOutput) {
  const text = String(recordedOutput || "");
  const candidates = numericTokens(text)
    .flatMap((candidate) => {
      const probability = candidate.percent ? candidate.number / 100 : candidate.number;
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) return [];
      const precedingContext = text.slice(Math.max(0, candidate.index - 80), candidate.index);
      const followingContext = text.slice(candidate.end, Math.min(text.length, candidate.end + 40));
      const hasProbabilityContext = probabilityContextTouchesValue(precedingContext, followingContext);
      if (!candidate.percent && !hasProbabilityContext) return [];
      if (candidate.percent && CONFIDENCE_CONTEXT.test(precedingContext) && !PROBABILITY_CONTEXT.test(precedingContext)) return [];
      return [{
        ...candidate,
        probability,
        score: hasProbabilityContext ? 2 : 1
      }];
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const match = candidates[0];
  if (!match) return null;
  return {
    probability: match.probability,
    percent: cleanDecimal(match.probability * 100),
    evidenceQuote: quoteAround(text, match.index, match.end)
  };
}

function probabilityContextTouchesValue(preceding, following) {
  const before = preceding.match(/\b(probability|chance|likelihood|odds)\b[^.!?\n]{0,28}$/i);
  const after = following.match(/^\s*(?:probability|chance|likelihood|odds)\b/i);
  return Boolean(before || after);
}

export function findEvidenceQuote(recordedOutput, value, outcomeType) {
  const text = String(recordedOutput || "");
  if (!text.trim()) return "";
  if (outcomeType === "categorical") {
    const expected = String(value || "").trim();
    if (!expected) return "";
    const match = boundedTextMatch(text, expected);
    return match ? quoteAround(text, match.index, match.index + match[0].length) : "";
  }
  const expected = Number(value);
  if (!Number.isFinite(expected)) return "";
  const match = numericTokens(text).find((candidate) => {
    if (candidate.percent && outcomeType !== "binary") return false;
    const normalized = candidate.percent ? candidate.number / 100 : candidate.number;
    return numbersEqual(normalized, expected);
  });
  return match ? quoteAround(text, match.index, match.end) : "";
}

export function evidenceQuoteIsValid(recordedOutput, quote, value, outcomeType) {
  const output = String(recordedOutput || "");
  const evidence = String(quote || "").trim();
  if (!evidence || evidence.length > 500 || !output.toLowerCase().includes(evidence.toLowerCase())) return false;
  if (outcomeType === "categorical") {
    return Boolean(boundedTextMatch(evidence, String(value || "").trim()));
  }
  const expected = Number(value);
  if (!Number.isFinite(expected)) return false;
  return numericTokens(evidence).some((candidate) => {
    if (candidate.percent && outcomeType !== "binary") return false;
    const normalized = candidate.percent ? candidate.number / 100 : candidate.number;
    return numbersEqual(normalized, expected);
  });
}

export function tomorrowDateValue(now = new Date()) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const year = tomorrow.getFullYear();
  const month = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const day = String(tomorrow.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function outcomeIsDue(contractOrSummary, now = Date.now()) {
  const dueAt = contractOrSummary?.resolution?.due_at || contractOrSummary?.due_at;
  const dueTime = Date.parse(String(dueAt || ""));
  const observedTime = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(dueTime) && Number.isFinite(observedTime) && observedTime >= dueTime;
}

function numericTokens(text) {
  const pattern = /(^|[^\p{L}\p{N}_])([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?%?)(?=$|[^\p{L}\p{N}_])/giu;
  return [...String(text).matchAll(pattern)].flatMap((match) => {
    const token = match[2];
    const percent = token.endsWith("%");
    const number = Number(percent ? token.slice(0, -1) : token);
    if (!Number.isFinite(number)) return [];
    const index = (match.index || 0) + match[1].length;
    return [{ token, percent, number, index, end: index + token.length }];
  });
}

function boundedTextMatch(text, expected) {
  if (!expected) return null;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, "iu").exec(text);
  if (!match) return null;
  return { 0: match[2], index: (match.index || 0) + match[1].length };
}

function quoteAround(text, tokenStart, tokenEnd) {
  let start = Math.max(0, tokenStart - 220);
  let end = Math.min(text.length, Math.max(tokenEnd + 220, start + 1));
  if (end - start > 500) end = start + 500;
  if (tokenEnd > end) {
    end = Math.min(text.length, tokenEnd + 20);
    start = Math.max(0, end - 500);
  }
  const before = text.slice(start, tokenStart);
  const boundaryBefore = Math.max(before.lastIndexOf("\n"), before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
  if (boundaryBefore >= 0) start += boundaryBefore + (before[boundaryBefore] === "\n" ? 1 : 2);
  const after = text.slice(tokenEnd, Math.min(text.length, start + 500));
  const boundaryAfter = after.search(/[.!?](?:\s|$)|\n/);
  if (boundaryAfter >= 0) end = Math.min(start + 500, tokenEnd + boundaryAfter + 1);
  else end = Math.min(text.length, start + 500);
  return text.slice(start, end).trim().slice(0, 500);
}

function numbersEqual(left, right) {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(Number(right)));
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

function cleanDecimal(value) {
  return String(Number(Number(value).toFixed(10)));
}
