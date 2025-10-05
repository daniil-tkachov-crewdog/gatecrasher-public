document.addEventListener("DOMContentLoaded", () => {
    const jdLink = document.getElementById("JD_link");
    const jdText = document.getElementById("JD");
    const banner = document.getElementById("runBanner");

    function showConflict(msg) {
        banner.classList.remove("error");
        banner.classList.add("info");          // neutral tone
        banner.textContent = msg;
        banner.style.display = "block";
    }
    function clearConflict() {
        banner.textContent = "";
        banner.style.display = "none";
        banner.classList.remove("info");
    }

    jdLink.addEventListener("input", () => {
        if (jdLink.value.trim().length > 0) {
            jdText.disabled = true;
            jdText.setAttribute("aria-disabled", "true");
            showConflict("You can paste either a link to the job OR the job description text.");
        } else {
            jdText.disabled = false;
            jdText.removeAttribute("aria-disabled");
            clearConflict();
        }
    });

    jdText.addEventListener("input", () => {
        if (jdText.value.trim().length > 0) {
            jdLink.disabled = true;
            jdLink.setAttribute("aria-disabled", "true");
            showConflict("You can paste either a link to the job OR the job description text.");
        } else {
            jdLink.disabled = false;
            jdLink.removeAttribute("aria-disabled");
            clearConflict();
        }
    });
});
