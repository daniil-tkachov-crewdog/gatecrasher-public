// /js/auth-boot.js
(function () {
    try {
        // Replace these checks to match your auth: cookie, supabase, your token, etc.
        const hasCookie = document.cookie.includes('gc_session=')
            || document.cookie.includes('sb-access-token=');
        const hasLocal = !!localStorage.getItem('gc_auth_token');

        const isLoggedIn = hasCookie || hasLocal;

        if (!isLoggedIn) {
            const next = location.pathname + location.search + location.hash;
            location.replace('/login.html?next=' + encodeURIComponent(next));
        }
    } catch (e) {
        // If we can't read storage (privacy mode etc.), play it safe and require login
        location.replace('/login.html');
    }
})();
