// Reuse the same theme toggle logic from your existing theme.js
import { initThemeToggle } from "./theme.js";

function initFAQPage() {
    // Set up theme toggle switch
    initThemeToggle();

    // No extra JS needed for <details>/<summary> FAQ interactions
    console.debug("FAQ page initialized");
}

// Run once DOM is loaded
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initFAQPage);
} else {
    initFAQPage();
}
