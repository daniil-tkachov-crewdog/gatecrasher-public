import { SUPABASE_URL, SUPABASE_ANON_KEY, ROUTE_AFTER_GOOGLE, ROUTE_AFTER_LOGIN, ROUTE_AFTER_VERIFY } from "./config.js";
import { show, disable, validEmail, pushEvent } from "./helpers.js";

// === Supabase client ===
// Uses the global UMD from CDN (window.supabase) as in original code
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Google login button (+ analytics event)
export function initGoogleLogin() {
    const gbtn = document.getElementById("google-btn");
    if (!gbtn) return;
    gbtn.addEventListener("click", async () => {
        // track login method=google
        pushEvent({ event: "login", method: "google" });

        await supabase.auth.signInWithOAuth({
            provider: "google",
            options: { redirectTo: ROUTE_AFTER_GOOGLE }
        });
    });
}

// PASSWORD LOGIN (+ analytics event)
export function initPasswordLogin() {
    const form = document.getElementById("form-login");
    const btn = document.getElementById("login-btn");
    const err = document.getElementById("login-error");
    if (!form) return;

    form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        show(err, "");
        const email = document.getElementById("login-email").value.trim();
        const password = document.getElementById("login-pass").value;

        if (!validEmail(email)) return show(err, "Enter a valid email.");
        if (!password || password.length < 6) return show(err, "Password must be at least 6 characters.");

        disable(btn, true);
        try {
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            disable(btn, false);

            if (error) {
                console.log("Login error details:", error);
                return show(err, "Invalid email or password");
            }

            // track login method=password
            pushEvent({ event: "login", method: "password" });

            window.location.href = ROUTE_AFTER_LOGIN;
        } catch (e) {
            disable(btn, false);
            console.error("Login network error:", e);
            show(err, "Failed to connect to server. Check your internet or try again later.");
        }
    });
}

// REGISTER (+ analytics event)
export function initRegister() {
    const form = document.getElementById("form-register");
    const btn = document.getElementById("reg-btn");
    const err = document.getElementById("reg-error");
    const ok = document.getElementById("reg-ok");
    if (!form) return;

    form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        show(err, ""); show(ok, "");
        const email = document.getElementById("reg-email").value.trim();
        const pass1 = document.getElementById("reg-pass").value;
        const pass2 = document.getElementById("reg-pass2").value;

        if (!validEmail(email)) return show(err, "Enter a valid email.");
        if (!pass1 || pass1.length < 6) return show(err, "Password must be at least 6 characters.");
        if (pass1 !== pass2) return show(err, "Passwords do not match.");

        disable(btn, true);
        try {
            const { data, error } = await supabase.auth.signUp({
                email,
                password: pass1,
                options: {
                    emailRedirectTo: ROUTE_AFTER_VERIFY
                }
            });
            disable(btn, false);

            if (error) {
                console.log("Registration error details:", error);
                return show(err, /already/i.test(error.message) ? "Email already in use" : "Registration failed: " + error.message);
            }

            show(ok, "Registration successful! Please check your inbox and verify your email to activate your account. After verification, return here to log in.");

            // track sign_up method=email
            pushEvent({ event: "sign_up", method: "email" });

        } catch (e) {
            disable(btn, false);
            console.error("Registration network error:", e);
            show(err, "Failed to connect to server. Check your internet or try again later.");
        }
    });
}
