// Reuse the shared theme toggle from your existing theme.js
import { initThemeToggle } from "./theme.js";

/* =========================
   Constants / DOM helpers
   ========================= */
const THEME_KEY = "xrl-theme";
const CONSENT_KEY = "gc-consent-v1";
const ROOT = document.documentElement;

const qs = (sel, root = document) => root.querySelector(sel);
const getToggle = () => qs("#themeToggle");

/* =========================
   Theme utilities
   ========================= */
function getSavedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function setTheme(mode) {
    if (mode !== "light" && mode !== "dark") return;
    ROOT.setAttribute("data-theme", mode);
}

/** Apply system theme only if user hasn't saved a preference yet */
function applyInitialThemeIfNoSaved(toggleEl) {
    if (getSavedTheme()) return; // initThemeToggle applies saved value
    const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)")?.matches === true;
    const initial = prefersLight ? "light" : "dark";
    setTheme(initial);
    if (toggleEl) toggleEl.checked = initial === "light";
}

/** Keep the theme toggle UI in sync if data-theme changes elsewhere */
function observeThemeAttr(toggleEl) {
    if (!toggleEl) return () => { };

    const mo = new MutationObserver(() => {
        const mode = ROOT.getAttribute("data-theme");
        if (mode === "light" || mode === "dark") toggleEl.checked = mode === "light";
    });

    mo.observe(ROOT, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
}

/** React if system theme changes and user hasn't set a preference yet */
function listenToSystemTheme(toggleEl) {
    let userHasPref = !!getSavedTheme();
    if (userHasPref) return () => { };

    const mql = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mql) return () => { };

    const handler = (e) => {
        const next = e.matches ? "light" : "dark";
        setTheme(next);
        if (toggleEl) toggleEl.checked = next === "light";
    };

    mql.addEventListener?.("change", handler);
    return () => mql.removeEventListener?.("change", handler);
}

/* =========================
   Consent utilities
   ========================= */
function readConsent() {
    try { return JSON.parse(localStorage.getItem(CONSENT_KEY) || "null"); }
    catch { return null; }
}

function renderConsentStatus() {
    const el = qs("#consent-status");
    if (!el) return;

    const saved = readConsent();
    if (!saved) {
        el.textContent = "Status: not set (first visit)";
        return;
    }
    const on = saved.analytics_storage === "granted";
    el.textContent = "Status: " + (on ? "analytics enabled" : "analytics disabled");
}

/** Live-update consent status if another tab/page changes it */
function listenToConsentStorage() {
    const storageHandler = (ev) => {
        if (ev.key === CONSENT_KEY) renderConsentStatus();
    };
    const customHandler = () => renderConsentStatus();

    window.addEventListener("storage", storageHandler);
    window.addEventListener("gc:consent-updated", customHandler);

    return () => {
        window.removeEventListener("storage", storageHandler);
        window.removeEventListener("gc:consent-updated", customHandler);
    };
}

/* =========================
   Init (idempotent + teardown)
   ========================= */
let _initialized = false;
let _teardownFns = [];

export function initPrivacyPage() {
    if (_initialized) return; // idempotent
    _initialized = true;

    // 1) Theme toggle from theme.js
    try { initThemeToggle(); } catch (e) { console.error("[privacy] initThemeToggle failed:", e); }

    // 2) Default to system preference only on first visit (no saved theme)
    const toggle = getToggle();
    applyInitialThemeIfNoSaved(toggle);
    _teardownFns.push(observeThemeAttr(toggle));
    _teardownFns.push(listenToSystemTheme(toggle));

    // 3) Show current consent status and keep it fresh
    renderConsentStatus();
    _teardownFns.push(listenToConsentStorage());
}

/** Optional: clean up listeners/observers if navigating away in an SPA */
export function teardownPrivacyPage() {
    for (const fn of _teardownFns.splice(0)) {
        try { fn(); } catch { /* noop */ }
    }
    _initialized = false;
}

/* Auto-init on DOM ready (keeps original behavior) */
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initPrivacyPage, { once: true });
} else {
    initPrivacyPage();
}
