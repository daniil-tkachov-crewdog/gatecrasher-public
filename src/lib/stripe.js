// server/lib/stripe.js (or wherever your helper lives)
const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("❌ STRIPE_SECRET_KEY is not set. Check your environment variables.");
}

// Default to your account's current default (Dashboard shows 2024-06-20)
const STRIPE_API_VERSION = process.env.STRIPE_API_VERSION || '2024-06-20';

console.log(`[stripe] Initializing with API version ${STRIPE_API_VERSION}`);

let stripe;
try {
    // Try the requested version (works if SDK supports it)
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
} catch (e) {
    // If the SDK is too old for this version, fall back gracefully
    console.warn(
        `[stripe] Invalid API version '${STRIPE_API_VERSION}' for this SDK: ${e.message}\n` +
        `[stripe] Falling back to account default API version. Consider: npm i stripe@latest`
    );
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
}

console.log('[stripe] ✅ Stripe initialized');

module.exports = { stripe, STRIPE_API_VERSION };
