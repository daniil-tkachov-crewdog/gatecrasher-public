// /js/account.js — account summary + billing + profile + quota updates
// Requires: window.supabase (CDN), /api/account/summary/:userId endpoint

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { initThemeToggle } from "./theme.js";

let _initialized = false;
let _teardowns = [];

/* =========================
   SMALL HELPERS
   ========================= */
function onDomReady(fn) {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
        fn();
    }
}

const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
const sanitizedWindowBase = (() => {
    const v = (window.__API_BASE__ || "").trim();
    try {
        if (!v) return "";
        if (v.startsWith("/")) return v; // same-origin path
        const u = new URL(v, location.origin);
        if (isLocalHost && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1")) return u.href;
        if (!isLocalHost && u.origin === location.origin) return u.href; // allow absolute same-origin
        return "";
    } catch {
        return "";
    }
})();
const API_BASE = sanitizedWindowBase || (isLocalHost ? "http://localhost:3000/api" : "/api");

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
function setText(id, txt) {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
}
function setShown(idOrEl, on) {
    const el = typeof idOrEl === "string" ? document.getElementById(idOrEl) : idOrEl;
    if (el) el.style.display = on ? "" : "none";
}
function notify(msg, type = "success") {
    if (window.__notify) return window.__notify(msg, type);
    try {
        console.info(`[${type}] ${msg}`);
    } catch {
        /* noop */
    }
}
function showEl(el, on) {
    if (!el) return;
    el.setAttribute("aria-hidden", on ? "false" : "true");
    el.style.display = on ? "flex" : "none";
}
function q(id) {
    return document.getElementById(id);
}
function escapeHtml(s = "") {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDateTime(iso) {
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return "";
    }
}

/* ========= NEW: inline subscription alert helper + busy flag ========= */
let _actionBusy = false;
function showSubAlert(msg, type = "success") {
    const box = document.getElementById("subAlert");
    if (!box) return;
    box.className = `alert ${type}`;
    box.textContent = msg;
    box.style.display = "block";
    clearTimeout(showSubAlert._t);
    showSubAlert._t = setTimeout(() => (box.style.display = "none"), 4000);
}

/* =========================
   THEME / NAV
   ========================= */
function initTheme() {
    try {
        const saved = localStorage.getItem("xrl-theme");
        const light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
        document.documentElement.setAttribute("data-theme", saved || (light ? "light" : "dark"));
    } catch {
        /* noop */
    }
}
function initSidebarToggle() {
    const btn = document.getElementById("menuToggle");
    const sidebar = document.getElementById("sidebar");
    if (!btn || !sidebar) return;
    const handler = () => {
        const open = sidebar.classList.toggle("open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
    };
    btn.addEventListener("click", handler);
    _teardowns.push(() => btn.removeEventListener("click", handler));
}
function initSectionSwitching() {
    const menu = document.getElementById("accountMenu");
    const links = menu ? menu.querySelectorAll("a[data-target]") : [];
    const panels = document.querySelectorAll("[data-panel]");
    if (!links.length || !panels.length) return;

    function show(target) {
        links.forEach((a) => a.classList.toggle("active", a.getAttribute("data-target") === target));
        panels.forEach((p) => (p.style.display = p.id === "panel-" + target ? "block" : "none"));
        const sidebar = document.getElementById("sidebar");
        const menuBtn = document.querySelector(".menu-btn");
        if (menuBtn && window.getComputedStyle(menuBtn).display !== "none") sidebar && sidebar.classList.remove("open");
    }

    links.forEach((a) => {
        const handler = (e) => {
            e.preventDefault();
            const target = a.getAttribute("data-target");
            show(target);
            history.replaceState(null, "", "#" + target);
        };
        a.addEventListener("click", handler);
        _teardowns.push(() => a.removeEventListener("click", handler));
    });

    const hash = (location.hash || "#general").replace("#", "");
    show(hash);
}

/* =========================
   SUPABASE
   ========================= */
async function getSupabaseClient() {
    if (window.__xrl_supabase__) return window.__xrl_supabase__;
    if (window.supabase?.createClient) {
        const c = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        window.__xrl_supabase__ = c;
        return c;
    }
    return null;
}
async function waitForSupabase({ tries = 20, interval = 200 } = {}) {
    for (let i = 0; i < tries; i++) {
        const c = await getSupabaseClient();
        if (c) return c;
        await new Promise((r) => setTimeout(r, interval));
    }
    return null;
}
async function getIdentity() {
    const supabase = (await getSupabaseClient()) || (await waitForSupabase());
    if (!supabase) return { userId: null, email: null };
    const { data: { session } = {} } = await supabase.auth.getSession();
    const user = session?.user || null;
    return { userId: user?.id || null, email: user?.email || null };
}

/* =========================
   PROFILE PREFILL
   ========================= */
export async function initProfilePrefill() {
    const nameEl = document.getElementById("name");
    const emailEl = document.getElementById("email");
    if (!nameEl || !emailEl) return;

    try {
        const savedName = localStorage.getItem("xrl-profile-name") || "";
        if (savedName) nameEl.value = savedName;
    } catch {
        /* noop */
    }

    const { email } = await getIdentity();
    if (email) emailEl.value = email;
}

/* =========================
   EDIT/SAVE PROFILE
   ========================= */
function initEditSaveProfile() {
    const supabase = window.__xrl_supabase__;
    const editBtn = document.getElementById("editProfile");
    const saveBtn = document.getElementById("saveProfile");
    const nameEl = document.getElementById("name");
    const emailEl = document.getElementById("email");
    const noticePending = document.getElementById("email-pending");
    const noticeError = document.getElementById("email-error");
    if (!editBtn || !saveBtn) return;

    const PENDING_KEY = "xrl-pending-email";
    let pendingEmail = null;
    let pollTimer = null;
    const show = (el, on) => el && (el.style.display = on ? "block" : "none");

    try {
        pendingEmail = localStorage.getItem(PENDING_KEY) || null;
    } catch {
        /* noop */
    }
    if (pendingEmail) {
        show(noticePending, true);
        startPendingPoll();
    }

    async function checkEmailConfirmed() {
        try {
            if (!supabase || !pendingEmail) return;
            const { data: { user } } = await supabase.auth.getUser();
            if (user?.email?.toLowerCase() === pendingEmail.toLowerCase()) {
                localStorage.removeItem(PENDING_KEY);
                show(noticePending, false);
                emailEl.value = user.email;
                clearInterval(pollTimer);
                pollTimer = null;
                pendingEmail = null;
                notify("Email change confirmed.", "success");
            }
        } catch {
            /* noop */
        }
    }
    function startPendingPoll() {
        if (pollTimer) return;
        pollTimer = setInterval(checkEmailConfirmed, 5000);
        setTimeout(checkEmailConfirmed, 3000);
    }

    const onEdit = () => {
        nameEl.readOnly = false;
        emailEl.readOnly = false;
        nameEl.focus();
        saveBtn.style.display = "inline-flex";
    };

    const onSave = async () => {
        nameEl.readOnly = true;
        emailEl.readOnly = true;
        saveBtn.style.display = "none";
        show(noticeError, false);

        try {
            localStorage.setItem("xrl-profile-name", nameEl.value || "");
        } catch {
            /* noop */
        }

        if (!supabase) {
            notify("Profile saved.", "success");
            return;
        }
        try {
            const { data: { user } } = await supabase.auth.getUser();
            const currentEmail = user?.email || "";
            const nextEmail = (emailEl.value || "").trim();

            if (!nextEmail || currentEmail.toLowerCase() === nextEmail.toLowerCase()) {
                notify("Profile saved.", "success");
                return;
            }

            const { error } = await supabase.auth.updateUser({ email: nextEmail }, { emailRedirectTo: "https://crewdog.app/verify.html" });
            if (error) {
                show(noticeError, true);
                emailEl.value = currentEmail;
                notify("Couldn’t update email.", "error");
                return;
            }

            localStorage.setItem(PENDING_KEY, nextEmail);
            show(noticePending, true);
            pendingEmail = nextEmail;
            startPendingPoll();
            notify("Profile saved. Check your inbox to confirm email.", "info");
        } catch {
            show(noticeError, true);
            notify("Couldn’t update profile.", "error");
        }
    };

    editBtn.addEventListener("click", onEdit);
    saveBtn.addEventListener("click", onSave);
    _teardowns.push(() => {
        editBtn.removeEventListener("click", onEdit);
        saveBtn.removeEventListener("click", onSave);
        if (pollTimer) clearInterval(pollTimer);
    });
}

/* =========================
   QUOTA + SUBSCRIPTION
   ========================= */
const FREE_CAP = 1;
const PRO_CAP = 25;

const num = (v, d = 0) => {
    const n = typeof v === "string" ? Number(v.trim()) : Number(v);
    return Number.isFinite(n) ? n : d;
};

function normalizeSummary(s) {
    const status = s?.status || "none";
    const pro = ["active", "trialing", "past_due", "unpaid"].includes(String(status).toLowerCase());

    const capCandidates = [s?.searchCap, s?.cap, s?.searches?.cap, s?.quota?.cap, pro ? PRO_CAP : FREE_CAP];
    const cap = capCandidates.map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    const remainingCandidates = [s?.creditsRemaining, s?.remainingCredits, s?.searches?.remaining, s?.quota?.remaining];
    let remaining = remainingCandidates.map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    let used = [s?.used, s?.searches?.used, s?.quota?.used].map((v) => num(v, NaN)).find((v) => Number.isFinite(v));

    if (!Number.isFinite(used) && Number.isFinite(cap) && Number.isFinite(remaining)) {
        used = Math.max(0, cap - remaining);
    }
    if (!Number.isFinite(remaining) && Number.isFinite(cap) && Number.isFinite(used)) {
        remaining = Math.max(0, cap - used);
    }

    const finalCap = Number.isFinite(cap) ? cap : pro ? PRO_CAP : FREE_CAP;
    let finalUsed = Math.max(0, num(used, 0));
    let finalRemaining = Math.max(0, Number.isFinite(remaining) ? remaining : Math.max(0, finalCap - finalUsed));

    // FIX: new user on Free plan but backend returns creditsRemaining=0 while freeTryUsed=false
    const freeTryUsed = s?.freeTryUsed ?? s?.has_claimed_free_try;
    if (!pro && freeTryUsed === false) {
        finalUsed = 0;
        finalRemaining = FREE_CAP; // give full free allowance
    }

    return {
        status,
        pro,
        cap: finalCap,
        used: finalUsed,
        remaining: finalRemaining,
        renewalDate: s?.renewalDate || s?.renewal || null,
    };
}

function setQuota(used, total) {
    const pct = total > 0 ? clamp((used / total) * 100, 0, 100) : 0;
    setText("quotaText", `${used} / ${total} searches`);
    const fill = document.getElementById("quotaFill");
    if (fill) requestAnimationFrame(() => { fill.style.width = pct + "%"; });
}

/* ---------- Billing helpers ---------- */
async function startCheckout({ userId, email }) {
    const res = await fetch(`${API_BASE}/stripe/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId, email }),
    });
    if (!res.ok) throw new Error("Checkout failed");
    const { url } = await res.json();
    if (!url) throw new Error("No checkout URL");
    window.location.href = url;
}

async function openBillingPortal({ userId, email }) {
    const res = await fetch(`${API_BASE}/stripe/portal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId, email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.url) throw new Error(data?.error || "Could not open billing portal");
    window.location.href = data.url;
}

async function renewNowImmediate({ userId }) {
    const res = await fetch(`${API_BASE}/stripe/renew-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Could not renew now");
    return data; // { ok, invoice_status, payment_intent_status, client_secret? }
}

/* --------------------------- Updated renderSummary --------------------------- */
function renderSummary(raw) {
    const { pro, cap, used, renewalDate } = normalizeSummary(raw);

    setQuota(Math.min(used, cap), cap);

    // Status pill + text (show "cancels on" if cancelAtPeriodEnd is true)
    const statusText = document.getElementById("subStatus");
    const subPill = document.getElementById("subPill");
    const cancelScheduled = !!raw?.cancelAtPeriodEnd;
    if (statusText) {
        if (pro && cancelScheduled && renewalDate) {
            const d = new Date(renewalDate);
            const when = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
            statusText.textContent = `Pro — Cancels on ${when}`;
        } else {
            statusText.textContent = pro ? "Pro — Active" : "Free — Active";
        }
    }
    if (subPill) subPill.setAttribute("data-status", pro ? "pro" : "free");

    // Renewal date (visible only on active Pro)
    const showRenew = pro && !!renewalDate;
    setShown("renewalWrap", showRenew);
    if (showRenew) {
        const d = new Date(renewalDate);
        setText("renewalDate", d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
    } else {
        setText("renewalDate", "—");
    }

    // Plan callout + price text
    const planBadge = document.getElementById("planBadge");
    const planNameEl = document.getElementById("planName");
    const planHelpEl = document.getElementById("planHelp");
    if (planBadge) planBadge.setAttribute("data-status", pro ? "pro" : "free");
    if (planNameEl) planNameEl.textContent = pro ? "Pro" : "Free";

    const price = raw?.price; // { amount (minor units), currency, interval }
    let priceStr = "";
    if (price && Number.isFinite(price.amount)) {
        const major = price.amount / 100;
        const currency = (price.currency || "gbp").toUpperCase();
        const interval = price.interval || "month";
        try {
            priceStr = new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(major) + `/${interval}`;
        } catch {
            priceStr = `£${major}/${interval}`;
        }
    }
    if (planHelpEl) {
        if (pro) {
            planHelpEl.innerHTML = `You’re on the <strong>Pro</strong> plan — <strong>${PRO_CAP}</strong> searches / ${price?.interval || "month"}${priceStr ? ` for <strong>${priceStr}</strong>` : ""}.`;
        } else {
            planHelpEl.innerHTML = `You’re on the <strong>Free</strong> plan — <strong>${FREE_CAP}</strong> search / month. Upgrade to unlock <strong>${PRO_CAP}</strong> searches / month.`;
        }
    }

    // Upgrade / Renew CTA
    const upgrade = document.getElementById("upgradeBtn");
    if (upgrade) {
        upgrade.onclick = null;
        upgrade.removeAttribute("disabled");

        if (!pro) {
            // Free → Upgrade (checkout)
            upgrade.style.display = "";
            upgrade.textContent = "Upgrade";
            upgrade.onclick = async () => {
                try {
                    const { userId, email } = await getIdentity();
                    if (!userId || !email) throw new Error("Sign in first.");
                    upgrade.disabled = true;
                    upgrade.textContent = "Redirecting…";
                    await startCheckout({ userId, email });
                } catch (err) {
                    notify(err?.message || "Unable to start checkout.", "error");
                    upgrade.disabled = false;
                    upgrade.textContent = "Upgrade";
                }
            };
        } else if (used >= cap) {
            // Pro & at cap → Renew now
            upgrade.style.display = "";
            upgrade.textContent = "Renew now";
            upgrade.onclick = async () => {
                try {
                    const { userId } = await getIdentity();
                    if (!userId) throw new Error("Sign in first.");

                    upgrade.disabled = true;
                    upgrade.textContent = "Renewing…";

                    const resp = await renewNowImmediate({ userId });

                    if (resp?.payment_intent_status === "requires_action" && resp?.client_secret) {
                        notify("Extra authentication required. Please complete the bank verification.", "info");
                    }

                    await refreshSummary();
                    bindCancelBasedOnStatus(); // keep Cancel in sync
                    notify("Your cycle was reset. You now have fresh credits.", "success");
                } catch (err) {
                    notify(err?.message || "Could not renew now.", "error");
                } finally {
                    upgrade.disabled = false;
                    upgrade.textContent = "Renew now";
                }
            };
        } else {
            // Pro & has credits → hide CTA
            upgrade.style.display = "none";
        }
    }

    // Keep cancel button visual state in sync (actual click binding handled elsewhere)
    const cancel = document.getElementById("cancelBtn");
    if (cancel) {
        cancel.disabled = !pro;
        cancel.title = pro ? "Manage subscription" : "No active subscription";
    }
}

/* ---------- Summary wire-up ---------- */
async function fetchSummary(userId) {
    const res = await fetch(`${API_BASE}/account/summary/${userId}`, { credentials: "include" });
    if (!res.ok) throw new Error("Summary failed");
    return res.json();
}
async function refreshSummary() {
    try {
        const { userId } = await getIdentity();
        if (!userId) return renderSummary({ status: "none", renewalDate: null, creditsRemaining: FREE_CAP });
        const s = await fetchSummary(userId);
        renderSummary(s);
    } catch {
        renderSummary({ status: "none", renewalDate: null, creditsRemaining: FREE_CAP });
    }
}

/* ========= NEW: robust modal closing, guarded cancel binding, and flows ========= */

// Close via ✖, Esc, or backdrop
function wireModalCloses() {
    const cancelModal = document.getElementById("cancelModal");
    const downswellModal = document.getElementById("downswellModal");

    // Downsell ✖ button (selected by aria-label)
    const downsellCloseBtn = document.querySelector('#downswellModal .modal__head .btn[aria-label="Close"]');
    downsellCloseBtn?.addEventListener("click", () => showEl(downswellModal, false));

    // Backdrop clicks
    [cancelModal, downswellModal].forEach((m) => {
        if (!m) return;
        m.addEventListener("click", (e) => {
            if (e.target === m) showEl(m, false);
        });
    });

    // Escape key
    const onKey = (e) => {
        if (e.key === "Escape") {
            if (cancelModal) showEl(cancelModal, false);
            if (downswellModal) showEl(downswellModal, false);
        }
    };
    document.addEventListener("keydown", onKey);
    _teardowns.push(() => document.removeEventListener("keydown", onKey));
}

// Guarded binding: only allow opening cancel flow if Pro
function bindCancelBasedOnStatus() {
    const cancelBtn = q("cancelBtn");
    const cancelModal = q("cancelModal");
    if (!cancelBtn) return;

    const fresh = cancelBtn.cloneNode(true);
    cancelBtn.replaceWith(fresh);

    const status = q("subPill")?.dataset?.status;
    if (status === "pro") {
        fresh.disabled = false;
        fresh.title = "Manage subscription";
        const openSurvey = () => showEl(cancelModal, true);
        fresh.addEventListener("click", openSurvey);
        _teardowns.push(() => fresh.removeEventListener("click", openSurvey));
    } else {
        fresh.disabled = true;
        fresh.title = "No active subscription";
    }
}

// Cancel action with 404/409 guards + userId body
async function performCancel() {
    if (_actionBusy) return;
    _actionBusy = true;

    try {
        const { userId } = await getIdentity();
        if (!userId) throw new Error("Sign in first.");

        const r = await fetch(`${API_BASE}/stripe/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ userId }),
        });

        if (r.status === 404) {
            showSubAlert("No active subscription to cancel.", "error");
            await refreshSummary();
            bindCancelBasedOnStatus();
            return;
        }
        if (r.status === 409) {
            showSubAlert("Cancellation already scheduled — you’ll keep access until the period ends.", "info");
            await refreshSummary();
            bindCancelBasedOnStatus();
            return;
        }
        if (!r.ok) {
            const { error } = await r.json().catch(() => ({}));
            throw new Error(error || "Cancel failed");
        }

        showSubAlert("We’ll be waiting for your comeback! Your Pro access stays active until the end of the current period.", "success");
        showEl(document.getElementById("downswellModal"), false);
        showEl(document.getElementById("cancelModal"), false);

        await refreshSummary();
        bindCancelBasedOnStatus();
    } catch (e) {
        showSubAlert(e.message || "Something went wrong while cancelling.", "error");
    } finally {
        _actionBusy = false;
    }
}

// £2/month “keep” (downswell) action with userId body
async function performDownsellToTwoPounds() {
    if (_actionBusy) return;
    _actionBusy = true;

    try {
        const { userId } = await getIdentity();
        if (!userId) throw new Error("Sign in first.");

        const r = await fetch(`${API_BASE}/stripe/downgrade`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ userId }),
        });
        if (!r.ok) {
            const { error } = await r.json().catch(() => ({}));
            throw new Error(error || "Could not switch to £2 plan");
        }

        showSubAlert("Your subscription price was downgraded to £2/month!", "success");
        showEl(document.getElementById("downswellModal"), false);
        await refreshSummary();
        bindCancelBasedOnStatus();
    } catch (e) {
        showSubAlert(e.message || "Plan change failed.", "error");
    } finally {
        _actionBusy = false;
    }
}

async function initAccountSummaryAndBilling() {
    // Initial fetch
    await refreshSummary();
    bindCancelBasedOnStatus();

    // Re-render on tab visibility return
    const vis = () => {
        if (document.visibilityState === "visible") {
            refreshSummary().then(bindCancelBasedOnStatus).catch(() => { });
        }
    };
    document.addEventListener("visibilitychange", vis);
    _teardowns.push(() => document.removeEventListener("visibilitychange", vis));

    // React to search usage from the run page
    try {
        const bc = new BroadcastChannel("gc-activity");
        const onMsg = (e) => {
            if (e?.data?.type === "search_used") {
                refreshSummary().then(bindCancelBasedOnStatus).catch(() => { });
            }
        };
        bc.addEventListener("message", onMsg);
        _teardowns.push(() => bc.removeEventListener("message", onMsg));
    } catch {
        /* noop */
    }

    // ===== Cancel → survey → downsell flow =====
    const cancelModal = q("cancelModal");
    const downswellModal = q("downswellModal");
    const cancelForm = q("cancelForm");
    const cancelClose = q("cancelClose");
    const cancelNext = q("cancelNext");
    const cancelOther = q("cancelOther");
    const keepForTwoBtn = q("keepForTwoBtn");
    const cancelAnywayBtn = q("cancelAnywayBtn");

    // Show/hide "Something else…" textarea
    cancelForm?.addEventListener("change", () => {
        const v = cancelForm.reason?.value;
        if (v === "other") {
            cancelOther.style.display = "";
        } else {
            cancelOther.style.display = "none";
            cancelOther.value = "";
        }
    });

    // Close survey
    cancelClose?.addEventListener("click", () => showEl(cancelModal, false));

    // Submit survey -> save feedback -> open downsell
    cancelForm?.addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            cancelNext.disabled = true;
            cancelNext.textContent = "Saving…";
            const { userId } = await getIdentity();
            if (!userId) throw new Error("Sign in first.");
            const reason = cancelForm.reason?.value;
            const otherText = cancelOther.value?.trim() || undefined;

            await fetch(`${API_BASE}/stripe/cancel/feedback`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ userId, reason, otherText }),
            });

            showEl(cancelModal, false);
            showEl(downswellModal, true);
        } catch (err) {
            notify(err?.message || "Couldn’t save feedback.", "error");
        } finally {
            cancelNext.disabled = false;
            cancelNext.textContent = "Continue";
        }
    });

    // Downsell buttons
    keepForTwoBtn?.addEventListener("click", performDownsellToTwoPounds);
    cancelAnywayBtn?.addEventListener("click", performCancel);

    // Close behavior for modals (Esc/backdrop/✖)
    wireModalCloses();
}
/* =========================
   HISTORY (REAL DATA + PAGINATION)
   ========================= */

async function fetchSearchHistory({ userId, limit = 5, cursor = null }) {
    const base = (API_BASE || "").replace(/\/$/, "");
    const url = new URL(`${base}/searches`, window.location.origin);
    url.searchParams.set("userId", userId);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), { credentials: "include" });
    if (!res.ok) throw new Error("History fetch failed");
    return res.json();
}

function renderHistoryItems(container, items) {
    container.innerHTML = "";
    const frag = document.createDocumentFragment();

    items.forEach((row) => {
        const el = document.createElement("div");
        el.className = "hist-item";

        // Deduplicate HRs
        const hrMap = new Map(
            (Array.isArray(row.hrContacts) ? row.hrContacts : []).map((c) => {
                const key = c?.profileUrl
                    ? `url:${c.profileUrl}`
                    : `n:${(c?.name || "").toLowerCase()}`;
                return [key, c?.name || ""];
            })
        );
        const hrNames = [...hrMap.values()].filter(Boolean);

        const title = escapeHtml(row.jobTitle || "Untitled role");
        const company = escapeHtml(row.companyName || "");
        const createdAt = row.createdAt
            ? new Date(row.createdAt).toLocaleString()
            : "";
        const hrLine = escapeHtml(hrNames.join(", "));

        el.innerHTML = `
      <div class="hist-head" role="button" aria-expanded="false">
        <div>
          <h4>${title}${company ? ` — ${company}` : ""}</h4>
          <div class="hist-meta">
            ${hrLine ? `HR: ${hrLine}` : "HR: —"}
            ${createdAt ? ` • ${createdAt}` : ""}
          </div>
        </div>
        <div><span class="badge">Details</span></div>
      </div>
      <div class="hist-body" aria-hidden="true" style="display:none">
        <div class="stack">
          <label>Job description (excerpt)</label>
          <textarea readonly>${escapeHtml(row.jdExcerpt || "")}</textarea>
        </div>
      </div>
    `;

        const head = el.querySelector(".hist-head");
        const body = el.querySelector(".hist-body");
        const toggle = () => {
            const open = head.getAttribute("aria-expanded") === "true";
            head.setAttribute("aria-expanded", (!open).toString());
            body.style.display = open ? "none" : "block";
            body.setAttribute("aria-hidden", open ? "true" : "false");
        };
        head.addEventListener("click", toggle);
        _teardowns.push(() => head.removeEventListener("click", toggle));
        frag.appendChild(el);
    });

    container.appendChild(frag);
}

async function initSearchHistory() {
    const list = document.getElementById("historyList");
    const prevBtn = document.getElementById("prevPage");
    const nextBtn = document.getElementById("nextPage");
    const pageInfo = document.getElementById("pageInfo");
    if (!list || !prevBtn || !nextBtn || !pageInfo) return;

    let userId = null;
    try {
        ({ userId } = await getIdentity());
        if (!userId) return;
    } catch {
        return;
    }

    // Pagination state
    let currentPage = 1;
    const limit = 5;
    const historyCache = []; // store { page, items, nextCursor }
    const cursorStack = [null]; // first page cursor=null
    let lock = false;

    async function loadPage(page, direction = "next") {
        if (lock) return;
        lock = true;
        prevBtn.disabled = true;
        nextBtn.disabled = true;

        try {
            // Use cached if available
            if (historyCache[page - 1]) {
                renderHistoryItems(list, historyCache[page - 1].items);
            } else {
                const cursor = cursorStack[page - 1] || null;
                const data = await fetchSearchHistory({ userId, limit, cursor });
                if (!data?.ok) throw new Error("Invalid data");
                historyCache[page - 1] = {
                    items: data.items || [],
                    nextCursor: data.nextCursor || null,
                };
                renderHistoryItems(list, data.items || []);
                if (data.nextCursor && !cursorStack[page])
                    cursorStack[page] = data.nextCursor;
            }

            // Update buttons
            const totalPages = cursorStack.filter(Boolean).length + 1;
            currentPage = page;
            pageInfo.textContent = `Page ${currentPage}${historyCache[page - 1]?.nextCursor ? " (more)" : ""}`;
            prevBtn.disabled = currentPage === 1;
            nextBtn.disabled =
                !historyCache[page - 1]?.nextCursor && !cursorStack[page];
        } catch (err) {
            console.error("History load failed:", err);
            notify("Could not load history.", "error");
        } finally {
            lock = false;
        }
    }

    // Button listeners
    prevBtn.addEventListener("click", () => {
        if (currentPage > 1) loadPage(currentPage - 1, "prev");
    });
    nextBtn.addEventListener("click", () => {
        loadPage(currentPage + 1, "next");
    });
    _teardowns.push(() => {
        prevBtn.removeEventListener("click", loadPage);
        nextBtn.removeEventListener("click", loadPage);
    });

    // Initial load
    await loadPage(1);
}

/* =========================
   SUPPORT + PASSWORD
   ========================= */
function initSupportForm() {
    const form = document.getElementById("support-form");
    if (!form) return;
    const success = document.getElementById("support-success");
    const errorBox = document.getElementById("support-error");
    const btn = document.getElementById("support-submit");
    const show = (el, on) => el && (el.style.display = on ? "block" : "none");

    const submitHandler = async (e) => {
        e.preventDefault();
        show(success, false);
        show(errorBox, false);

        if (!form.email.value || !form.message.value) {
            errorBox.textContent = "Email and message are required.";
            show(errorBox, true);
            notify("Email and message are required.", "error");
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.textContent = "Sending…";
        }
        try {
            const fd = new FormData(form);
            const resp = await fetch(form.getAttribute("action"), { method: "POST", body: fd });
            if (!resp.ok) throw new Error("Request failed");
            form.reset();
            show(success, true);
            notify("Message sent. We’ll get back to you soon.", "success");
        } catch {
            errorBox.textContent = "Something went wrong. Please try again.";
            show(errorBox, true);
            notify("Failed to send. Please try again.", "error");
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = "Submit";
            }
        }
    };

    form.addEventListener("submit", submitHandler);
    _teardowns.push(() => form.removeEventListener("submit", submitHandler));
}

async function initPasswordChange() {
    const updateBtn = document.getElementById("updatePassword");
    const curPass = document.getElementById("curpass");
    const newPass = document.getElementById("newpass");
    const success = document.getElementById("pass-success");
    const errorBox = document.getElementById("pass-error");
    if (!updateBtn) return;

    const supabase = (await getSupabaseClient()) || (await waitForSupabase());
    if (!supabase) return;

    const show = (el, on) => el && (el.style.display = on ? "block" : "none");

    const handler = async () => {
        show(success, false);
        show(errorBox, false);
        const current = (curPass?.value || "").trim();
        const next = (newPass?.value || "").trim();
        if (!current || !next) {
            errorBox.textContent = "Both fields are required.";
            show(errorBox, true);
            notify("Both fields are required.", "error");
            return;
        }
        if (next.length < 6) {
            errorBox.textContent = "New password must be at least 6 characters.";
            show(errorBox, true);
            notify("New password must be at least 6 characters.", "error");
            return;
        }
        updateBtn.disabled = true;
        updateBtn.textContent = "Updating...";

        try {
            const { data: { user } } = await supabase.auth.getUser();
            const email = user?.email;
            if (!email) throw new Error("Unable to get user email.");

            const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: current });
            if (signInError) throw new Error("Incorrect current password.");

            const { error: updateError } = await supabase.auth.updateUser({ password: next });
            if (updateError) throw updateError;

            show(success, true);
            curPass.value = "";
            newPass.value = "";
            notify("Password updated successfully.", "success");
        } catch (err) {
            errorBox.textContent = err?.message || "Failed to update password.";
            show(errorBox, true);
            notify(errorBox.textContent, "error");
        } finally {
            updateBtn.disabled = false;
            updateBtn.textContent = "Update";
        }
    };

    updateBtn.addEventListener("click", handler);
    _teardowns.push(() => updateBtn.removeEventListener("click", handler));
}

async function initLogout() {
    const btn = document.getElementById("logoutBtn");
    if (!btn) return;

    const handler = async () => {
        try {
            const supabase = (await getSupabaseClient()) || (await waitForSupabase());
            if (supabase) await supabase.auth.signOut();
        } catch {
            /* noop */
        }
        window.location.href = "./login.html";
    };

    btn.addEventListener("click", handler);
    _teardowns.push(() => btn.removeEventListener("click", handler));
}

/* =========================
   PUBLIC API
   ========================= */
export function initAccountPage() {
    if (_initialized) return;
    _initialized = true;

    initTheme();
    initSidebarToggle();
    initSectionSwitching();
    initEditSaveProfile();
    initSearchHistory(); // real history
    initSupportForm();
    initPasswordChange();
    initLogout();
    try {
        if (typeof initThemeToggle === "function") initThemeToggle();
    } catch {
        /* noop */
    }

    onDomReady(async () => {
        await initProfilePrefill();
        await initAccountSummaryAndBilling();
    });

    document.dispatchEvent(new CustomEvent("account:initialized"));
    window.__accountInitialized = true;
}

export function teardownAccountPage() {
    for (const t of _teardowns.splice(0)) {
        try {
            t();
        } catch {
            /* noop */
        }
    }
    _initialized = false;
}

/* Auto-init */
onDomReady(initAccountPage);
