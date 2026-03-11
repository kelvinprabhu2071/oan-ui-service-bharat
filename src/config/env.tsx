// ===========================================
// Centralized Environment Configuration
// ===========================================
// All environment variables are accessed here. No hardcoded values elsewhere.

// --- API ---
export const API_URL = import.meta.env.VITE_API_URL || "";

// --- Telemetry ---
export const TELEMETRY_HOST = import.meta.env.VITE_TELEMETRY_HOST || "/observability-service";

// --- Authentication ---
export const BYPASS_AUTH = import.meta.env.VITE_BYPASS_AUTH === "true";
export const AUTH_TOKEN = import.meta.env.VITE_AUTH_TOKEN || "";

// --- Bypass Auth: Token Generation ---
// When BYPASS_AUTH=true, these values are sent to POST /api/token to obtain an access token.
export const BYPASS_AUTH_MOBILE = import.meta.env.VITE_BYPASS_AUTH_MOBILE || "0000000000";
export const BYPASS_AUTH_NAME = import.meta.env.VITE_BYPASS_AUTH_NAME || "Dev User";
export const BYPASS_AUTH_ROLE = import.meta.env.VITE_BYPASS_AUTH_ROLE || "developer";
export const BYPASS_AUTH_METADATA = import.meta.env.VITE_BYPASS_AUTH_METADATA || null;
