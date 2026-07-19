import { describe, expect, it, vi } from "vitest";
import {
  normalizeDiagnosticError,
  projectRuntimeFailure,
  projectValidationResult,
  safeDiagnosticLog
} from "../server/diagnostics.js";
import { classifyRunFailure } from "../server/tcarEngine.js";

const SENTINEL = "private-customer-token-super-secret-value";

describe("diagnostic privacy", () => {
  it("projects arbitrary exceptions into content-free support metadata", () => {
    const error = new Error(`Bearer ${SENTINEL}`);
    error.code = "model_service_unavailable";
    error.status = 502;
    error.providerStatus = 503;
    error.requestId = "provider-request-123";
    error.payload = {
      nested: { password: SENTINEL },
      url: `https://user:${SENTINEL}@example.test/callback?token=${SENTINEL}`
    };

    const diagnostic = normalizeDiagnosticError(error);

    expect(diagnostic).toMatchObject({
      code: "model_service_unavailable",
      status: 502,
      provider_status: 503,
      provider_request_id: "provider-request-123",
      error_type: "Error"
    });
    expect(diagnostic.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(diagnostic)).not.toContain(SENTINEL);
    expect(JSON.stringify(diagnostic)).not.toContain("Bearer");
    expect(JSON.stringify(diagnostic)).not.toContain("password");

    const structurallyEquivalent = new Error("a completely different low-entropy value");
    structurallyEquivalent.code = error.code;
    structurallyEquivalent.status = error.status;
    structurallyEquivalent.providerStatus = error.providerStatus;
    expect(normalizeDiagnosticError(structurallyEquivalent).fingerprint).toBe(diagnostic.fingerprint);
  });

  it("logs only allowlisted context and sanitized diagnostics", () => {
    const logger = vi.fn();
    const error = new Error(SENTINEL);
    error.payload = { query: SENTINEL };

    safeDiagnosticLog("http.request_failed", {
      operation: "api_request",
      request_id: "request-safe-123",
      user_id: SENTINEL,
      path: `/users/${SENTINEL}`,
      status: 500
    }, error, logger);

    expect(logger).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(logger.mock.calls);
    expect(serialized).toContain("request-safe-123");
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain("user_id");
    expect(serialized).not.toContain("path");
  });

  it("drops runtime response bodies while retaining classification fields", () => {
    const projected = projectRuntimeFailure({
      detail: {
        code: "model_timeout",
        retryable: true,
        provider_status: 504,
        request_id: "provider-request-456",
        component: "agent_execution_or_synthesis",
        stderr: SENTINEL
      },
      raw: SENTINEL
    }, 504);

    expect(projected).toEqual({
      code: "model_timeout",
      status: 504,
      retryable: true,
      provider_status: 504,
      provider_request_id: "provider-request-456",
      component: "agent_execution_or_synthesis"
    });
    expect(JSON.stringify(projected)).not.toContain(SENTINEL);
  });

  it("keeps structured provider and transport failures in distinct classes", () => {
    const cases = [
      {
        error: { code: "model_configuration_error", status: 502, providerStatus: 401 },
        expected: { code: "model_configuration_error", retryable: false }
      },
      {
        error: { code: "model_request_rejected", status: 502, providerStatus: 400 },
        expected: { code: "model_request_rejected", retryable: false }
      },
      {
        error: { code: "runtime_stream_invalid", status: 502 },
        expected: { code: "runtime_protocol_error", retryable: false }
      },
      {
        error: { code: "runtime_connection_reset", status: 502, retryable: true },
        expected: { code: "model_connection_interrupted", retryable: true }
      },
      {
        error: { code: "model_service_unavailable", status: 502, retryable: true },
        expected: { code: "model_service_unavailable", retryable: true }
      },
      {
        error: { code: "runtime_service_error", status: 502 },
        expected: { code: "runtime_service_error", retryable: false }
      }
    ];
    for (const row of cases) {
      expect(classifyRunFailure(row.error)).toMatchObject(row.expected);
    }
  });

  it("stores validation shape without stdout, stderr, or summary text", () => {
    const result = projectValidationResult({
      ok: false,
      suite: "live_smoke",
      returncode: 1,
      elapsed_sec: 1.25,
      stdout: SENTINEL,
      stderr: SENTINEL,
      summary: {
        cases: 3,
        ok: false,
        failure: SENTINEL,
        nested: [{ label: SENTINEL, passed: true }]
      }
    });

    expect(result).toMatchObject({
      ok: false,
      suite: "live_smoke",
      returncode: 1,
      elapsed_sec: 1.25,
      output_present: true,
      summary: {
        cases: 3,
        ok: false,
        failure: { text_present: true, length: SENTINEL.length }
      }
    });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain("stdout");
    expect(JSON.stringify(result)).not.toContain("stderr");
  });
});
