import { MAX_MESSAGE_CHARS } from "./runtimePlanValidator.js";

export function validateUserMessage(content) {
  if (typeof content !== "string" || content.trim().length === 0) {
    const error = new Error("Message content is required.");
    error.status = 400;
    throw error;
  }
  if (content.length > MAX_MESSAGE_CHARS) {
    const error = new Error(`Message is too long. Limit is ${MAX_MESSAGE_CHARS} characters.`);
    error.status = 413;
    throw error;
  }
}


