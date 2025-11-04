const Stripe = require('stripe');

// Fail fast if key missing
if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("❌ STRIPE_SECRET_KEY is not set. Check your environment variables.");
}

// Use latest safe version matching dashboard (fixes event shape mismatch)
const STRIPE_API_VERSION = '2024-09-30';

console.log(`Initializing Stripe with API version ${STRIPE_API_VERSION}`);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION,
});

console.log('Stripe initialized successfully');

module.exports = { stripe };
