// /js/run.js — plan/quota strip + guard + live updates

import { initThemeToggle } from "./theme.js";
import { initAuthGuard } from "./auth_guard.js";
import { initRunForm } from "./run_form.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";


// Ensure dataLayer exists even before GTM loads
window.dataLayer = window.dataLayer || [];

/* =========================
   API base (no more prod→localhost!)
   ========================= */
const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
const sanitizedWindowBase = (() => {
    const v = (window.__API_BASE__ || "").trim();
    try {
        if (!v) return "";
        if (v.startsWith("/")) return v; // same-origin path
        const u = new URL(v, location.origin);
        if (isLocalHost && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1")) return u.href;
        if (!isLocalHost && u.origin === location.origin) return u.href;
        return "";
    } catch {
        return "";
    }
})();
const API_BASE = sanitizedWindowBase || (isLocalHost ? "http://localhost:3000/api" : "/api");

/* =========================
   Plan / quota sync + guard
   ========================= */
const FREE_CAP = 1;
const PRO_CAP = 25;

let bc;
let resultObserver;
let inFlight = false;

// NEW: ensure we only log once per run
let __historyLogged = false;

const byId = (id) => document.getElementById(id);
const setShown = (el, on) => { if (el) el.style.display = on ? "" : "none"; };
const setText = (el, txt) => { if (el) el.textContent = txt; };
const num = (v, d = 0) => {
    const n = typeof v === "string" ? Number(v.trim()) : Number(v);
    return Number.isFinite(n) ? n : d;
};

const fmtRenewal = (iso) => {
    if (!iso) return "";
    try {
        const d = new Date(iso);
        return `Renews ${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
    } catch { return ""; }
};

function showBanner(msg, type = "error") {
    const el = byId("runBanner");
    if (!el) return;
    el.className = type;
    el.textContent = msg;
    setShown(el, true);
}
function clearBanner() {
    const el = byId("runBanner");
    if (el) setShown(el, false);
}

/* ---------- Supabase ---------- */
async function getSupabase() {
    if (window.__xrl_supabase__) return window.__xrl_supabase__;
    const client = window.supabase?.createClient(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        { auth: { storageKey: "xrl-auth" } }
    );
    window.__xrl_supabase__ = client;
    return client;
}
async function getIdentity() {
    const sb = await getSupabase();
    const { data: { session } = {} } = await sb.auth.getSession();
    const user = session?.user || null;
    return { userId: user?.id || null, email: user?.email || null };
}

/* ---------- Server summary ---------- */
async function fetchSummary(userId) {
    const res = await fetch(`${API_BASE}/account/summary/${userId}`, { credentials: "include" });
    if (!res.ok) throw new Error("Summary failed");
    return res.json();
}

/* ---------- Normalize ---------- */
function normalizeSummary(s) {
    const status = s?.status || "none";
    const pro = ["active", "trialing", "past_due", "unpaid"].includes(String(status).toLowerCase());

    const capCandidates = [s?.searchCap, s?.cap, s?.searches?.cap, s?.quota?.cap, pro ? PRO_CAP : FREE_CAP];
    const cap = capCandidates.map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    const remainingCandidates = [s?.creditsRemaining, s?.remainingCredits, s?.searches?.remaining, s?.quota?.remaining];
    let remaining = remainingCandidates.map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    let used = [s?.used, s?.searches?.used, s?.quota?.used].map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    if (!Number.isFinite(used) && Number.isFinite(cap) && Number.isFinite(remaining)) used = Math.max(0, cap - remaining);
    if (!Number.isFinite(remaining) && Number.isFinite(cap) && Number.isFinite(used)) remaining = Math.max(0, cap - used);

    const finalCap = Number.isFinite(cap) ? cap : (pro ? PRO_CAP : FREE_CAP);
    let finalUsed = Math.max(0, num(used, 0));
    let finalRemaining = Math.max(0, Number.isFinite(remaining) ? remaining : Math.max(0, finalCap - finalUsed));

    const freeTryUsed = s?.freeTryUsed ?? s?.has_claimed_free_try;
    if (!pro && freeTryUsed === false) {
        finalUsed = 0;
        finalRemaining = FREE_CAP;
    }

    return {
        status,
        pro,
        cap: finalCap,
        used: Math.min(finalUsed, finalCap),
        remaining: Math.min(finalRemaining, finalCap),
        renewalDate: s?.renewalDate || s?.renewal || null,
    };
}

/* ---------- Local fallback quota ---------- */
const LS_Q = "xrl-quota";
const qKey = (userId, periodEnd) => `${LS_Q}:${userId || "nouser"}:${periodEnd || "noperiod"}`;

function getLocalUsed(userId, periodEnd) {
    try {
        const v = localStorage.getItem(qKey(userId, periodEnd));
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    } catch { return 0; }
}
function setLocalUsed(userId, periodEnd, used) {
    try { localStorage.setItem(qKey(userId, periodEnd), String(Math.max(0, used | 0))); } catch { }
}
function bumpLocalUsed(userId, periodEnd, cap, delta = 1) {
    const next = Math.min(cap, getLocalUsed(userId, periodEnd) + Math.max(1, delta));
    setLocalUsed(userId, periodEnd, next);
    return next;
}
function resetLocalIfServerHigher(userId, periodEnd, serverUsed) {
    const local = getLocalUsed(userId, periodEnd);
    if (serverUsed > local) setLocalUsed(userId, periodEnd, serverUsed);
}
function applyLocalOverlay(s, userId) {
    if (!userId) return s;
    const localUsed = getLocalUsed(userId, s.renewalDate);
    if (localUsed > s.used) {
        const used = Math.min(localUsed, s.cap);
        return { ...s, used, remaining: Math.max(0, s.cap - used) };
    }
    resetLocalIfServerHigher(userId, s.renewalDate, s.used);
    return s;
}

/* ---------- Billing helpers ---------- */
async function openBillingPortal({ userId, email }) {
    const r = await fetch(`${API_BASE}/stripe/portal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId, email })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.url) throw new Error(data?.error || "Could not open billing portal");
    window.location.href = data.url;
}

async function renewNowImmediate({ userId }) {
    const r = await fetch(`${API_BASE}/stripe/renew-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error || "Could not renew now");
    return data; // { ok, invoice_status, payment_intent_status, client_secret? }
}

/* ---------- Rendering ---------- */
function renderNormalizedSummary(s, rawRenewal) {
    const pill = byId("runPlanPill");
    const planTxt = byId("runPlanText");
    const quotaTxt = byId("runQuotaText");
    const renewalTxt = byId("runRenewalText");
    const upgradeLink = byId("upgradeLink");
    const submitBtn = byId("submitBtn");

    if (pill) pill.setAttribute("data-status", s.pro ? "pro" : "free");
    if (planTxt) planTxt.textContent = s.pro ? "Pro" : "Free";
    if (quotaTxt) quotaTxt.textContent = `${s.used} / ${s.cap} searches`;
    if (renewalTxt) setText(renewalTxt, s.pro ? fmtRenewal(rawRenewal) : "");

    // --- CTA logic: Upgrade vs Renew-now vs Hidden ---
    if (upgradeLink) {
        // clear prior bindings/hrefs to avoid stacking
        upgradeLink.onclick = null;
        upgradeLink.removeAttribute("disabled");
        upgradeLink.removeAttribute("href");

        if (!s.pro) {
            // Free → Upgrade
            upgradeLink.textContent = "Upgrade";
            upgradeLink.href = "./account.html";
            setShown(upgradeLink, true);
        } else if (s.remaining <= 0) {
            // Pro & out of credits → Renew now (immediate cycle reset via backend)
            upgradeLink.textContent = "Renew now";
            setShown(upgradeLink, true);
            upgradeLink.onclick = async (e) => {
                e.preventDefault();
                try {
                    const { userId } = await getIdentity();
                    if (!userId) throw new Error("Please sign in first.");
                    upgradeLink.textContent = "Renewing…";
                    upgradeLink.setAttribute("disabled", "true");

                    const resp = await renewNowImmediate({ userId });

                    // If SCA is required (rare in test), guide the user
                    if (resp?.payment_intent_status === "requires_action" && resp?.client_secret) {
                        showBanner("Additional authentication required. Please check the Stripe popup or your bank app.", "info");
                        // Optional: integrate Stripe.js confirmCardPayment(resp.client_secret) here.
                    }

                    // Refresh UI; webhook or immediate-paid path will have reset credits
                    await refreshSummaryAndUI();
                    showBanner("Your cycle was reset. You now have fresh credits.", "success");
                } catch (err) {
                    showBanner(err?.message || "Could not renew now.", "error");
                } finally {
                    upgradeLink.textContent = "Renew now";
                    upgradeLink.removeAttribute("disabled");
                }
            };
        } else {
            // Pro & has credits → hide CTA
            setShown(upgradeLink, false);
        }
    }

    if (submitBtn) {
        if (s.remaining <= 0) {
            submitBtn.disabled = true;
            submitBtn.textContent = s.pro ? "Out of credits" : "Upgrade to run";
            // (Optional tiny tooltip for clarity)
            submitBtn.title = s.pro ? "You’ve used all 25 searches. Click ‘Renew now’ to reset immediately." :
                "Free plan includes 1 search/month. Upgrade for more.";
        } else if (!inFlight) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Run Search";
            submitBtn.removeAttribute("title");
        }
    }
}


/* Pull server → normalize → overlay local → render */
async function refreshSummaryAndUI() {
    try {
        const { userId } = await getIdentity();
        if (!userId) {
            showBanner("Please sign in to run this tool.", "error");
            return null;
        }
        const raw = await fetchSummary(userId);
        let s = normalizeSummary(raw);
        s = applyLocalOverlay(s, userId);
        renderNormalizedSummary(s, raw?.renewalDate || raw?.renewal);
        return { userId, raw, s };
    } catch {
        showBanner("Couldn’t load your plan/quota. Please refresh.", "error");
        return null;
    }
}

/* ---------- Cross-tab signal ---------- */
function postActivity() {
    try {
        if (!bc) bc = new BroadcastChannel("gc-activity");
        bc.postMessage({ type: "search_used", at: Date.now() });
    } catch { }
}

/* ---------- Server-side: consume one credit when results land ---------- */
async function consumeOneCredit() {
    try {
        const { userId } = await getIdentity();
        if (!userId) return;
        await fetch(`${API_BASE}/account/consume`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId })
        });
    } catch { /* ignore */ }
}

/* =========================
   NEW: History logging helpers
   ========================= */
function normalizeUrl(u) {
    try {
        const url = new URL(u);
        url.search = ""; url.hash = "";
        url.pathname = url.pathname.replace(/\/+$/, "");
        return url.toString().toLowerCase();
    } catch { return (u || "").trim().toLowerCase(); }
}

function normalizeName(s) {
    return (s || "")
        .replace(/\b(linked\s*in)\b/ig, "")  // drop "LinkedIn" label text
        .replace(/\s+/g, " ")
        .replace(/[|@]+/g, " ")
        .trim();
}


/** Smarter summary extraction from the rendered #result + JD fallback */
function extractResultSummary() {
    const box = document.getElementById("result");
    const jdRaw = document.getElementById("JD")?.value || "";
    const out = { companyUrl: null, companyName: null, hrContacts: [], whyCompany: null, jobTitle: null };
    if (!box) return out;

    const anchors = [...box.querySelectorAll("a[href]")];

    // ---------- Company URL ----------
    let companyUrl = null;

    // Prefer a Website: label with link nearby
    const websiteLabel = [...box.querySelectorAll("*")]
        .find(el => /website\s*:?\s*$/i.test(el.textContent || ""));
    if (websiteLabel) {
        const siteLink = websiteLabel.closest("div,li,p,section")?.querySelector("a[href]");
        if (siteLink) companyUrl = siteLink.href;
    }
    // Fallback: first non-LinkedIn anchor in result
    if (!companyUrl) {
        const nonLinked = anchors.find(a => {
            try {
                const u = new URL(a.href, location.origin);
                return /^https?:/.test(u.protocol) && !/linkedin\.com/i.test(u.hostname);
            } catch { return false; }
        });
        if (nonLinked) companyUrl = nonLinked.href;
    }
    // Fallback: first non-LinkedIn URL in JD
    if (!companyUrl && jdRaw) {
        const urlMatches = jdRaw.match(/https?:\/\/[^\s)]+/gi) || [];
        const nonLinkedIn = urlMatches.find(u => !/linkedin\.com/i.test(u));
        if (nonLinkedIn) companyUrl = nonLinkedIn;
    }
    out.companyUrl = companyUrl || null;

    // ---------- Company name ----------
    if (companyUrl) {
        try {
            const host = new URL(companyUrl).hostname.replace(/^www\./i, "");
            const base = host.split(".")[0];
            out.companyName = base ? base.charAt(0).toUpperCase() + base.slice(1) : null;
        } catch { /* ignore */ }
    }
    if (!out.companyName) {
        const h = [...box.querySelectorAll("h1,h2,strong")]
            .map(n => (n.textContent || "").trim())
            .find(t => t && t.length <= 50);
        if (h) out.companyName = h;
    }

    // ---------- Why this company ----------
    let whyCompany = null;
    const whyLabel = [...box.querySelectorAll("*")]
        .find(el => /why\s+this\s+company/i.test(el.textContent || ""));
    if (whyLabel) {
        const container = whyLabel.closest("div,section,p,li") || whyLabel.parentElement;
        if (container) {
            const text = (container.textContent || "")
                .replace(/why\s+this\s+company:?/i, "")
                .trim();
            if (text) whyCompany = text.slice(0, 600);
        }
    } else {
        const firstPara = [...box.querySelectorAll("p,div,li")]
            .map(n => (n.textContent || "").trim())
            .find(t => t.length > 60);
        if (firstPara) whyCompany = firstPara.slice(0, 400);
    }
    out.whyCompany = whyCompany || null;

    // ---------- Job title ----------
    const titleFromResult = [...box.querySelectorAll("h1,h2,h3,strong,b")]
        .map(n => (n.textContent || "").trim())
        .find(t => /\b(engineer|developer|designer|manager|lead|architect|analyst|scientist|backend|front[- ]?end|full[- ]?stack)\b/i.test(t));
    if (titleFromResult) out.jobTitle = titleFromResult;
    if (!out.jobTitle && jdRaw) {
        const lines = jdRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, 40);
        const titleLine = lines.find(l =>
            l.length >= 4 &&
            l.length <= 80 &&
            !/^https?:\/\//i.test(l) &&
            /\b(engineer|developer|designer|manager|lead|architect|analyst|scientist|backend|front[- ]?end|full[- ]?stack)\b/i.test(l)
        );
        if (titleLine) out.jobTitle = titleLine;
    }

    // ---------- HR contacts (one per unique LinkedIn URL) ----------
    const contacts = [];
    const seen = new Set();

    function addContact(name, title, profileUrl) {
        const cleanName = normalizeName(name);
        const cleanTitle = (title || "").replace(/\s+/g, " ").trim() || null;
        const cleanUrl = profileUrl ? normalizeUrl(profileUrl) : null;
        const key = cleanUrl ? `url:${cleanUrl}` : `nt:${cleanName}|${(cleanTitle || "").toLowerCase()}`;
        if (!cleanName || cleanName.length < 2 || seen.has(key)) return;
        seen.add(key);
        contacts.push({ name: cleanName, title: cleanTitle, profileUrl: cleanUrl });
    }

    // Scope: prefer a labeled section, otherwise whole result
    const hrSectionLabel = [...box.querySelectorAll("*")].find(el =>
        /company\s+hr\s+people|hiring\s+team|people\s+you\s+can\s+reach\s+out\s+to/i.test(el.textContent || "")
    );
    const scope = hrSectionLabel ? (hrSectionLabel.closest("div,section") || hrSectionLabel.parentElement) : box;

    // 1) Unique LinkedIn anchors
    const liAnchors = [...scope.querySelectorAll('a[href*="linkedin.com"]')];
    const uniqueAnchors = [];
    const urlSeen = new Set();
    for (const a of liAnchors) {
        const nu = normalizeUrl(a.href);
        if (!urlSeen.has(nu)) { urlSeen.add(nu); uniqueAnchors.push(a); }
    }

    // 2) Parse each anchor’s closest block for name/title
    for (const a of uniqueAnchors) {
        const ctx = a.closest("li, p, div") || a;
        let nameNode = ctx.querySelector("strong, b");
        let name = nameNode ? nameNode.textContent : "";

        let text = (ctx.textContent || "")
            .replace(/\bLinkedIn\b/ig, " ")
            .replace(/\s+/g, " ")
            .trim();

        if (!name || name.length < 2) {
            name = text.split(/\s[–—-]\s|\s\|\s/)[0]?.trim() || "";
        }

        let title = null;
        const dashSplit = text.split(/\s[–—-]\s/);
        if (dashSplit.length >= 2) {
            title = dashSplit.slice(1).join(" — ").trim();
        } else {
            const pipeSplit = text.split(/\s\|\s/);
            if (pipeSplit.length >= 2) {
                title = pipeSplit.slice(1).join(" | ").trim();
            }
        }

        if (name) addContact(name, title, a.href);
        if (contacts.length >= 20) break;
    }

    // 3) Fallback if none found (still deduped)
    if (!contacts.length) {
        const blocks = [...scope.querySelectorAll("li, p, div")];
        for (const blk of blocks) {
            const link = blk.querySelector('a[href*="linkedin.com"]');
            const profileUrl = link ? link.href : null;
            let text = (blk.textContent || "").replace(/\bLinkedIn\b/ig, " ").replace(/\s+/g, " ").trim();
            const name = text.split(/\s[–—-]\s|\s\|\s/)[0]?.trim() || "";
            let title = null;
            const d = text.split(/\s[–—-]\s/);
            if (d.length >= 2) title = d.slice(1).join(" — ").trim();
            if (name) addContact(name, title, profileUrl);
            if (contacts.length >= 20) break;
        }
    }

    out.hrContacts = contacts;
    return out;
}


/** Fire-and-forget POST to backend to store one history row */
async function logSearchHistory() {
    try {
        const { userId } = await getIdentity();
        if (!userId) return;

        const jdRaw = document.getElementById("JD")?.value || "";
        const sourceUrl = document.getElementById("JD_link")?.value?.trim() || null;
        const includeLeads = !!document.getElementById("JH_tickbox")?.checked;

        // Log if either JD text or a source URL exists
        if (!jdRaw.trim() && !sourceUrl) return;

        const sourceType = jdRaw.trim().length ? "paste" : (sourceUrl ? "url" : "paste");
        const summary = extractResultSummary();

        const payload = {
            userId,
            sourceType,
            sourceUrl,
            includeLeads,
            jdRaw,

            jobTitle: summary.jobTitle || null,
            companyName: summary.companyName || null,
            companyUrl: summary.companyUrl || null,
            location: null,
            whyCompany: summary.whyCompany || null,
            hrContacts: Array.isArray(summary.hrContacts) ? summary.hrContacts : [],
        };

        console.debug("[history] POST /api/searches/log", payload);

        await fetch(`${(API_BASE || "").replace(/\/$/, "")}/searches/log`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(payload),
        });
    } catch (err) {
        console.warn("[history] log failed (non-blocking):", err);
    }
}


/* Detect when results land in #result → consume & refresh + LOG HISTORY */
function watchResults() {
    const box = byId("result");
    if (!box || resultObserver) return;

    resultObserver = new MutationObserver((mutations) => {
        const added = mutations.some(m => [...m.addedNodes].some(n =>
            (n.nodeType === 1 && (n.textContent?.trim()?.length || n.querySelector?.("*"))) ||
            (n.nodeType === 3 && n.nodeValue?.trim())
        ));
        if (added) {
            consumeOneCredit().finally(async () => {
                await refreshSummaryAndUI();
                inFlight = false;
                postActivity();

                if (!__historyLogged) {
                    __historyLogged = true;
                    logSearchHistory(); // fire-and-forget
                }
            });
        }
    });

    resultObserver.observe(box, { childList: true, subtree: true, characterData: true });
}

/* Guard before submit: block if out of credits; optimistic local decrement */
async function onSubmitGuard(e) {
    clearBanner();

    const data = await refreshSummaryAndUI();
    if (!data) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }
    let { userId, s } = data;

    if (s.remaining <= 0) {
        e.preventDefault();
        e.stopPropagation();
        showBanner(
            s.pro
                ? "You’ve used all your credits for this billing period."
                : "Free plan allows 1 search per month. Upgrade to continue.",
            "error"
        );
        const link = byId("upgradeLink");
        if (link) {
            // Nudge CTA text appropriately
            if (s.pro) link.textContent = "Renew now";
            link.focus();
        }
        return;
    }

    // Optimistic local decrement immediately
    bumpLocalUsed(userId, s.renewalDate, s.cap, 1);
    s = applyLocalOverlay(s, userId);
    renderNormalizedSummary(s, s.renewalDate);
    postActivity();

    const submitBtn = byId("submitBtn");
    if (submitBtn) {
        inFlight = true;
        submitBtn.disabled = true;
        submitBtn.textContent = "Running…";
    }

    // reset log-once flag for this fresh run
    __historyLogged = false;

    setTimeout(refreshSummaryAndUI, 1500);
    setTimeout(refreshSummaryAndUI, 6000);
    setTimeout(refreshSummaryAndUI, 15000);
}

/* =========================
   Boot
   ========================= */
function init() {
    initThemeToggle({ toggleId: "themeToggle" });
    initAuthGuard({ redirectTo: "./login.html" });
    initRunForm({
        formId: "gatecrasher-form",
        resultId: "result",
        jdId: "JD",
        leadsCheckboxId: "JH_tickbox",
        submitId: "submitBtn",
    });

    refreshSummaryAndUI();
    watchResults();

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshSummaryAndUI();
    });

    try {
        bc = new BroadcastChannel("gc-activity");
        bc.addEventListener("message", (e) => {
            if (e?.data?.type === "search_used") refreshSummaryAndUI();
        });
    } catch { }

    const form = byId("gatecrasher-form");
    if (form) form.addEventListener("submit", onSubmitGuard, true);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
    init();
}
