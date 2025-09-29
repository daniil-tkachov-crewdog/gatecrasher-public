// View switching (unchanged)
export function initViews() {
    const vLogin = document.getElementById("view-login");
    const vReg = document.getElementById("view-register");
    const toReg = document.getElementById("to-register");
    const toLog = document.getElementById("to-login");
    if (toReg) toReg.addEventListener("click", () => { vLogin.style.display = "none"; vReg.style.display = "block"; });
    if (toLog) toLog.addEventListener("click", () => { vReg.style.display = "none"; vLogin.style.display = "block"; });
}
