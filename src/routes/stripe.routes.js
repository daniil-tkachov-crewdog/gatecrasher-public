const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { stripe } = require('../lib/stripe');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

/**
 * POST /api/stripe/create-checkout-session
 */
router.post('/create-checkout-session', express.json(), async (req, res) => {
    try {
        console.log('[stripe] Received create-checkout-session request:', req.body);

        const Schema = z.object({
            userId: z.string().uuid(),
            email: z.string().email()
        });
        const { userId, email } = Schema.parse(req.body);

        // Ensure app_users row + Stripe customer
        const { data: existing, error: selErr } = await supabaseAdmin
            .from('app_users')
            .select('user_id, stripe_customer_id')
            .eq('user_id', userId)
            .maybeSingle();
        if (selErr) throw selErr;

        let customerId = existing?.stripe_customer_id;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email,
                metadata: { user_id: userId }
            });
            customerId = customer.id;

            if (existing) {
                await supabaseAdmin
                    .from('app_users')
                    .update({ email, stripe_customer_id: customerId })
                    .eq('user_id', userId);
            } else {
                await supabaseAdmin
                    .from('app_users')
                    .insert({ user_id: userId, email, stripe_customer_id: customerId });
            }
        }

        // Create subscription Checkout
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
            allow_promotion_codes: true,
            success_url: `${process.env.APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.APP_BASE_URL}/cancel.html`,
            metadata: { user_id: userId }
        });

        return res.json({ url: session.url });
    } catch (e) {
        console.error('[stripe] create-checkout-session error:', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/**
 * POST /api/stripe/webhook
 * IMPORTANT: must receive the raw Buffer (no JSON body parsing)
 */
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();

    console.log(
        '[webhook] Buffer?', Buffer.isBuffer(req.body),
        'len=', Buffer.isBuffer(req.body) ? req.body.length : 'n/a',
        '| have sig?', !!sig,
        '| have whsec?', !!endpointSecret,
        '| whsec head:', endpointSecret ? endpointSecret.slice(0, 7) + '…' + endpointSecret.slice(-5) : 'n/a'
    );

    if (!sig) return res.status(400).json({ error: 'Missing signature' });
    if (!endpointSecret) return res.status(500).json({ error: 'No STRIPE_WEBHOOK_SECRET set' });

    let event;
    try {
        event = stripe.webhooks.constructEvent(
            req.body,         // raw Buffer
            sig,
            endpointSecret
        );
    } catch (err) {
        console.error('[stripe] webhook signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                if (session.mode !== 'subscription') break;

                const subId = session.subscription;
                const customerId = session.customer;

                // Map to user
                const { data: userRow } = await supabaseAdmin
                    .from('app_users')
                    .select('user_id')
                    .eq('stripe_customer_id', customerId)
                    .single();
                if (!userRow) break;

                const sub = await stripe.subscriptions.retrieve(subId);

                // Upsert subscription
                await supabaseAdmin.from('app_subscriptions').upsert({
                    user_id: userRow.user_id,
                    stripe_subscription_id: sub.id,
                    product_id: sub.items.data[0]?.price.product || null,
                    price_id: sub.items.data[0]?.price.id || null,
                    status: sub.status,
                    current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
                    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
                    cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
                    cancel_at_period_end: sub.cancel_at_period_end,
                    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null
                }, { onConflict: 'stripe_subscription_id' });

                // Reset monthly credits to 25 for this billing period
                await supabaseAdmin.rpc('reset_monthly_credits', {
                    p_user_id: userRow.user_id,
                    p_start: new Date(sub.current_period_start * 1000).toISOString(),
                    p_end: new Date(sub.current_period_end * 1000).toISOString(),
                    p_total: 25
                });

                console.log(`[stripe] Subscription created for user ${userRow.user_id}`);
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                if (!invoice.subscription) break;

                const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                const customerId = sub.customer;

                const { data: userRow } = await supabaseAdmin
                    .from('app_users')
                    .select('user_id')
                    .eq('stripe_customer_id', customerId)
                    .single();
                if (!userRow) break;

                if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_create') {
                    await supabaseAdmin.rpc('reset_monthly_credits', {
                        p_user_id: userRow.user_id,
                        p_start: new Date(sub.current_period_start * 1000).toISOString(),
                        p_end: new Date(sub.current_period_end * 1000).toISOString(),
                        p_total: 25
                    });
                }

                await supabaseAdmin.from('app_subscriptions').update({
                    status: sub.status,
                    current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
                    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
                    cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
                    cancel_at_period_end: sub.cancel_at_period_end,
                    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
                    price_id: sub.items.data[0]?.price.id || null,
                    product_id: sub.items.data[0]?.price.product || null
                }).eq('stripe_subscription_id', sub.id);

                console.log(`[stripe] Payment succeeded, quota reset for user ${userRow.user_id}`);
                break;
            }

            case 'customer.subscription.updated': {
                const sub = event.data.object;
                await supabaseAdmin.from('app_subscriptions').update({
                    status: sub.status,
                    current_period_start: new Date(sub.current_period_start * 1000).toISOString(),
                    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
                    cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
                    cancel_at_period_end: sub.cancel_at_period_end,
                    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
                    price_id: sub.items.data[0]?.price.id || null,
                    product_id: sub.items.data[0]?.price.product || null
                }).eq('stripe_subscription_id', sub.id);

                console.log(`[stripe] Subscription updated: ${sub.id}`);
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                await supabaseAdmin.from('app_subscriptions').update({
                    status: 'canceled',
                    cancel_at_period_end: false,
                    current_period_end: new Date().toISOString()
                }).eq('stripe_subscription_id', sub.id);

                console.log(`[stripe] Subscription canceled: ${sub.id}`);
                break;
            }

            default:
                // no-op; but respond 200 so Stripe doesn’t retry
                break;
        }

        return res.json({ received: true });
    } catch (e) {
        console.error('[stripe] webhook error', e);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/**
 * POST /api/stripe/admin/cancel
 * x-admin-key: <ADMIN_API_KEY>
 */
router.post('/admin/cancel', express.json(), async (req, res) => {
    try {
        if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const Schema = z.object({
            userId: z.string().uuid().optional(),
            stripeSubscriptionId: z.string().optional()
        }).refine(v => v.userId || v.stripeSubscriptionId, { message: 'Provide userId or stripeSubscriptionId' });

        const body = Schema.parse(req.body);
        let subId = body.stripeSubscriptionId;

        if (!subId && body.userId) {
            const { data: row } = await supabaseAdmin
                .from('app_subscriptions')
                .select('stripe_subscription_id, status')
                .eq('user_id', body.userId)
                .in('status', ['active', 'trialing', 'past_due'])
                .maybeSingle();
            if (!row?.stripe_subscription_id) return res.status(404).json({ error: 'No active subscription' });
            subId = row.stripe_subscription_id;
        }

        const canceled = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
        return res.json({ ok: true, status: canceled.status, cancel_at_period_end: canceled.cancel_at_period_end });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
});

module.exports = router;
