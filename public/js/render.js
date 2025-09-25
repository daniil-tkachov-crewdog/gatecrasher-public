export function renderTemplate(d, opts = {}) {
    const wantsLeads = !!opts.wantsLeads;

    // Error-only payload support: { "output_error": "..." }
    if (d && typeof d === "object" && Object.prototype.hasOwnProperty.call(d, "output_error")) {
        return '<div class="gc-error"><strong>Error:</strong> ' + esc(String(d.output_error)) + "</div>";
    }

    const errors = [];
    if (!d || typeof d !== "object") errors.push("Empty or invalid JSON.");
    if (!d || !d.company) errors.push("Missing: company");
    if (!d || !d.company_website) errors.push("Missing: company_website");
    if (!d || !Array.isArray(d.hr)) errors.push("Missing or invalid: hr[]");

    const hasLeads = Array.isArray(d?.potential_leads) && d.potential_leads.length > 0;
    let out = "";

    if (errors.length) {
        out += '<div class="gc-error"><strong>Render error:</strong> ' + errors.join(" · ") + "</div>";
    }

    out += (
        '<div class="gc-header">' +
        '<h1 class="gc-title">' + esc(d?.company || "") + "</h1>" +
        '<div class="gc-sub">Website: ' + link(d?.company_website, "Link") + "</div>" +
        (d?.sniff_out_clues && String(d.sniff_out_clues).trim()
            ? '<div class="gc-sub clues"><h2>Why this company?</h2><p>' + esc(String(d.sniff_out_clues)) + "</p></div>"
            : "") +
        "</div>"
    );

    out += section("Company HR people", renderCards(d?.hr || []));
    if (hasLeads) out += section("Potential leads", renderCards(d.potential_leads));

    return out;
}

/* ===== internals ===== */
function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function link(href, text) {
    if (!href) return "";
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(text || href) + '</a>';
}
function section(title, inner) {
    if (!inner) return "";
    return '<div class="gc-section"><h2>' + esc(title) + '</h2>' + inner + '</div>';
}
function renderCards(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return "";
    const cards = arr.map(function (item) {
        const t = item?.title ? item.title : "—";
        const lnk = item?.link ? link(item.link, "LinkedIn") : "";
        return '<div class="gc-card"><p class="gc-item-title">' + esc(t) + '</p><p>' + lnk + '</p></div>';
    }).join("");
    return '<div class="gc-grid">' + cards + '</div>';
}
