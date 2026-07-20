import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeSessionViewReady,
  assertRunSession
} from "../e2e/pipelineSessionBinding.js";

describe("pipeline browser session binding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits for the exact empty session view instead of a stale active chat", () => {
    const appShell = { getAttribute: vi.fn(() => "sess_new") };
    const querySelector = vi.fn(() => appShell);
    const querySelectorAll = vi.fn(() => []);
    vi.stubGlobal("document", { querySelector, querySelectorAll });

    expect(activeSessionViewReady("sess_new")).toBe(true);
    expect(activeSessionViewReady("sess_old")).toBe(false);
    querySelectorAll.mockReturnValue([{}]);
    expect(activeSessionViewReady("sess_new")).toBe(false);
  });

  it("fails closed when a run belongs to any session other than the created chat", () => {
    expect(() => assertRunSession("sess_new", "sess_new")).not.toThrow();
    expect(() => assertRunSession("sess_new", "sess_old"))
      .toThrow("Run/session mismatch: created sess_new, received sess_old.");
    expect(() => assertRunSession("sess_new", "")).toThrow(/received none/u);
  });
});
