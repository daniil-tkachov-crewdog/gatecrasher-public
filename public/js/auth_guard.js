import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// Uses global window.supabase from CDN script in run.html
(function () {
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    supabase.auth.getSession().then((res) => {
        const session = res && res.data ? res.data.session : null;
        if (!session) window.location.replace("./login.html");
    });

    supabase.auth.onAuthStateChange((_event, session) => {
        if (!session) window.location.replace("./login.html");
    });
})();
