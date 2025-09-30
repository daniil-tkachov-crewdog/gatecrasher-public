// Initializes a theme toggle switch.
export function initThemeToggle({ toggleId = "themeToggle" } = {}) {
    const root = document.documentElement;

    // If we already initialized once, bail.
    if (root.dataset.themeInit === "1") return;
    root.dataset.themeInit = "1";

    const toggle = document.getElementById(toggleId);

    // Read what boot script set (or fallback if missing)
    const bootMode = root.getAttribute("data-theme");
    const saved = (() => {
        try { return localStorage.getItem("xrl-theme"); } catch (_) { return null; }
    })();

    // If boot didn’t run for some reason, decide now (still before user sees)
    let mode = bootMode;
    if (!mode) {
        const systemPrefersLight =
            !saved && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
        mode = saved || (systemPrefersLight ? "light" : "dark");
        root.setAttribute("data-theme", mode);
        root.style.colorScheme = mode;
    }

    // Hydrate the toggle without causing another flip
    if (toggle) {
        // Replace any prior listener if hot-reloaded
        toggle.replaceWith(toggle.cloneNode(true));
        const freshToggle = document.getElementById(toggleId);
        if (freshToggle) {
            freshToggle.checked = mode === "light";
            freshToggle.addEventListener("change", () => {
                const next = freshToggle.checked ? "light" : "dark";
                if (next === root.getAttribute("data-theme")) return;
                // Temporarily disable transitions to avoid flicker during manual switch
                root.classList.add("theme-boot");
                root.setAttribute("data-theme", next);
                root.style.colorScheme = next;
                try { localStorage.setItem("xrl-theme", next); } catch (_) { }
                // Allow transitions again on next frame
                requestAnimationFrame(() => {
                    root.classList.remove("theme-boot");
                });
            });
        }
    }

    // Remove the boot no-transition class once JS is ready
    root.classList.remove("theme-boot");
}
