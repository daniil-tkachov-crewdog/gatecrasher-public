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
// const API_BASE = window.__API_BASE__ || "/api"; // ensure no trailing slash

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
    try { console.info(`[${type}] ${msg}`); } catch { /* noop */ }
}
// Tiny helpers for modal wiring
function showEl(el, on) {
    if (!el) return;
    el.setAttribute("aria-hidden", on ? "false" : "true");
    el.style.display = on ? "flex" : "none";
}
function q(id) { return document.getElementById(id); }
function escapeHtml(s = "") {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDateTime(iso) {
    try { return new Date(iso).toLocaleString(); } catch { return ""; }
}

/* =========================
   THEME / NAV
   ========================= */
function initTheme() {
    try {
        const saved = localStorage.getItem("xrl-theme");
        const light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
        document.documentElement.setAttribute("data-theme", saved || (light ? "light" : "dark"));
    } catch { /* noop */ }
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
    } catch { /* noop */ }

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

    try { pendingEmail = localStorage.getItem(PENDING_KEY) || null; } catch { /* noop */ }
    if (pendingEmail) { show(noticePending, true); startPendingPoll(); }

    async function checkEmailConfirmed() {
        try {
            if (!supabase || !pendingEmail) return;
            const { data: { user } } = await supabase.auth.getUser();
            if (user?.email?.toLowerCase() === pendingEmail.toLowerCase()) {
                localStorage.removeItem(PENDING_KEY);
                show(noticePending, false);
                emailEl.value = user.email;
                clearInterval(pollTimer); pollTimer = null; pendingEmail = null;
                notify("Email change confirmed.", "success");
            }
        } catch { /* noop */ }
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

        try { localStorage.setItem("xrl-profile-name", nameEl.value || ""); } catch { /* noop */ }

        if (!supabase) { notify("Profile saved.", "success"); return; }
        try {
            const { data: { user } } = await supabase.auth.getUser();
            const currentEmail = user?.email || "";
            const nextEmail = (emailEl.value || "").trim();

            if (!nextEmail || currentEmail.toLowerCase() === nextEmail.toLowerCase()) {
                notify("Profile saved.", "success");
                return;
            }

            const { error } = await supabase.auth.updateUser(
                { email: nextEmail },
                { emailRedirectTo: "https://crewdog.app/verify.html" }
            );
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

    const finalCap = Number.isFinite(cap) ? cap : (pro ? PRO_CAP : FREE_CAP);
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
        renewalDate: s?.renewalDate || s?.renewal || null
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
        body: JSON.stringify({ userId, email })
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
        body: JSON.stringify({ userId, email })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.url) throw new Error(data?.error || "Could not open billing portal");
    window.location.href = data.url;
}

// Immediately reset the current billing cycle (server will handle Stripe + credits)
// Add this helper near your other billing helpers:

async function renewNowImmediate({ userId }) {
    const res = await fetch(`${API_BASE}/stripe/renew-now`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ userId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Could not renew now");
    return data; // { ok, invoice_status, payment_intent_status, client_secret? }
}

/* --------------------------- Updated renderSummary --------------------------- */
function renderSummary(raw) {
    const { pro, cap, used, renewalDate } = normalizeSummary(raw);

    setQuota(Math.min(used, cap), cap);

    const statusText = document.getElementById("subStatus");
    const subPill = document.getElementById("subPill");
    if (statusText) statusText.textContent = pro ? "Pro — Active" : "Free — Active";
    if (subPill) subPill.setAttribute("data-status", pro ? "pro" : "free");

    const showRenew = pro && !!renewalDate;
    setShown("renewalWrap", showRenew);
    if (showRenew) {
        const d = new Date(renewalDate);
        setText("renewalDate", d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
    } else {
        setText("renewalDate", "—");
    }

    const planBadge = document.getElementById("planBadge");
    const planNameEl = document.getElementById("planName");
    const planHelpEl = document.getElementById("planHelp");
    if (planBadge) planBadge.setAttribute("data-status", pro ? "pro" : "free");
    if (planNameEl) planNameEl.textContent = pro ? "Pro" : "Free";
    if (planHelpEl) {
        planHelpEl.innerHTML = pro
            ? `You’re on the <strong>Pro</strong> plan — <strong>${PRO_CAP}</strong> searches / month.`
            : `You’re on the <strong>Free</strong> plan — <strong>${FREE_CAP}</strong> search / month. Upgrade to unlock <strong>${PRO_CAP}</strong> searches / month.`;
    }

    const upgrade = document.getElementById("upgradeBtn");
    const cancel = document.getElementById("cancelBtn");

    // Bind Upgrade/Renew CTA dynamically based on current state:
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
            // Pro & at cap (25/25) → Renew now (immediate reset)
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
                    notify("Your cycle was reset. You now have fresh credits.", "success");
                } catch (err) {
                    notify(err?.message || "Could not renew now.", "error");

                    // Optional: fallback to billing portal
                    // try {
                    //     const { userId, email } = await getIdentity();
                    //     await openBillingPortal({ userId, email });
                    // } catch { /* ignore */ }
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

    if (cancel) cancel.disabled = !pro;
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

async function initAccountSummaryAndBilling() {
    const cancel = document.getElementById("cancelBtn");

    // Initial fetch + dynamic button binding happens inside renderSummary
    await refreshSummary();

    const vis = () => { if (document.visibilityState === "visible") refreshSummary(); };
    document.addEventListener("visibilitychange", vis);
    _teardowns.push(() => document.removeEventListener("visibilitychange", vis));

    try {
        const bc = new BroadcastChannel("gc-activity");
        const onMsg = (e) => { if (e?.data?.type === "search_used") refreshSummary(); };
        bc.addEventListener("message", onMsg);
        _teardowns.push(() => bc.removeEventListener("message", onMsg));
    } catch { /* noop */ }

    // ===== Cancel → survey → downsell flow =====
    if (cancel) {
        const cancelModal = q("cancelModal");
        const downswellModal = q("downswellModal"); // NOTE: matches HTML id
        const cancelForm = q("cancelForm");
        const cancelClose = q("cancelClose");
        const cancelNext = q("cancelNext");
        const cancelOther = q("cancelOther");
        const keepForTwoBtn = q("keepForTwoBtn");
        const cancelAnywayBtn = q("cancelAnywayBtn");

        // Open survey
        const onCancelClick = () => showEl(cancelModal, true);

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
                cancelNext.disabled = true; cancelNext.textContent = "Saving…";
                const { userId } = await getIdentity();
                if (!userId) throw new Error("Sign in first.");
                const reason = cancelForm.reason?.value;
                const otherText = cancelOther.value?.trim() || undefined;

                await fetch(`${API_BASE}/stripe/cancel/feedback`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ userId, reason, otherText })
                });

                showEl(cancelModal, false);
                showEl(downswellModal, true);
            } catch (err) {
                notify(err?.message || "Couldn’t save feedback.", "error");
            } finally {
                cancelNext.disabled = false; cancelNext.textContent = "Continue";
            }
        });

        // Downsell -> keep for £2
        keepForTwoBtn?.addEventListener("click", async () => {
            try {
                keepForTwoBtn.disabled = true; keepForTwoBtn.textContent = "Updating…";
                const { userId } = await getIdentity();
                if (!userId) throw new Error("Sign in first.");

                const r = await fetch(`${API_BASE}/stripe/downgrade`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ userId })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data?.error || "Downgrade failed");

                showEl(downswellModal, false);
                notify("You’re now on the £2 plan.", "success");
                await refreshSummary();
            } catch (err) {
                notify(err?.message || "Couldn’t downgrade.", "error");
            } finally {
                keepForTwoBtn.disabled = false; keepForTwoBtn.textContent = "Keep for £2";
            }
        });

        // Downsell -> cancel anyway
        cancelAnywayBtn?.addEventListener("click", async () => {
            try {
                cancelAnywayBtn.disabled = true; cancelAnywayBtn.textContent = "Cancelling…";
                const { userId } = await getIdentity();
                if (!userId) throw new Error("Sign in first.");

                const r = await fetch(`${API_BASE}/stripe/cancel`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ userId })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data?.error || "Cancel failed");

                showEl(downswellModal, false);
                notify("Your subscription will end at the period end.", "info");
                await refreshSummary();
            } catch (err) {
                notify(err?.message || "Couldn’t cancel.", "error");
            } finally {
                cancelAnywayBtn.disabled = false; cancelAnywayBtn.textContent = "Cancel anyway";
            }
        });

        // Enable & wire main Cancel button
        cancel.removeAttribute("disabled");
        cancel.title = "Manage subscription";
        cancel.addEventListener("click", onCancelClick);
        _teardowns.push(() => cancel.removeEventListener("click", onCancelClick));
    }
}

/* =========================
   HISTORY (REAL DATA)
   ========================= */
async function fetchSearchHistory({ userId, limit = 20, cursor = null }) {
    // Build clean URL without double-origin pitfalls
    const base = (API_BASE || "").replace(/\/$/, "");
    const href = `${base}/searches`;                    // "/api/searches" or "http://.../api/searches"
    const url = new URL(href, window.location.origin);  // Works for relative or absolute API_BASE

    url.searchParams.set("userId", userId);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), { credentials: "include" });
    if (!res.ok) throw new Error("History fetch failed");
    return res.json();
}

function renderHistoryItems(container, items) {
    const frag = document.createDocumentFragment();

    items.forEach((row) => {
        const el = document.createElement("div");
        el.className = "hist-item";

        // Deduplicate by profileUrl (preferred) or name
        const hrMap = new Map(
            (Array.isArray(row.hrContacts) ? row.hrContacts : [])
                .map(c => {
                    const key = c?.profileUrl ? `url:${c.profileUrl}` : `n:${(c?.name || '').toLowerCase()}`;
                    return [key, c?.name || ""];
                })
        );
        const hrNames = [...hrMap.values()].filter(Boolean);

        const title = escapeHtml(row.jobTitle || "Untitled role");
        const company = escapeHtml(row.companyName || "");
        const website = row.companyUrl ? escapeHtml(row.companyUrl) : "";
        const jdExcerpt = escapeHtml(row.jdExcerpt || "");
        const hrLine = escapeHtml(hrNames.join(", "));
        const createdAt = fmtDateTime(row.createdAt);
        const sourceType = escapeHtml(row.sourceType || (row.sourceUrl ? "url" : "paste"));
        const sourceUrl = row.sourceUrl ? escapeHtml(row.sourceUrl) : "";

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
        <div class="stack"><label>Job title</label><input type="text" value="${title}" readonly></div>
        <div class="stack"><label>Company name</label><input type="text" value="${company || "—"}" readonly></div>
        <div class="stack"><label>Company URL</label><input type="text" value="${website || "—"}" readonly></div>

        <div class="stack"><label>Source</label><input type="text" value="${sourceType === "url" ? "Link" : "Pasted text"}" readonly></div>
        <div class="stack"><label>Source URL</label><input type="text" value="${sourceUrl || "—"}" readonly></div>

        <div class="stack"><label>Pasted Job description (excerpt)</label><textarea readonly>${jdExcerpt}</textarea></div>
        <div class="stack"><label>All HRs</label><input type="text" value="${hrLine || "—"}" readonly></div>
      </div>
    `;

        const head = el.querySelector(".hist-head");
        const body = el.querySelector(".hist-body");
        const clickHandler = () => {
            const expanded = head.getAttribute("aria-expanded") === "true";
            head.setAttribute("aria-expanded", (!expanded).toString());
            body.style.display = expanded ? "none" : "block";
            body.setAttribute("aria-hidden", expanded ? "true" : "false");
        };
        head.addEventListener("click", clickHandler);
        _teardowns.push(() => head.removeEventListener("click", clickHandler));

        frag.appendChild(el);
    });

    container.appendChild(frag);
}

async function initSearchHistory() {
    const list = document.getElementById("historyList");
    const empty = document.getElementById("historyEmpty");
    if (!list) return;

    list.innerHTML = "";

    try {
        const { userId } = await getIdentity();
        if (!userId) {
            if (empty) empty.style.display = "block";
            return;
        }

        const data = await fetchSearchHistory({ userId, limit: 20 });
        if (!data?.ok || !Array.isArray(data.items)) throw new Error("Bad history payload");

        if (data.items.length === 0) {
            if (empty) empty.style.display = "block";
            return;
        }
        if (empty) empty.style.display = "none";

        renderHistoryItems(list, data.items);

        // Optional "Load more"
        const moreBtn = document.getElementById("historyMore");
        if (moreBtn) {
            let cursor = data.nextCursor || null;
            const onMore = async () => {
                moreBtn.disabled = true; moreBtn.textContent = "Loading…";
                try {
                    if (!cursor) return;
                    const nxt = await fetchSearchHistory({ userId, limit: 20, cursor });
                    renderHistoryItems(list, nxt.items || []);
                    cursor = nxt.nextCursor || null;
                    if (!cursor) moreBtn.style.display = "none";
                } catch {
                    notify("Couldn’t load more history.", "error");
                } finally {
                    moreBtn.disabled = false; moreBtn.textContent = "Load more";
                }
            };
            moreBtn.addEventListener("click", onMore);
            _teardowns.push(() => moreBtn.removeEventListener("click", onMore));
            if (!data.nextCursor) moreBtn.style.display = "none";
        }
    } catch {
        if (empty) empty.style.display = "block";
    }
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
        show(success, false); show(errorBox, false);

        if (!form.email.value || !form.message.value) {
            errorBox.textContent = "Email and message are required.";
            show(errorBox, true);
            notify("Email and message are required.", "error");
            return;
        }

        if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
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
            if (btn) { btn.disabled = false; btn.textContent = "Submit"; }
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
        show(success, false); show(errorBox, false);
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
        updateBtn.disabled = true; updateBtn.textContent = "Updating...";

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
            updateBtn.disabled = false; updateBtn.textContent = "Update";
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
        } catch { /* noop */ }
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
    initSearchHistory();              // <<< real history
    initSupportForm();
    initPasswordChange();
    initLogout();
    // Optional theme toggle hook if you expose it somewhere:
    try { if (typeof initThemeToggle === "function") initThemeToggle(); } catch { /* noop */ }

    onDomReady(async () => {
        await initProfilePrefill();
        await initAccountSummaryAndBilling();
    });

    document.dispatchEvent(new CustomEvent("account:initialized"));
    window.__accountInitialized = true;
}

export function teardownAccountPage() {
    for (const t of _teardowns.splice(0)) { try { t(); } catch { /* noop */ } }
    _initialized = false;
}

/* Auto-init */
onDomReady(initAccountPage);
