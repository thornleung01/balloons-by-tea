/*
  Balloons by Tea — Supabase connection settings.

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
  url: "https://zqtwpkgyvyylhdrreexd.supabase.co",
  anonKey: "sb_publishable_bYlGCbPT9Ka6O6xTUWR3jQ_mZTB0VTB"
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
    console.warn("[Balloons by Tea] Supabase library didn't load (offline, or the CDN is blocked).");
    return null;
  }
  if (!_auraSupabaseClient) {
    _auraSupabaseClient = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
  }
  return _auraSupabaseClient;
}

/* True when a Supabase error means the table/function hasn't been created
   yet (supabase-setup.sql not run), as opposed to any other failure.
   Shared so every admin card detects it the same way: Postgres code
   42P01 (undefined table), PostgREST PGRST205/PGRST202 (table/function
   not in schema cache), with the message text as a fallback. */
function isMissingTableError(error, name) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202") return true;
  const msg = error.message || "";
  if (/could not find the (table|function)/i.test(msg)) return true;
  return Boolean(name) && msg.includes("relation") && msg.includes(name) && msg.includes("does not exist");
}
