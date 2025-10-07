// /js/footer.js
async function loadFooter() {
    try {
        const res = await fetch("../footer.html");
        if (!res.ok) throw new Error("Footer load failed");
        const html = await res.text();
        document.body.insertAdjacentHTML("beforeend", html);
    } catch (err) {
        console.error("Footer load error:", err);
    }
}

document.addEventListener("DOMContentLoaded", loadFooter);
