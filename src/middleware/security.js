/**
 * Security Middleware - CORS, Helmet, XSS, Rate Limiting
 */
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const xss = require('xss-clean');

function extractHost(url, context) {
    if (!url || typeof url !== 'string') {
        return '';
    }

    try {
        const parsedUrl = new URL(url);
        return parsedUrl.host;
    } catch (error) {
        console.error(`[security] ${context}: Invalid URL:`, error.message);
        return '';
    }
}

function extractOrigin(url, fallback, context) {
    if (!url || typeof url !== 'string') {
        return fallback;
    }

    try {
        const parsedUrl = new URL(url);
        return parsedUrl.origin;
    } catch (error) {
        console.error(`[security] ${context}: Invalid URL, using fallback`);
        return fallback;
    }
}

function buildCsp() {
    const isProd = process.env.NODE_ENV === 'production';

    const SUPABASE_URL = process.env.SUPABASE_URL || '';
    if (!SUPABASE_URL) {
        console.error('[security] SUPABASE_URL not set');
    }
    const supabaseHost = extractHost(SUPABASE_URL, 'Supabase URL');

    const N8N_ENDPOINT =
        process.env.N8N_ENDPOINT ||
        process.env.N8N_ENDPOINT_URL ||
        'https://crewdog.app.n8n.cloud';

    const n8nOrigin = extractOrigin(N8N_ENDPOINT, 'https://crewdog.app.n8n.cloud', 'N8N endpoint');

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

function parseCorsOrigins() {
    const defaultOrigins = [
        'https://www.crewdog.app',
        'https://crewdog.app',
        'https://crewdog-frontend.onrender.com',
        'http://localhost:5173',
        'http://localhost:8080'
    ];

    const RAW_CORS = process.env.CORS_ORIGINS;

    if (!RAW_CORS) {
        return defaultOrigins;
    }

    const allowedOrigins = RAW_CORS
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    if (allowedOrigins.length === 0) {
        console.error('[security] CORS_ORIGINS empty, using defaults');
        return defaultOrigins;
    }

    const validOrigins = [];
    const isProd = process.env.NODE_ENV === 'production';

    for (const origin of allowedOrigins) {
        if (isProd && origin.includes('localhost')) {
            console.error('[security] Localhost origin in production:', origin);
        }

        try {
            new URL(origin);
            validOrigins.push(origin);
        } catch (error) {
            console.error(`[security] Invalid CORS origin '${origin}':`, error.message);
        }
    }

    if (validOrigins.length === 0) {
        console.error('[security] No valid CORS origins, using defaults');
        return defaultOrigins;
    }

    return validOrigins;
}

/**
 * Applies security middleware to Express app
 */
function applySecurity(app) {
    if (!app || typeof app.use !== 'function') {
        throw new Error('applySecurity requires a valid Express app instance');
    }

    try {
        app.disable('x-powered-by');

        const allowedOrigins = parseCorsOrigins();

        try {
            app.use(cors({
                origin(origin, cb) {
                    if (!origin) return cb(null, true);

                    if (allowedOrigins.includes(origin)) {
                        return cb(null, true);
                    }

                    console.error('[security] CORS blocked:', origin);
                    return cb(new Error(`CORS policy blocked origin: ${origin}`));
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

            app.options('*', cors());

        } catch (error) {
            throw new Error(`Failed to configure CORS: ${error.message}`);
        }

        try {
            const cspConfig = buildCsp();
            app.use(helmet({
                contentSecurityPolicy: cspConfig,
                referrerPolicy: { policy: 'no-referrer' },
                crossOriginResourcePolicy: { policy: 'same-site' },
                crossOriginEmbedderPolicy: false
            }));

        } catch (error) {
            throw new Error(`Failed to configure Helmet: ${error.message}`);
        }

        try {
            app.use((req, res, next) => {
                if (req.originalUrl === '/api/stripe/webhook' || req.originalUrl === '/api/stripe/webhook-test') {
                    return next();
                }
                return xss()(req, res, next);
            });

        } catch (error) {
            throw new Error(`Failed to configure XSS protection: ${error.message}`);
        }

        try {
            const windowMinutes = 15;
            const maxRequests = parseInt(process.env.RATE_LIMIT_MAX) || 300;

            if (maxRequests < 1) {
                throw new Error(`Invalid RATE_LIMIT_MAX value: ${process.env.RATE_LIMIT_MAX}`);
            }

            app.use(rateLimit({
                windowMs: windowMinutes * 60 * 1000,
                max: maxRequests,
                standardHeaders: true,
                legacyHeaders: false,
                message: 'Too many requests from this IP, please try again later.',
                handler: (req, res) => {
                    console.error('[security] Rate limit exceeded:', req.ip);
                    res.status(429).json({
                        error: 'Too many requests',
                        message: 'You have exceeded the rate limit. Please try again later.',
                        retryAfter: Math.ceil(req.rateLimit.resetTime / 1000)
                    });
                }
            }));

        } catch (error) {
            throw new Error(`Failed to configure rate limiting: ${error.message}`);
        }

    } catch (error) {
        console.error('[security] Critical error:', error.message);
        throw error;
    }
}

module.exports = { applySecurity, parseCorsOrigins, extractHost, extractOrigin };
