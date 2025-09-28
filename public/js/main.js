import { initThemeToggle } from "./theme.js";
import { initViews } from "./views.js";
import { initGoogleLogin, initPasswordLogin, initRegister } from "./auth.js";

let _initialized = false;

function initMain() {
    if (_initialized) return;
    _initialized = true;

    // Preserve original order
    try { initThemeToggle && initThemeToggle(); }
    catch (e) { console.error("[main] initThemeToggle failed:", e); }

    try { initViews && initViews(); }
    catch (e) { console.error("[main] initViews failed:", e); }

    try { initGoogleLogin && initGoogleLogin(); }
    catch (e) { console.error("[main] initGoogleLogin failed:", e); }

    try { initPasswordLogin && initPasswordLogin(); }
    catch (e) { console.error("[main] initPasswordLogin failed:", e); }

    try { initRegister && initRegister(); }
    catch (e) { console.error("[main] initRegister failed:", e); }

    // Optional: signal to other scripts/tests
    document.dispatchEvent(new CustomEvent("app:initialized"));
    window.__appInitialized = true;
}

// Run once DOM is ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initMain, { once: true });
} else {
    initMain();
}
