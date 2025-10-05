// /public/js/run_form.js
import { disable } from "./helpers.js";
import { renderTemplate } from "./render.js";

export function initRunForm({
    formId = "gatecrasher-form",
    resultId = "result",
    jdId = "JD",
    jdLinkId = "JD_link",          // field for job description link
    leadsCheckboxId = "JH_tickbox",
    submitId = "submitBtn",
} = {}) {
    const form = document.getElementById(formId);
    const result = document.getElementById(resultId);
    const jd = document.getElementById(jdId);
    const jdLink = document.getElementById(jdLinkId);
    const jhBox = document.getElementById(leadsCheckboxId);
    const btn = document.getElementById(submitId);

    if (!form || !result) return;

    // Prevent duplicate listener on hot-reload or accidental re-init
    if (form.dataset.init === "1") return;
    form.dataset.init = "1";

    let lastWantsLeads = false;

    /* ---------------- Helpers: loader + overlay ---------------- */
    const toggleOverlay = (on) => {
        const ov = document.getElementById("searchLoader");
        if (ov) ov.classList.toggle("visible", !!on);
    };
    const setBtnLoading = (on) => {
        if (!btn) return;
        btn.classList.toggle("loading", !!on); // CSS shows spinner when .loading
        btn.disabled = !!on;
    };

    /* ==========================================================
       MUTUAL EXCLUSION: JD vs JD_link
       ========================================================== */
    if (jd && jdLink) {
        const checkMutualExclusion = (changedEl) => {
            const jdHasValue = jd.value.trim().length > 0;
            const linkHasValue = jdLink.value.trim().length > 0;

            if (jdHasValue && linkHasValue) {
                alert("You can paste either a link to the job or the text of the job description — not both.");
                if (changedEl === jd) jdLink.value = "";
                else jd.value = "";
            }
        };

        jd.addEventListener("input", () => checkMutualExclusion(jd));
        jdLink.addEventListener("input", () => checkMutualExclusion(jdLink));
    }

    /* ==========================================================
       FORM SUBMIT
       ========================================================== */
    form.addEventListener("submit", async (ev) => {
        ev.preventDefault();

        // Start loading UI
        setBtnLoading(true);
        toggleOverlay(true);

        try {
            const fd = new FormData(form);

            // Normalize leads checkbox
            lastWantsLeads = !!(jhBox && jhBox.checked);
            fd.set("JH_tickbox", lastWantsLeads ? "yes" : "no");

            // GA4 (via GTM)
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({ event: "run_search", with_leads: lastWantsLeads });

            // Preserve prior behavior for saver flag
            const saverKey = "Save to the doc file and the spreadsheet? (+10 sec)";
            if (!fd.has(saverKey)) fd.append(saverKey, "No");

            // Normalize payload for backend JSON (JD + JD_link)
            const JD = jd ? jd.value.trim() : "";
            const JD_link = jdLink ? jdLink.value.trim() : "";

            if (!JD && !JD_link) {
                alert("Please paste either the job description text or the job link before submitting.");
                return;
            }

            // Build clean JSON payload
            const payload = {
                JD,
                JD_link,
                "Save to the doc file and the spreadsheet? (+10 sec)": "No",
                "Region to search (Candidates)": "Western Europe",
                "Include potential leads search?": lastWantsLeads ? "Yes" : "No",
            };

            // Send JSON to n8n (form.action points to webhook/gatecrasher)
            const resp = await fetch(form.getAttribute("action"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            let data, asText = null;
            const ct = (resp.headers.get("content-type") || "").toLowerCase();
            if (ct.includes("application/json")) {
                data = await resp.json();
            } else {
                asText = await resp.text();
                try { data = JSON.parse(asText); } catch { /* keep asText */ }
            }

            // Render success
            if (data && typeof data === "object") {
                const payloadOut = Array.isArray(data) ? data[0] : data;
                result.innerHTML = renderTemplate(payloadOut, { wantsLeads: lastWantsLeads });

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
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({ event: "run_search_error", message: err?.message || String(err) });

            if (window.__notify) window.__notify("Something went wrong. Please try again.", "error");
        } finally {
            // Always stop loading UI
            setBtnLoading(false);
            toggleOverlay(false);
        }
    });
}
