// helpers.js — make sure THIS is what's on disk and being served
export function show(el, msg) {
    if (!el) return;
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
}

export function disable(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
}

export function validEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

export function pushEvent(evt) {
    try {
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push(evt);
    } catch (_) { /* no-op */ }
}
