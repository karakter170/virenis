import { ClerkProvider } from "@clerk/react";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import "./landing.css";

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!clerkPublishableKey) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required to start Virenis.");
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      signInUrl="/login"
      signUpUrl="/register"
      signInFallbackRedirectUrl="/app"
      signUpFallbackRedirectUrl="/app"
      afterSignOutUrl="/"
      appearance={{
        variables: {
          colorPrimary: "#176b4b",
          colorBackground: "#ffffff",
          colorForeground: "#202321",
          colorNeutral: "#626864",
          colorInput: "#ffffff",
          colorInputForeground: "#202321",
          borderRadius: "0.5rem",
          fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
        },
        elements: {
          cardBox: { boxShadow: "none", width: "100%" },
          card: { boxShadow: "none", border: 0, width: "100%" },
          headerTitle: { letterSpacing: "-0.02em" },
          footer: { background: "transparent" }
        }
      }}
    >
      <App />
    </ClerkProvider>
  </React.StrictMode>
);
