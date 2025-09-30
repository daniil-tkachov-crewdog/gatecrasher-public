(function () {
    var KEY = "xrl-theme";
    var saved = null;

    try {
        saved = localStorage.getItem(KEY);
    } catch (_) {
        // localStorage might be blocked, ignore
    }

    // Resolve initial mode synchronously (no reflow after paint)
    var mode = saved;
    if (!mode) {
        var mql =
            window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: light)");
        mode = mql && mql.matches ? "light" : "dark";
    }

    // Set attribute & color-scheme before stylesheets load
    var root = document.documentElement;
    root.setAttribute("data-theme", mode);
    root.style.colorScheme = mode; // native form controls + scrollbars

    // Optional: prevent CSS transition flashes during boot
    root.classList.add("theme-boot");
})();
