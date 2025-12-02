const Stripe = require('stripe');

/**
 * Validates Stripe secret key format and content
 * @param {string} key - The Stripe secret key to validate
 * @throws {Error} If validation fails
 */
function validateStripeKey(key) {
    if (!key) {
        throw new Error('❌ STRIPE_SECRET_KEY is not set. Check your environment variables.');
    }

    const trimmedKey = key.trim();
    if (trimmedKey.length === 0) {
        throw new Error('❌ STRIPE_SECRET_KEY is empty or contains only whitespace.');
    }

    // Validate key format (sk_test_... or sk_live_... or rk_test_... or rk_live_...)
    const validPrefixes = ['sk_test_', 'sk_live_', 'rk_test_', 'rk_live_'];
    const hasValidPrefix = validPrefixes.some(prefix => trimmedKey.startsWith(prefix));

    if (!hasValidPrefix) {
        throw new Error(
            `❌ STRIPE_SECRET_KEY has invalid format. Expected format: sk_test_... or sk_live_...\n` +
            `   Received prefix: ${trimmedKey.substring(0, 8)}...`
        );
    }

    // Warn if using test key in production
    if (process.env.NODE_ENV === 'production' && trimmedKey.startsWith('sk_test_')) {
        console.warn(
            '⚠️  WARNING: Using Stripe TEST key in production environment!\n' +
            '   This may cause issues with real payments.'
        );
    }

    // Warn if key looks suspiciously short (typical keys are 100+ chars)
    if (trimmedKey.length < 50) {
        console.warn(
            `⚠️  WARNING: STRIPE_SECRET_KEY seems unusually short (${trimmedKey.length} chars).\n` +
            `   Typical Stripe keys are 100+ characters. Please verify your key.`
        );
    }

    return trimmedKey;
}

/**
 * Validates Stripe API version format
 * @param {string} version - The API version string
 * @returns {boolean} True if valid format
 */
function validateApiVersion(version) {
    if (!version) return false;
    // Format: YYYY-MM-DD
    const versionRegex = /^\d{4}-\d{2}-\d{2}$/;
    return versionRegex.test(version);
}

let stripe;
let STRIPE_API_VERSION;

try {
    // Validate and get the secret key
    const secretKey = validateStripeKey(process.env.STRIPE_SECRET_KEY);

    // Validate and set API version
    STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || '2024-06-20';

    if (!validateApiVersion(STRIPE_API_VERSION)) {
        console.warn(
            `⚠️  Invalid STRIPE_API_VERSION format: '${STRIPE_API_VERSION}'\n` +
            `   Expected format: YYYY-MM-DD. Falling back to default: 2024-06-20`
        );
        STRIPE_API_VERSION = '2024-06-20';
    }

    console.log(`[stripe] Initializing with API version ${STRIPE_API_VERSION}`);

    // Initialize Stripe with error handling
    try {
        stripe = new Stripe(secretKey, {
            apiVersion: STRIPE_API_VERSION,
            maxNetworkRetries: 2,
            timeout: 30000 // 30 seconds
        });
    } catch (versionError) {
        // If the SDK doesn't support this API version, fall back to default
        console.warn(
            `⚠️  Failed to initialize with API version '${STRIPE_API_VERSION}': ${versionError.message}\n` +
            `   Falling back to account default. Consider: npm i stripe@latest`
        );

        try {
            stripe = new Stripe(secretKey, {
                maxNetworkRetries: 2,
                timeout: 30000
            });
        } catch (fallbackError) {
            throw new Error(
                `❌ Failed to initialize Stripe even with fallback configuration:\n` +
                `   ${fallbackError.message}\n` +
                `   Check your Stripe SDK installation: npm i stripe@latest`
            );
        }
    }

    // Verify stripe object was created successfully
    if (!stripe || typeof stripe.customers === 'undefined') {
        throw new Error('❌ Stripe object was created but appears invalid or incomplete.');
    }

    console.log('[stripe] ✅ Stripe initialized successfully');

} catch (error) {
    console.error('[stripe] ❌ Critical error during Stripe initialization:', error.message);

    // Re-throw to prevent app from starting with broken Stripe
    throw new Error(
        `Failed to initialize Stripe: ${error.message}\n` +
        `The application cannot start without a valid Stripe configuration.`
    );
}

// Additional runtime error handler wrapper
const stripeProxy = new Proxy(stripe, {
    get(target, prop) {
        const value = target[prop];

        // Wrap methods to add error context
        if (typeof value === 'function') {
            return function (...args) {
                try {
                    return value.apply(target, args);
                } catch (error) {
                    console.error(`[stripe] Error calling stripe.${String(prop)}:`, error.message);
                    throw error;
                }
            };
        }

        return value;
    }
});

module.exports = {
    stripe: stripeProxy,
    STRIPE_API_VERSION,
    // Export validation functions for testing
    validateStripeKey,
    validateApiVersion
};
