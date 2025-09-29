const { z } = require('zod');
const { stripe } = require('../../lib/stripe');
const { supabaseAdmin } = require('../../lib/supabaseAdmin');

function must(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env ${name}`);
    return v;
}
const PRICE_ID = must('STRIPE_PRICE_ID');
const APP_BASE_URL = must('APP_BASE_URL'); 

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    try {
        const Schema = z.object({ userId: z.string().uuid(), email: z.string().email() });
        const { userId, email } = Schema.parse(req.body || {});

        // Look up or create Stripe customer (mirrors your route)
        let { data: existing } = await supabaseAdmin
            .from('app_users')
            .select('user_id, email, stripe_customer_id')
            .eq('user_id', userId)
            .maybeSingle();

        let customerId = existing?.stripe_customer_id;
        if (!customerId) {
            const found = await stripe.customers.search({ query: `email:"${email}"` });
            const existingCust = found.data[0];
            if (existingCust) {
                if (!existingCust.metadata?.user_id) {
                    await stripe.customers.update(existingCust.id, { metadata: { user_id: userId } });
                }
                customerId = existingCust.id;
            } else {
                const created = await stripe.customers.create({ email, metadata: { user_id: userId } });
                customerId = created.id;
            }
            if (existing) {
                await supabaseAdmin.from('app_users').update({ email, stripe_customer_id: customerId }).eq('user_id', userId);
            } else {
                await supabaseAdmin.from('app_users').insert({ user_id: userId, email, stripe_customer_id: customerId });
            }
        }

        const idempotencyKey = `co_${userId}_${PRICE_ID}`;
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            line_items: [{ price: PRICE_ID, quantity: 1 }],
            allow_promotion_codes: true,
            success_url: `${APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${APP_BASE_URL}/cancel.html`,
            client_reference_id: userId,
            metadata: { user_id: userId }
        }, { idempotencyKey });

        return res.status(200).json({ url: session.url });
    } catch (e) {
        console.error('create-checkout-session error:', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
};
