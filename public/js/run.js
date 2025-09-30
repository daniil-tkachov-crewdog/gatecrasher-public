import { initThemeToggle } from "./theme.js";
import { initAuthGuard } from "./auth_guard.js";
import { initRunForm } from "./run_form.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

window.dataLayer = window.dataLayer || [];

/* =========================
   Plan / quota sync + guard
   ========================= */
const API_BASE = window.__API_BASE__ || "/api";
const FREE_CAP = 1;
const PRO_CAP = 25;

let bc;                 // BroadcastChannel
let resultObserver;     // MutationObserver for #result
let inFlight = false;   // prevent double submits
let consumedThisRun = false; // ensure single consume per run

const byId = (id) => document.getElementById(id);
const setShown = (el, on) => { if (el) el.style.display = on ? "" : "none"; };
const setText = (el, txt) => { if (el) el.textContent = txt; };
const num = (v, d = 0) => {
    const n = typeof v === "string" ? Number(v.trim()) : Number(v);
    return Number.isFinite(n) ? n : d;
};
const isProStatus = (status) =>
    ["active", "trialing", "past_due", "unpaid"].includes(String(status || "").toLowerCase());

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
    el.className = type; // rely on .error/.success styles
    el.textContent = msg;
    setShown(el, true);
}
function clearBanner() {
    const el = byId("runBanner");
    if (el) setShown(el, false);
}

/* ---------- Supabase singleton (avoid multi-client warning) ---------- */
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

/* ---------- Normalize → {status, pro, cap, used, remaining, renewalDate} ---------- */
function normalizeSummary(s) {
    const status = s?.status || "none";
    const pro = isProStatus(status);

    const capCandidates = [s?.searchCap, s?.cap, s?.searches?.cap, s?.quota?.cap, pro ? PRO_CAP : FREE_CAP];
    const cap = capCandidates.map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    const remainingCandidates = [s?.creditsRemaining, s?.remainingCredits, s?.searches?.remaining, s?.quota?.remaining];
    let remaining = remainingCandidates.map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    let used = [s?.used, s?.searches?.used, s?.quota?.used].map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    if (!Number.isFinite(used) && Number.isFinite(cap) && Number.isFinite(remaining)) used = Math.max(0, cap - remaining);
    if (!Number.isFinite(remaining) && Number.isFinite(cap) && Number.isFinite(used)) remaining = Math.max(0, cap - used);

    const finalCap = Number.isFinite(cap) ? cap : (pro ? PRO_CAP : FREE_CAP);
    const finalUsed = Math.max(0, num(used, 0));
    const finalRemaining = Math.max(0, Number.isFinite(remaining) ? remaining : Math.max(0, finalCap - finalUsed));

    return {
        status,
        pro,
        cap: finalCap,
        used: Math.min(finalUsed, finalCap),
        remaining: Math.min(finalRemaining, finalCap),
        renewalDate: s?.renewalDate || s?.renewal || null,
    };
}

/* ---------- Local fallback quota (per user + period) ---------- */
const LS_Q = "xrl-quota";

function qKey(userId, periodEnd) {
    return `${LS_Q}:${userId || "nouser"}:${periodEnd || "noperiod"}`;
}
function getLocalUsed(userId, periodEnd) {
    try {
        const v = localStorage.getItem(qKey(userId, periodEnd));
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
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

/* Overlay local fallback onto normalized summary.
   While a run is in-flight, allow optimistic local > server.
   Once not in-flight, snap local back to server to avoid stale over-count. */
function applyLocalOverlay(s, userId) {
    if (!userId) return s;

    const localUsed = getLocalUsed(userId, s.renewalDate);

    if (inFlight) {
        if (localUsed > s.used) {
            const used = Math.min(localUsed, s.cap);
            return { ...s, used, remaining: Math.max(0, s.cap - used) };
        }
        resetLocalIfServerHigher(userId, s.renewalDate, s.used);
        return s;
    }

    // not in flight → snap local to server truth
    setLocalUsed(userId, s.renewalDate, s.used);
    return s;
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
    if (upgradeLink) setShown(upgradeLink, !s.pro);

    if (submitBtn) {
        if (s.remaining <= 0) {
            submitBtn.disabled = true;
            submitBtn.textContent = s.pro ? "Out of credits" : "Upgrade to run";
        } else if (!inFlight) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Run Search";
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

/* ---------- Server-side: consume one credit after results land ---------- */
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
    } catch { }
}

/* ---------- Cross-tab signal ---------- */
function postActivity() {
    try {
        if (!bc) bc = new BroadcastChannel("gc-activity");
        bc.postMessage({ type: "search_used", at: Date.now() });
    } catch { }
}

/* Detect when results land in #result (indicates search finished) → consume + refresh */
function watchResults() {
    const box = byId("result");
    if (!box || resultObserver) return;

    resultObserver = new MutationObserver((mutations) => {
        const added = mutations.some(m => [...m.addedNodes].some(n =>
            (n.nodeType === 1 && (n.textContent?.trim()?.length || n.querySelector?.("*"))) ||
            (n.nodeType === 3 && n.nodeValue?.trim())
        ));
        if (added && !consumedThisRun) {
            consumedThisRun = true; // guard: one consume per run
            consumeOneCredit().finally(() => {
                refreshSummaryAndUI().then(() => { inFlight = false; });
                postActivity();
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
        if (link) link.focus();
        return;
    }

    // Optimistic local decrement immediately (so UI shows usage during run)
    bumpLocalUsed(userId, s.renewalDate, s.cap, 1);
    s = applyLocalOverlay(s, userId);      // recompute with local bump
    renderNormalizedSummary(s, s.renewalDate);
    postActivity();

    // Disable button / mark in flight
    const submitBtn = byId("submitBtn");
    if (submitBtn) {
        inFlight = true;
        consumedThisRun = false; // reset per new run
        submitBtn.disabled = true;
        submitBtn.textContent = "Running…";
    }

    // Also poll backend in case it decrements asynchronously
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
