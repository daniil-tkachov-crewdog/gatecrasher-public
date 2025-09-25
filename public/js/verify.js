// Keep dataLayer defined early for any analytics pushes
window.dataLayer = window.dataLayer || [];

// Import Supabase ESM directly (matches your original inline approach)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Project config (reused across pages)
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

(async () => {
    const errBox = document.getElementById("err");

    try {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const access_token = params.get("access_token");
        const refresh_token = params.get("refresh_token");
        const type = params.get("type"); // 'signup' | 'email_change' (others ignored)

        // Nothing to do if tokens are missing or the flow type isn't relevant
        if (!access_token || !refresh_token) return;
        if (type !== "signup" && type !== "email_change") return;

        const { error } = await supabase.auth.setSession({ access_token, refresh_token });
        if (error) throw error;

        // Clean the URL (remove hash params)
        if (window.history.replaceState) {
            const clean = window.location.origin + window.location.pathname;
            window.history.replaceState({}, document.title, clean);
        } else {
            window.location.hash = "";
        }

        // Analytics (optional)
        window.dataLayer.push({ event: "email_verified", flow_type: type });

    } catch (e) {
        if (errBox) {
            errBox.style.display = "block";
            errBox.textContent = "Verification failed: " + (e?.message || String(e));
        }
    }
})();
