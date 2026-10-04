/*
  Aura Balloon Co. — Supabase connection settings.

  Until both values below are filled in, the site and the admin page
  (admin.html) both just show a "not configured yet" state instead of
  breaking — see supabase-setup.sql and README.md "Live admin page
  (Supabase)" for the one-time setup.

  Both of these are meant to be public/client-side — that's how Supabase
  is designed to work. The real protection is the Row Level Security
  rules in supabase-setup.sql (only a logged-in user can write), not
  keeping this key secret.
*/
const SUPABASE_CONFIG = {
  url: "PASTE_YOUR_SUPABASE_PROJECT_URL_HERE",
  anonKey: "PASTE_YOUR_SUPABASE_ANON_PUBLIC_KEY_HERE"
};

function isSupabaseConfigured() {
  return (
    !!SUPABASE_CONFIG.url &&
    !SUPABASE_CONFIG.url.includes("PASTE_YOUR") &&
    !!SUPABASE_CONFIG.anonKey &&
    !SUPABASE_CONFIG.anonKey.includes("PASTE_YOUR")
  );
}

let _auraSupabaseClient = null;
function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    console.warn("[Aura Balloon Co.] Supabase library didn't load (offline, or the CDN is blocked).");
    return null;
  }
  if (!_auraSupabaseClient) {
    _auraSupabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
  }
  return _auraSupabaseClient;
}
