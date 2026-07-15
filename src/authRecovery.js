export const AUTHENTICATION_REQUIRED_EVENT = "virenis:authentication-required";

let authenticationNotificationPending = false;

export function authenticationFailureDetails(error = {}, origin = currentOrigin()) {
  const reason = String(error?.authReason || error?.reason || "").trim();
  const originMismatch = reason === "token-invalid-authorized-parties";
  return {
    status: Number(error?.status || 401),
    code: String(error?.code || "authentication_required"),
    reason,
    request_id: String(error?.requestId || error?.request_id || ""),
    origin: String(origin || ""),
    title: originMismatch ? "This site address is not authorized" : "Your session could not be verified",
    message: originMismatch
      ? "Clerk signed you in, but this server does not recognize the address used to open Virenis. Open the configured Virenis URL or ask the administrator to add this address to the authorized Clerk origins."
      : "Clerk signed you in, but the Virenis server could not verify that session. Refresh the session and try again, or sign out and start a new sign-in."
  };
}

export function notifyAuthenticationRequired(error = {}, windowObject = globalThis.window) {
  if (!windowObject?.dispatchEvent || authenticationNotificationPending) return false;
  authenticationNotificationPending = true;
  const detail = authenticationFailureDetails(error, windowObject.location?.origin);
  const EventConstructor = windowObject.CustomEvent || globalThis.CustomEvent;
  const event = EventConstructor
    ? new EventConstructor(AUTHENTICATION_REQUIRED_EVENT, { detail })
    : Object.assign(new windowObject.Event(AUTHENTICATION_REQUIRED_EVENT), { detail });
  windowObject.dispatchEvent(event);
  return true;
}

export function resetAuthenticationNotification() {
  authenticationNotificationPending = false;
}

export function shouldOpenWorkspaceFromIdentity({ isSignedIn, authenticationFailure }) {
  return Boolean(isSignedIn && !authenticationFailure);
}

function currentOrigin() {
  return typeof window === "undefined" ? "" : window.location?.origin || "";
}
