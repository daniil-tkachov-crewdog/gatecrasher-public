import { initThemeToggle } from "./theme.js";
import { initStats } from "./stats.js";

function initHome() {
    // Initialize core modules
    try {
        initThemeToggle && initThemeToggle();
    } catch (e) {
        console.error("[home] initThemeToggle failed:", e);
    }

    try {
        initStats && initStats();
    } catch (e) {
        console.error("[home] initStats failed:", e);
    }

    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    // --- Micro-animations ---

    // 1) Pulse the logo once on first paint
    const logo = document.querySelector(".logo");
    if (logo && !prefersReducedMotion) {
        // Use rAF to ensure CSS has applied before triggering animation class
        requestAnimationFrame(() => {
            logo.classList.add("pulse-once");
            logo.addEventListener(
                "animationend",
                () => logo.classList.remove("pulse-once"),
                { once: true }
            );
        });
    }

    // 2) Theme toggle ripple + knob pop
    const toggle = document.getElementById("themeToggle");
    if (toggle) {
        toggle.addEventListener(
            "change",
            () => {
                if (!prefersReducedMotion) {
                    // Ambient page ripple
                    document.body.classList.add("theme-switching");
                    setTimeout(() => document.body.classList.remove("theme-switching"), 460);

                    // Knob pop
                    toggle.classList.add("pop");
                    // Prefer animationend over fixed timeout so it matches CSS duration
                    toggle.addEventListener("animationend", () => toggle.classList.remove("pop"), { once: true });
                }
            },
            { passive: true }
        );
    }

    // Optional: flag for quick sanity checks in console
    window.__homeInitialized = true;
}

// Run once DOM is ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHome, { once: true });
} else {
    initHome();
}
