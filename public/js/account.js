// /js/account.js — account summary + billing + profile + quota updates
// Requires: window.supabase (CDN), /api/account/summary/:userId endpoint

import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

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
const API_BASE = window.__API_BASE__ || "/api";
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
    try { console.info(`[${type}] ${msg}`); } catch { }
}

/* =========================
   THEME / NAV
   ========================= */
function initTheme() {
    try {
        const saved = localStorage.getItem("xrl-theme");
        const light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
        document.documentElement.setAttribute("data-theme", saved || (light ? "light" : "dark"));
    } catch { }
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
    const supabase =
        (await getSupabaseClient()) || (await waitForSupabase());
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
    } catch { }

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

    try { pendingEmail = localStorage.getItem(PENDING_KEY) || null; } catch { }
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
        } catch { }
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

        try { localStorage.setItem("xrl-profile-name", nameEl.value || ""); } catch { }

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

function setQuota(used, total) {
    const pct = total > 0 ? clamp((used / total) * 100, 0, 100) : 0;
    setText("quotaText", `${used} / ${total} searches`);
    const fill = document.getElementById("quotaFill");
    if (fill) requestAnimationFrame(() => { fill.style.width = pct + "%"; });
}

function isProStatus(status) {
    // Treat any real Stripe subscription states as Pro
    return ["active", "trialing", "past_due", "unpaid"].includes(String(status || "").toLowerCase());
}

function renderSummary({ status = "none", renewalDate = null, creditsRemaining = 0 }) {
    const pro = isProStatus(status);
    const cap = pro ? PRO_CAP : FREE_CAP;

    const remaining = typeof creditsRemaining === "number" ? creditsRemaining : 0;
    const used = clamp(cap - remaining, 0, cap);
    setQuota(used, cap);

    // ——— Subscription pill + text ———
    const statusText = document.getElementById("subStatus");
    const subPill = document.getElementById("subPill");
    if (statusText) statusText.textContent = pro ? "Pro — Active" : "Free — Active";
    if (subPill) subPill.setAttribute("data-status", pro ? "pro" : "free");

    // Renewal
    const showRenew = pro && !!renewalDate;
    setShown("renewalWrap", showRenew);
    if (showRenew) {
        const d = new Date(renewalDate);
        setText("renewalDate", d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
    } else {
        setText("renewalDate", "—");
    }

    // ——— Plan callout (this was missing) ———
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

    // Buttons
    const upgrade = document.getElementById("upgradeBtn");
    const cancel = document.getElementById("cancelBtn");
    if (upgrade) upgrade.style.display = pro ? "none" : "";   // hide Upgrade when Pro
    if (cancel) cancel.disabled = !pro;                      // enable only for Pro
}


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

async function initAccountSummaryAndBilling() {
    const upgrade = document.getElementById("upgradeBtn");
    const cancel = document.getElementById("cancelBtn");

    await refreshSummary();

    // Visibility refresh
    const vis = () => { if (document.visibilityState === "visible") refreshSummary(); };
    document.addEventListener("visibilitychange", vis);
    _teardowns.push(() => document.removeEventListener("visibilitychange", vis));

    // BroadcastChannel live updates after each search
    try {
        const bc = new BroadcastChannel("gc-activity");
        const onMsg = (e) => { if (e?.data?.type === "search_used") refreshSummary(); };
        bc.addEventListener("message", onMsg);
        _teardowns.push(() => bc.removeEventListener("message", onMsg));
    } catch { }

    // ✅ Upgrade button now re-checks identity at click time
    if (upgrade) {
        const handler = async () => {
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
        upgrade.addEventListener("click", handler);
        _teardowns.push(() => upgrade.removeEventListener("click", handler));
    }

    if (cancel) {
        // Keep disabled unless you expose a user-facing cancel endpoint
        cancel.title = "Cancel from billing portal or contact support.";
    }
}

/* =========================
   HISTORY + SUPPORT + PASSWORD
   ========================= */
function initHistoryPlaceholders() {
    const list = document.getElementById("historyList");
    if (!list) return;
    const items = [
        { title: "Software Engineer", company: "Globex", url: "https://globex.example", hr: ["Alice", "Bob"], jd: "Lorem ipsum JD…" },
        { title: "Data Analyst", company: "Initech", url: "https://initech.example", hr: ["Carol", "Dan"], jd: "Lorem ipsum JD…" },
    ];
    items.forEach((it) => {
        const el = document.createElement("div");
        el.className = "hist-item";
        el.innerHTML = `
      <div class="hist-head" role="button" aria-expanded="false">
        <div>
          <h4>${it.title} — ${it.company}</h4>
          <div class="hist-meta">HR: ${it.hr.join(", ")}</div>
        </div>
        <div><span class="badge">Details</span></div>
      </div>
      <div class="hist-body" aria-hidden="true">
        <div class="stack"><label>Job title</label><input type="text" value="${it.title}" readonly></div>
        <div class="stack"><label>Company name</label><input type="text" value="${it.company}" readonly></div>
        <div class="stack"><label>Company URL</label><input type="text" value="${it.url}" readonly></div>
        <div class="stack"><label>Pasted Job description</label><textarea readonly>${it.jd}</textarea></div>
        <div class="stack"><label>All HRs</label><input type="text" value="${it.hr.join(", ")}" readonly></div>
      </div>
    `;
        list.appendChild(el);
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
    });
}

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

    const supabase =
        (await getSupabaseClient()) || (await waitForSupabase());
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
            const supabase =
                (await getSupabaseClient()) || (await waitForSupabase());
            if (supabase) await supabase.auth.signOut();
        } catch { }
        // Always send them to login after sign out
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
    initHistoryPlaceholders();
    initSupportForm();
    initPasswordChange();
    initLogout();


    onDomReady(async () => {
        await initProfilePrefill();
        await initAccountSummaryAndBilling();
    });

    document.dispatchEvent(new CustomEvent("account:initialized"));
    window.__accountInitialized = true;
}

export function teardownAccountPage() {
    for (const t of _teardowns.splice(0)) { try { t(); } catch { } }
    _initialized = false;
}

/* Auto-init */
onDomReady(initAccountPage);
