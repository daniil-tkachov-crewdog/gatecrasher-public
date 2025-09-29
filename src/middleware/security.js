// middleware/security.js
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');

function buildCsp() {
    const isProd = process.env.NODE_ENV === 'production';

    // ---- External endpoints (from env, with safe fallbacks) ----
    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    let supabaseHost = '';
    try { supabaseHost = new URL(SUPABASE_URL).host; } catch (_) { }

    // accept either var name
    const N8N_ENDPOINT =
        process.env.N8N_ENDPOINT ||
        process.env.N8N_ENDPOINT_URL ||
        'https://crewdog.app.n8n.cloud';

    let n8nOrigin = 'https://crewdog.app.n8n.cloud';
    try { n8nOrigin = new URL(N8N_ENDPOINT).origin; } catch (_) { }

    const directives = {
        "default-src": ["'self'"],

        "script-src": [
            "'self'",
            "'unsafe-inline'",
            "https://js.stripe.com",
            "https://www.googletagmanager.com",
            "https://www.google-analytics.com",
            "https://cdn.jsdelivr.net",
            "https://esm.sh"
        ],

        "style-src": [
            "'self'",
            "'unsafe-inline'",
            "https://fonts.googleapis.com",
            "https://www.googletagmanager.com"
        ],

        "img-src": [
            "'self'",
            "data:",
            "https://www.google-analytics.com",
            "https://www.googletagmanager.com",
            "https://www.gstatic.com"
        ],

        "font-src": [
            "'self'",
            "data:",
            "https://fonts.gstatic.com"
        ],

        "frame-src": [
            "'self'",
            "https://js.stripe.com",
            "https://www.googletagmanager.com"
        ],

        // XHR/fetch/WebSockets
        "connect-src": [
            "'self'",
            SUPABASE_URL,                                   // Supabase REST
            supabaseHost ? `wss://${supabaseHost}` : null,  // Supabase Realtime
            "https://api.stripe.com",
            "https://js.stripe.com",
            "https://www.googletagmanager.com",
            "https://www.google-analytics.com",
            "https://region1.google-analytics.com",
            n8nOrigin
        ].filter(Boolean),

        // Allow POSTs to n8n as a fallback
        "form-action": ["'self'", n8nOrigin],

        "worker-src": ["'self'", "blob:"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"]
    };

    if (!isProd) {
        directives["connect-src"].push("https://tagassistant.google.com");
        directives["frame-src"].push("https://tagassistant.google.com");
        directives["img-src"].push("https://ssl.gstatic.com");
    }

    return { useDefaults: true, directives, reportOnly: false };
}

function applySecurity(app) {
    app.disable('x-powered-by');

    // Your production origin
    const PROD_ORIGIN =
        process.env.APP_BASE_URL ||
        process.env.APP_ORIGIN ||
        'https://crewdog.app';

    // Single CORS middleware (no duplicates)
    const allowedOrigins = [
        PROD_ORIGIN,             // https://crewdog.app
        'http://localhost:3000'  // dev
    ].filter(Boolean);

    app.use(cors({
        origin: allowedOrigins,
        credentials: false // set true only if you're using cookies/Authorization headers cross-site
    }));

    // Helmet with CSP
    app.use(helmet({
        contentSecurityPolicy: buildCsp(),
        referrerPolicy: { policy: 'no-referrer' },
        crossOriginResourcePolicy: { policy: 'same-site' },
        crossOriginEmbedderPolicy: false // avoid COEP issues with CDN assets
    }));

    // XSS: skip ONLY for Stripe raw-body route
    app.use((req, res, next) => {
        if (req.originalUrl === '/api/stripe/webhook') return next();
        return xss()(req, res, next);
    });

    // Basic rate limit
    app.use(rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false
    }));
}

module.exports = { applySecurity };
