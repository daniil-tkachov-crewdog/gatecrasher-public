import { initThemeToggle } from "./theme.js";
import { initAuthGuard } from "./auth_guard.js";
import { initRunForm } from "./run_form.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// Ensure dataLayer exists for analytics pushes even before GTM loads
window.dataLayer = window.dataLayer || [];

/* =========================
   Plan / quota sync + guard
   ========================= */
const API_BASE = window.__API_BASE__ || "/api";
const FREE_CAP = 1;
const PRO_CAP = 25;

let supabaseClient;
let lastSummary = null;
let bc; // BroadcastChannel

function byId(id) { return document.getElementById(id); }
function setShown(el, on) { if (el) el.style.display = on ? "" : "none"; }
function setText(el, txt) { if (el) el.textContent = txt; }
function isProStatus(status) {
    return ["active", "trialing", "past_due", "unpaid"].includes(String(status || "").toLowerCase());
}
function fmtRenewal(iso) {
    if (!iso) return "";
    try {
        const d = new Date(iso);
        return `Renews ${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`;
    } catch { return ""; }
}

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

async function getSupabase() {
    if (supabaseClient) return supabaseClient;
    supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabaseClient;
}
async function getIdentity() {
    const sb = await getSupabase();
    const { data: { session } = {} } = await sb.auth.getSession();
    const user = session?.user || null;
    return { userId: user?.id || null, email: user?.email || null };
}

async function fetchSummary(userId) {
    const res = await fetch(`${API_BASE}/account/summary/${userId}`, { credentials: "include" });
    if (!res.ok) throw new Error("Summary failed");
    return res.json();
}

function renderSummary(summary) {
    // Elements are optional — if not present, we just skip UI rendering
    const pill = byId("runPlanPill");
    const planTxt = byId("runPlanText");
    const quotaTxt = byId("runQuotaText");
    const renewalTxt = byId("runRenewalText");
    const upgradeLink = byId("upgradeLink");
    const submitBtn = byId("submitBtn");

    const pro = isProStatus(summary?.status);
    const cap = pro ? PRO_CAP : FREE_CAP;
    const remaining = typeof summary?.creditsRemaining === "number" ? summary.creditsRemaining : 0;
    const used = Math.max(0, cap - remaining);

    if (pill) pill.setAttribute("data-status", pro ? "pro" : "free");
    if (planTxt) planTxt.textContent = pro ? "Pro" : "Free";
    if (quotaTxt) quotaTxt.textContent = `${used} / ${cap} searches`;
    if (renewalTxt) setText(renewalTxt, pro ? fmtRenewal(summary?.renewalDate) : "");

    if (upgradeLink) setShown(upgradeLink, !pro);

    if (submitBtn) {
        if (remaining <= 0) {
            submitBtn.disabled = true;
            submitBtn.textContent = pro ? "Out of credits" : "Upgrade to run";
        } else {
            submitBtn.disabled = false;
            submitBtn.textContent = "Run Search";
        }
    }
}

async function refreshSummaryAndUI() {
    try {
        const { userId } = await getIdentity();
        if (!userId) {
            showBanner("Please sign in to run this tool.", "error");
            return null;
        }
        const summary = await fetchSummary(userId);
        lastSummary = summary;
        renderSummary(summary);
        return summary;
    } catch {
        showBanner("Couldn’t load your plan/quota. Please refresh.", "error");
        return null;
    }
}

function postActivity() {
    try {
        if (!bc) bc = new BroadcastChannel("gc-activity");
        bc.postMessage({ type: "search_used", at: Date.now() });
    } catch { }
}

// Guard before submit: block if out of credits
async function onSubmitGuard(e) {
    clearBanner();

    // Re-check just in time
    const summary = await refreshSummaryAndUI();
    if (!summary) {
        e.preventDefault();
        e.stopPropagation();
        return;
    }

    const pro = isProStatus(summary.status);
    const cap = pro ? PRO_CAP : FREE_CAP;
    const remaining = typeof summary.creditsRemaining === "number" ? summary.creditsRemaining : 0;

    if (remaining <= 0) {
        e.preventDefault();
        e.stopPropagation();
        showBanner(pro
            ? "You’ve used all your credits for this billing period."
            : "Free plan allows 1 search per month. Upgrade to continue.", "error");
        const link = byId("upgradeLink");
        if (link) link.focus();
        return;
    }

    // Let the existing run_form.js submit handler proceed…
    // Then schedule a couple of refreshes so counters update
    setTimeout(refreshSummaryAndUI, 1500);
    setTimeout(refreshSummaryAndUI, 6000);
    // And notify other tabs (e.g., account page) to refresh
    postActivity();
}

/* =========================
   Boot
   ========================= */
function init() {
    // Existing initializers
    initThemeToggle({ toggleId: "themeToggle" });
    initAuthGuard({ redirectTo: "./login.html" });
    initRunForm({
        formId: "gatecrasher-form",
        resultId: "result",
        jdId: "JD",
        leadsCheckboxId: "JH_tickbox",
        submitId: "submitBtn",
    });

    // Plan/quota initial render
    refreshSummaryAndUI();

    // Re-render when tab becomes visible
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshSummaryAndUI();
    });

    // Listen for activity from other tabs
    try {
        bc = new BroadcastChannel("gc-activity");
        bc.addEventListener("message", (e) => {
            if (e?.data?.type === "search_used") refreshSummaryAndUI();
        });
    } catch { }

    // Guard: check quota before submit (capture phase so we can block early)
    const form = byId("gatecrasher-form");
    if (form) form.addEventListener("submit", onSubmitGuard, true);

    // Optional: expose debug helpers
    window.__debugRun = {
        async whoami() {
            const { data: { session } } = await (await getSupabase()).auth.getSession();
            return session?.user;
        },
        async summary() {
            const { userId } = await getIdentity();
            return userId ? fetch(`${API_BASE}/account/summary/${userId}`, { credentials: "include" }).then(r => r.json()) : null;
        }
    };
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
    init();
}
