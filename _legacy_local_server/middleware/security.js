// middleware/security.js
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');

function buildCsp() {
    const isProd = process.env.NODE_ENV === 'production';

    // ✅ Allowlist your n8n endpoint(s)
    const N8N_ENDPOINT = process.env.N8N_ENDPOINT || 'https://crewdog.app.n8n.cloud';
    const n8nOrigin = (() => {
        try { return new URL(N8N_ENDPOINT).origin; } catch { return 'https://crewdog.app.n8n.cloud'; }
    })();

    const directives = {
        "default-src": ["'self'"],

        "script-src": [
            "'self'", "'unsafe-inline'",
            "https://js.stripe.com",
            "https://www.googletagmanager.com",
            "https://www.google-analytics.com",
            "https://cdn.jsdelivr.net",
            "https://esm.sh"
        ],

        // ✅ Add n8n origin here for fetch/XHR/WebSockets
        "connect-src": [
            "'self'",
            n8nOrigin,
            "https://api.stripe.com",
            "https://lurzlzhpjxcxhuoqpbok.supabase.co",
            "wss://lurzlzhpjxcxhuoqpbok.supabase.co",
            "https://www.google-analytics.com",
            "https://region1.google-analytics.com",
            "https://www.googletagmanager.com"
        ],

        "frame-src": [
            "'self'",
            "https://js.stripe.com",
            "https://www.googletagmanager.com"
        ],

        "img-src": [
            "'self'", "data:",
            "https://www.google-analytics.com",
            "https://www.googletagmanager.com",
            "https://www.gstatic.com"
        ],

        "style-src": [
            "'self'", "'unsafe-inline'"
        ],

        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],

        // ✅ Add n8n origin here to allow form POSTs (good fallback)
        "form-action": ["'self'", n8nOrigin]
    };

    if (!isProd) {
        directives["connect-src"].push("https://tagassistant.google.com");
        directives["frame-src"].push("https://tagassistant.google.com");
        directives["style-src"].push(
            "https://www.googletagmanager.com",
            "https://fonts.googleapis.com"
        );
        directives["font-src"].push("https://fonts.gstatic.com");
        directives["img-src"].push("https://ssl.gstatic.com");
    }

    return { useDefaults: true, directives, reportOnly: false };
}

const corsOptions = {
    // Add your production origin(s) too, not just localhost
    origin: [
        'http://localhost:3000',
        process.env.APP_ORIGIN || 'https://crewdog.app'
    ],
    credentials: true
};

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
});

function applySecurity(app) {
    app.disable('x-powered-by');
    app.use(cors(corsOptions));

    app.use(helmet({
        contentSecurityPolicy: buildCsp(),
        referrerPolicy: { policy: 'no-referrer' },
        crossOriginResourcePolicy: { policy: 'same-site' }
    }));

    app.use((req, res, next) => {
        if (req.originalUrl === '/api/stripe/webhook') return next();
        return xss()(req, res, next);
    });

    app.use(apiLimiter);
}

module.exports = { applySecurity };
