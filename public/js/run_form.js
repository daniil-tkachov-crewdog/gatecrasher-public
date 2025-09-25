import { disable } from "./helpers.js";
import { renderTemplate } from "./render.js";

(function () {
    const form = document.getElementById("gatecrasher-form");
    const result = document.getElementById("result");
    const jd = document.getElementById("JD");
    const jhBox = document.getElementById("JH_tickbox");
    const btn = document.getElementById("submitBtn");

    if (!form || !result) return;

    let lastWantsLeads = false;

    form.addEventListener("submit", async function (ev) {
        ev.preventDefault();

        disable(btn, true);
        if (btn) btn.textContent = "Working…";

        try {
            const fd = new FormData(form);

            // Normalize JH value to explicit "yes"/"no"
            lastWantsLeads = !!(jhBox && jhBox.checked);
            fd.set("JH_tickbox", lastWantsLeads ? "yes" : "no");

            // === GA4 (via GTM) — log intent ===
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({ event: "run_search", with_leads: lastWantsLeads });

            // Preserve prior behavior for saver flag
            if (!fd.has("Save to the doc file and the spreadsheet? (+10 sec)")) {
                fd.append("Save to the doc file and the spreadsheet? (+10 sec)", "No");
            }

            // Call webhook
            const resp = await fetch(form.getAttribute("action"), { method: "POST", body: fd });

            // Expect JSON; fallback to text
            let data, asText = null;
            const ct = (resp.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("application/json")) {
                data = await resp.json();
            } else {
                asText = await resp.text();
                try { data = JSON.parse(asText); } catch (_) { }
            }

            if (data && typeof data === "object") {
                const payload = Array.isArray(data) ? data[0] : data; // supports both outputs
                result.innerHTML = renderTemplate(payload, { wantsLeads: lastWantsLeads });
            } else {
                result.innerHTML = '<div class="panel">' + (asText || "No response") + "</div>";
            }
        } catch (err) {
            result.innerHTML =
                '<div class="gc-error"><strong>Error:</strong> ' +
                (err && err.message ? err.message : String(err)) +
                "</div>";
        } finally {
            disable(btn, false);
            if (btn) btn.textContent = "Run Search";
        }
    });
})();
