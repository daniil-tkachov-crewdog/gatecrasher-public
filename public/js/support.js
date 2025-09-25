import { show, disable, validEmail } from "./helpers.js";

(function () {
    const form = document.getElementById("support-form");
    if (!form) return;

    const success = document.getElementById("support-success");
    const errorBox = document.getElementById("support-error");
    const btn = document.getElementById("sendBtn");

    form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        show(success, ""); show(errorBox, "");

        const email = document.getElementById("email")?.value?.trim();
        const message = document.getElementById("message")?.value?.trim();
        const honey = document.getElementById("company")?.value || ""; // honeypot

        // Silent-accept bots to avoid feedback loop
        if (honey) { form.reset(); show(success, "Thanks — your message was sent."); return; }

        if (!validEmail(email)) {
            show(errorBox, "Enter a valid email."); return;
        }
        if (!message || message.length < 5) {
            show(errorBox, "Please add more detail to your message."); return;
        }

        disable(btn, true); if (btn) btn.textContent = "Sending…";

        try {
            const fd = new FormData(form);
            const resp = await fetch(form.getAttribute("action"), { method: "POST", body: fd });
            if (!resp.ok) throw new Error("Request failed: " + resp.status);

            form.reset();
            show(success, "Thanks — your message was sent. We’ll get back to you if we need more details.");

            // GA4 via GTM
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({ event: "support_submit" });

        } catch (e) {
            console.error("Support submit error:", e);
            show(errorBox, "Something went wrong. Please try again.");
        } finally {
            disable(btn, false); if (btn) btn.textContent = "Submit";
        }
    });
})();
