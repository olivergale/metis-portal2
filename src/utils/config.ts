// Centralized config — use env vars with hardcoded fallback for dev
export const SUPABASE_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_SUPABASE_URL) ||
  "https://phfblljwuvzqzlbzkzpr.supabase.co";

export const SUPABASE_ANON_KEY =
  (typeof import.meta !== "undefined" &&
    import.meta.env?.VITE_SUPABASE_ANON_KEY) ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBoZmJsbGp3dXZ6cXpsYnprenByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1MjAzODgsImV4cCI6MjA4NTA5NjM4OH0.mWIj2vtQb1F2Pk540f_S9WwsZFwZK0n6oeqUmZgDZlA";

export const LANGTRACE_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_LANGTRACE_URL) ||
  "";

export const GRAFANA_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_GRAFANA_URL) ||
  "";
