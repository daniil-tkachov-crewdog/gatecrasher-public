// Reuse existing shared modules
import { initThemeToggle } from "./theme.js";
import { initSupportForm } from "./support.js";

let _initialized = false;

function initSupportPage() {
    if (_initialized) return;
    _initialized = true;

    try { initThemeToggle && initThemeToggle(); }
    catch (e) { console.error("[support] initThemeToggle failed:", e); }

    try { initSupportForm && initSupportForm(); }
    catch (e) { console.error("[support] initSupportForm failed:", e); }

    // Optional signal for tests/other scripts
    document.dispatchEvent(new CustomEvent("support:initialized"));
    window.__supportInitialized = true;
}

// Run once DOM is ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSupportPage, { once: true });
} else {
    initSupportPage();
}

export { initSupportPage }; // handy if you need to re-init in an SPA
