// Initializes a theme toggle switch.
export function initThemeToggle({ toggleId = "themeToggle" } = {}) {
    const toggle = document.getElementById(toggleId);
    const root = document.documentElement;

    // If we already initialized once, bail.
    if (root.dataset.themeInit === "1") return;
    root.dataset.themeInit = "1";

    const saved = localStorage.getItem("xrl-theme");
    const systemPrefersLight =
        !saved && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;

    const mode = saved || (systemPrefersLight ? "light" : "dark");
    root.setAttribute("data-theme", mode);

    if (toggle) {
        toggle.checked = mode === "light";
        // Remove any prior listener if hot-reloaded
        toggle.replaceWith(toggle.cloneNode(true));
        const freshToggle = document.getElementById(toggleId);
        freshToggle?.addEventListener("change", () => {
            const next = freshToggle.checked ? "light" : "dark";
            root.setAttribute("data-theme", next);
            localStorage.setItem("xrl-theme", next);
        });
    }
}
