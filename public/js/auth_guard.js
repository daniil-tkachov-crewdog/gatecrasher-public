// Auth guard with explicit init; no IIFE
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export function initAuthGuard({
    redirectTo = "./login.html",
    client, // optional: pass a supabase client
} = {}) {
    // Avoid double init
    if (window.__xrl_auth_guard__) return;
    window.__xrl_auth_guard__ = true;

    const supabase =
        client ||
        (window.supabase && window.supabase.createClient
            ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
            : null);

    if (!supabase) {
        console.warn("[auth_guard] Supabase client not available.");
        return;
    }

    // Expose for other modules that might read session/email
    window.__xrl_supabase__ = supabase;

    supabase.auth.getSession().then((res) => {
        const session = res?.data?.session ?? null;
        if (!session) window.location.replace(redirectTo);
    });

    supabase.auth.onAuthStateChange((_event, session) => {
        if (!session) window.location.replace(redirectTo);
    });
}
