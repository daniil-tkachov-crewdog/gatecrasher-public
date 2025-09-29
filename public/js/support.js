// Support form handler (refactored from inline script, unchanged behavior)
import { validEmail } from "./helpers.js";

export function initSupportForm() {
    const form = document.getElementById("support-form");
    const success = document.getElementById("support-success");
    const errorBox = document.getElementById("support-error");
    const btn = document.getElementById("sendBtn");

    // Local show helper matches original boolean on/off behavior
    function show(el, on) { if (!el) return; el.style.display = on ? "block" : "none"; }

    if (!form) return;

    form.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        show(success, false);
        show(errorBox, false);

        const email = document.getElementById("email").value.trim();
        const message = document.getElementById("message").value.trim();
        const honey = document.getElementById("company").value; // honeypot

        if (honey) { show(success, true); form.reset(); return; } // silent drop bots
        if (!validEmail(email)) { errorBox.textContent = "Enter a valid email."; show(errorBox, true); return; }
        if (!message || message.length < 5) { errorBox.textContent = "Please add more detail to your message."; show(errorBox, true); return; }

        if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
        try {
            const fd = new FormData(form);
            const resp = await fetch(form.getAttribute("action"), { method: "POST", body: fd });
            if (!resp.ok) throw new Error("Request failed: " + resp.status);

            form.reset();
            show(success, true);

            // === GA4 (via GTM) — log successful support submission ===
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({ event: "support_submit" });
        } catch (e) {
            errorBox.textContent = "Something went wrong. Please try again.";
            show(errorBox, true);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "Submit"; }
        }
    });
}
