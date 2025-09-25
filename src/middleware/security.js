// middleware/security.js
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');

function buildCsp() {
    const isProd = process.env.NODE_ENV === 'production';

    const directives = {
        "default-src": ["'self'"],

        "script-src": [
            "'self'", "'unsafe-inline'",
            "https://js.stripe.com",
            "https://www.googletagmanager.com",     // GTM container
            "https://www.google-analytics.com",     // GA4
            "https://cdn.jsdelivr.net",
            "https://esm.sh"
        ],

        "connect-src": [
            "'self'",
            "https://api.stripe.com",
            "https://lurzlzhpjxcxhuoqpbok.supabase.co",
            "wss://lurzlzhpjxcxhuoqpbok.supabase.co",
            "https://www.google-analytics.com",
            "https://region1.google-analytics.com",
            "https://www.googletagmanager.com"      // GTM bootstrap + preview handshake
        ],

        // GTM iframe + Stripe
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
            // dev-only additions are appended below
        ],

        "font-src": ["'self'", "data:"],          // dev-only additions appended below
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"]
    };

    if (!isProd) {
        // Allow Tag Assistant + debug badge assets during GTM Preview on localhost/staging
        directives["connect-src"].push("https://tagassistant.google.com");
        directives["frame-src"].push("https://tagassistant.google.com");
        directives["style-src"].push(
            "https://www.googletagmanager.com",     // debug badge CSS
            "https://fonts.googleapis.com"          // fonts CSS
        );
        directives["font-src"].push("https://fonts.gstatic.com");
        directives["img-src"].push("https://ssl.gstatic.com");
    }

    return { useDefaults: true, directives, reportOnly: false };
}

const corsOptions = {
    origin: ['http://localhost:3000'],
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

    // Skip xss-clean for Stripe webhook (needs raw body)
    app.use((req, res, next) => {
        if (req.originalUrl === '/api/stripe/webhook') return next();
        return xss()(req, res, next);
    });

    app.use(apiLimiter);
}

module.exports = { applySecurity };
