// /public/js/run_form.js
import { disable } from "./helpers.js";
import { renderTemplate } from "./render.js";

export function initRunForm({
    formId = "gatecrasher-form",
    resultId = "result",
    jdId = "JD",
    leadsCheckboxId = "JH_tickbox",
    submitId = "submitBtn",
} = {}) {
    const form = document.getElementById(formId);
    const result = document.getElementById(resultId);
    const jd = document.getElementById(jdId);
    const jhBox = document.getElementById(leadsCheckboxId);
    const btn = document.getElementById(submitId);

    if (!form || !result) return;

    // Prevent duplicate listener on hot-reload or accidental re-init
    if (form.dataset.init === "1") return;
    form.dataset.init = "1";

    let lastWantsLeads = false;

    form.addEventListener("submit", async (ev) => {
        ev.preventDefault();

        disable(btn, true);
        if (btn) btn.textContent = "Working…";

        try {
            const fd = new FormData(form);

            // Normalize JH value to explicit "yes"/"no"
            lastWantsLeads = !!(jhBox && jhBox.checked);
            fd.set("JH_tickbox", lastWantsLeads ? "yes" : "no");

            // GA4 (via GTM) — log intent
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({ event: "run_search", with_leads: lastWantsLeads });

            // Preserve prior behavior for saver flag
            const saverKey = "Save to the doc file and the spreadsheet? (+10 sec)";
            if (!fd.has(saverKey)) fd.append(saverKey, "No");

            // Call webhook
            const resp = await fetch(form.getAttribute("action"), { method: "POST", body: fd });

            // Expect JSON; fallback to text
            let data, asText = null;
            const ct = (resp.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("application/json")) {
                data = await resp.json();
            } else {
                asText = await resp.text();
                try { data = JSON.parse(asText); } catch { }
            }

            if (data && typeof data === "object") {
                const payload = Array.isArray(data) ? data[0] : data; // supports both outputs
                result.innerHTML = renderTemplate(payload, { wantsLeads: lastWantsLeads });

                // GTM success event (optional fields)
                window.dataLayer.push({
                    event: "run_search_success",
                    with_leads: lastWantsLeads,
                });

                // Notify Account page to refresh quota immediately
                try {
                    const bc = new BroadcastChannel("gc-activity");
                    bc.postMessage({ type: "search_used", ts: Date.now() });
                    bc.close && bc.close();
                } catch { }

                // Optional toast if your notify system exists
                if (window.__notify) window.__notify("Search complete.", "success");
            } else {
                result.innerHTML = `<div class="panel">${asText || "No response"}</div>`;
                window.dataLayer.push({ event: "run_search_success", with_leads: lastWantsLeads });
                try {
                    const bc = new BroadcastChannel("gc-activity");
                    bc.postMessage({ type: "search_used", ts: Date.now() });
                    bc.close && bc.close();
                } catch { }
                if (window.__notify) window.__notify("Search complete.", "success");
            }
        } catch (err) {
            // Error UI
            result.innerHTML = `
        <div class="gc-error"><strong>Error:</strong> ${err?.message || String(err)}</div>
      `;

            // GTM error event
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({ event: "run_search_error", message: err?.message || String(err) });

            if (window.__notify) window.__notify("Something went wrong. Please try again.", "error");
        } finally {
            disable(btn, false);
            if (btn) btn.textContent = "Run Search";
        }
    });
}
