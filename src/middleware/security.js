// middleware/security.js
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');

function buildCsp() {
    const isProd = process.env.NODE_ENV === 'production';

    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    let supabaseHost = '';
    try { supabaseHost = new URL(SUPABASE_URL).host; } catch (_) { }

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

        "connect-src": [
            "'self'",
            SUPABASE_URL,
            supabaseHost ? `wss://${supabaseHost}` : null,
            "https://api.stripe.com",
            "https://js.stripe.com",
            "https://www.googletagmanager.com",
            "https://www.google-analytics.com",
            "https://region1.google-analytics.com",
            n8nOrigin
        ].filter(Boolean),

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

    // Allowed origins
    const RAW_CORS = process.env.CORS_ORIGINS || [
        'https://www.crewdog.app',
        'https://crewdog.app',
        'https://crewdog-frontend.onrender.com', // temporary during transition
        'http://localhost:5173',
        'http://localhost:8080'
    ].join(',');

    const allowedOrigins = RAW_CORS.split(',').map(s => s.trim()).filter(Boolean);

    app.use(cors({
        origin(origin, cb) {
            // allow no-origin (curl, Postman, health checks)
            if (!origin) return cb(null, true);
            if (allowedOrigins.includes(origin)) return cb(null, true);
            return cb(new Error(`CORS blocked: ${origin}`));
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-Requested-With',
            'X-Tenant-Id',
            'X-Admin-Key'
        ],
        maxAge: 600
    }));

    // Preflight support
    app.options('*', cors());

    app.use(helmet({
        contentSecurityPolicy: buildCsp(),
        referrerPolicy: { policy: 'no-referrer' },
        crossOriginResourcePolicy: { policy: 'same-site' },
        crossOriginEmbedderPolicy: false
    }));

    // Skip XSS clean for Stripe webhook
    app.use((req, res, next) => {
        if (req.originalUrl === '/api/stripe/webhook') return next();
        return xss()(req, res, next);
    });

    app.use(rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false
    }));
}

module.exports = { applySecurity };
