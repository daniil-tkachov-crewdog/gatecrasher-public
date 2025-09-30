import { initThemeToggle } from "./theme.js";

function init() {
    initThemeToggle({ toggleId: "themeToggle" });
    initAuthGuard({ redirectTo: "./login.html" });
    initRunForm({
        formId: "gatecrasher-form",
        resultId: "result",
        jdId: "JD",
        leadsCheckboxId: "JH_tickbox",
        submitId: "submitBtn",
    });

    refreshSummaryAndUI();

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshSummaryAndUI();
    });

    try {
        const bc = new BroadcastChannel("gc-activity");
        bc.addEventListener("message", (e) => {
            if (e?.data?.type === "search_used") refreshSummaryAndUI();
        });
    } catch { }

    const form = byId("gatecrasher-form");
    if (form) form.addEventListener("submit", onSubmitGuard, true);
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
    init();
}
