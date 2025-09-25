import "./theme.js";

// Ensure dataLayer exists (future analytics-friendly)
window.dataLayer = window.dataLayer || [];

// Consent status UI
(function () {
    const statusEl = document.getElementById("consent-status");
    const btnOpen = document.getElementById("btnOpen");
    const btnAccept = document.getElementById("btnAccept");
    const btnReject = document.getElementById("btnReject");

    function readSaved() {
        try { return JSON.parse(localStorage.getItem("gc-consent-v1") || "null"); }
        catch { return null; }
    }

    function updateStatus() {
        if (!statusEl) return;
        const saved = readSaved();
        if (!saved) { statusEl.textContent = "Status: not set (first visit)"; return; }
        const on = saved.analytics_storage === "granted";
        statusEl.textContent = "Status: " + (on ? "analytics enabled" : "analytics disabled");
    }

    // Wire buttons to consent.js helpers if present
    if (btnOpen) btnOpen.addEventListener("click", () => { window.gcConsent?.open(); });
    if (btnAccept) btnAccept.addEventListener("click", () => {
        window.gcConsent?.accept();
        setTimeout(updateStatus, 50);
    });
    if (btnReject) btnReject.addEventListener("click", () => {
        window.gcConsent?.reject();
        setTimeout(updateStatus, 50);
    });

    // Optional: listen for a custom event if consent.js emits one
    window.addEventListener("gc:consentchange", updateStatus);

    // Initial render
    updateStatus();
})();
