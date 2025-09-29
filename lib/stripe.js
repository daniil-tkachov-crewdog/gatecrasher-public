const Stripe = require('stripe');
console.log('Initializing Stripe with API version 2024-06-20');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
console.log('Stripe initialized successfully');
module.exports = { stripe };
