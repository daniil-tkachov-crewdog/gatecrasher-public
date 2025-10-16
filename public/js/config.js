// Supabase project configuration 
export const SUPABASE_URL = "https://lurzlzhpjxcxhuoqpbok.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_x0hlg96FMQ9arkjGd2F9Pw_yQ-fLI3r";

// Stripe (FRONTEND) — add this:
// export const STRIPE_PUBLISHABLE_KEY = "pk_test_51Q9iTqRs3BC91kOa37UayqnTcmlLvQMjNLtYPhPpwavpUV5OcFEBo6aReHrZisYLXvLePPerEJhgn1rU9xI0dgMo000g0brqYA"; # Test Mode
export const STRIPE_PUBLISHABLE_KEY = "pk_live_51Q9iTqRs3BC91kOaKUdms5No5OKuBFydarTLvfbwwc7VOSw68kE88Z9wKgXCYZJukD0uS5C2w1KHB21VeOEvjXph00zZW2RDp2"; // Prod Mode

// Optional: keep a global for any legacy code that expects window.STRIPE_PUBLISHABLE_KEY
if (typeof window !== "undefined") {
    window.STRIPE_PUBLISHABLE_KEY = STRIPE_PUBLISHABLE_KEY;
}

// App routes 
export const ROUTE_AFTER_GOOGLE = "https://crewdog.app/run.html";
export const ROUTE_AFTER_LOGIN = "./run.html";
export const ROUTE_AFTER_VERIFY = "https://crewdog.app/verify.html";
