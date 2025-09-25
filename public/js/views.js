(function () {
    const vLogin = document.getElementById("view-login");
    const vReg = document.getElementById("view-register");
    const toReg = document.getElementById("to-register");
    const toLog = document.getElementById("to-login");

    if (toReg) toReg.addEventListener("click", () => {
        if (vLogin) vLogin.style.display = "none";
        if (vReg) vReg.style.display = "block";
    });
    if (toLog) toLog.addEventListener("click", () => {
        if (vReg) vReg.style.display = "none";
        if (vLogin) vLogin.style.display = "block";
    });
})();
