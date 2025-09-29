// src/env.js
require('dotenv').config();

const ENV = {
    PORT: process.env.PORT || 3000,
    BASE_URL: process.env.BASE_URL || 'http://localhost:3000',

    // n8n
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',

    // stripe
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
    STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID || '',
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',

    // supabase
    SUPABASE_URL: process.env.SUPABASE_URL || '',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

    // app
    ADMIN_API_KEY: process.env.ADMIN_API_KEY || '',
};

module.exports = { ENV };
