(function () {
    const toggle = document.getElementById("themeToggle");
    const root = document.documentElement;
    const saved = localStorage.getItem("xrl-theme");
    if (saved) {
        root.setAttribute("data-theme", saved);
        if (toggle) toggle.checked = saved === "light";
    }
    if (toggle) {
        toggle.addEventListener("change", function () {
            const mode = toggle.checked ? "light" : "dark";
            root.setAttribute("data-theme", mode);
            localStorage.setItem("xrl-theme", mode);
        });
    }
})();
