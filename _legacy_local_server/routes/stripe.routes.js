// routes/stripe.js
const express = require('express');
const router = express.Router();
const { z } = require('zod');

// IMPORTANT: your app should export stripe & supabaseAdmin from these helpers.
// In tests we will mock these.
const { stripe } = require('../lib/stripe');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

/* ------------------------------- utils/env ------------------------------- */
function must(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env ${name}`);
    return v;
}
const PRICE_ID = must('STRIPE_PRICE_ID');            // e.g. price_123
const APP_BASE_URL = must('APP_BASE_URL');           // e.g. https://yourapp.com
const ADMIN_API_KEY = must('ADMIN_API_KEY');         // arbitrary strong secret
const STRIPE_WEBHOOK_SECRET = must('STRIPE_WEBHOOK_SECRET').trim();

/* ---------------------- helpers: Stripe + Supabase lookups ---------------------- */
async function getOrCreateCustomerByEmail(email, userId) {
    const found = await stripe.customers.search({ query: `email:"${email}"` });
    const existing = found.data[0];
    if (existing) {
        if (!existing.metadata?.user_id) {
            await stripe.customers.update(existing.id, { metadata: { user_id: userId } });
        }
        return existing.id;
    }
    const created = await stripe.customers.create({ email, metadata: { user_id: userId } });
    return created.id;
}

async function findUserIdByCustomerId(customerId) {
    const { data: row, error } = await supabaseAdmin
        .from('app_users')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();
    if (error) throw error;
    return row?.user_id || null;
}

function toIso(ts) {
    return ts ? new Date(ts * 1000).toISOString() : null;
}

async function upsertSubscription(userId, sub) {
    return supabaseAdmin.from('app_subscriptions').upsert({
        user_id: userId,
        stripe_subscription_id: sub.id,
        product_id: sub.items?.data?.[0]?.price?.product || null,
        price_id: sub.items?.data?.[0]?.price?.id || null,
        status: sub.status,
        current_period_start: toIso(sub.current_period_start),
        current_period_end: toIso(sub.current_period_end),
        cancel_at: toIso(sub.cancel_at),
        cancel_at_period_end: !!sub.cancel_at_period_end,
        trial_end: toIso(sub.trial_end),
    }, { onConflict: 'stripe_subscription_id' });
}

/* ----------------------------- ROUTES: Checkout ----------------------------- */
/**
 * POST /api/stripe/create-checkout-session
 * Body: { userId: uuid, email: string }
 */
router.post('/create-checkout-session', express.json(), async (req, res) => {
    try {
        console.log('[stripe] Received create-checkout-session request:', req.body);

        const Schema = z.object({ userId: z.string().uuid(), email: z.string().email() });
        const { userId, email } = Schema.parse(req.body);

        // Ensure app_users row + Stripe customer
        let { data: existing, error: selErr } = await supabaseAdmin
            .from('app_users')
            .select('user_id, email, stripe_customer_id')
            .eq('user_id', userId)
            .maybeSingle();
        if (selErr) throw selErr;

        let customerId = existing?.stripe_customer_id;
        if (!customerId) {
            customerId = await getOrCreateCustomerByEmail(email, userId);

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

        // Create subscription Checkout with idempotency
        const idempotencyKey = `co_${userId}_${PRICE_ID}`;
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            line_items: [{ price: PRICE_ID, quantity: 1 }],
            allow_promotion_codes: true,
            success_url: `${APP_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${APP_BASE_URL}/cancel.html`,
            client_reference_id: userId,
            metadata: { user_id: userId },
        }, { idempotencyKey });

        return res.json({ url: session.url });
    } catch (e) {
        console.error('[stripe] create-checkout-session error:', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/* ------------------------------ ROUTES: Webhook ------------------------------ */
/**
 * POST /api/stripe/webhook
 * NOTE: This route MUST precede any app-wide express.json() middleware,
 * and must use express.raw to keep the raw buffer for signature verification.
 */
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    console.log(
        '[webhook] Buffer?', Buffer.isBuffer(req.body),
        'len=', Buffer.isBuffer(req.body) ? req.body.length : 'n/a',
        '| have sig?', !!sig
    );

    if (!sig) return res.status(400).json({ error: 'Missing signature' });

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('[stripe] webhook signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        switch (event.type) {
            /* ---------------------- Checkout completed (no credits) ---------------------- */
            case 'checkout.session.completed': {
                const session = event.data.object;
                if (session.mode !== 'subscription') break;

                const subId = session.subscription;
                const customerId = session.customer;
                const userId = await findUserIdByCustomerId(customerId);
                if (!userId || !subId) break;

                const sub = await stripe.subscriptions.retrieve(subId);
                await upsertSubscription(userId, sub);
                console.log(`[stripe] checkout.session.completed: upserted sub for user ${userId}`);
                break;
            }

            /* -------------------------- Paid invoice = credits -------------------------- */
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                if (!invoice.subscription) break;

                const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                const customerId = sub.customer;
                const userId = await findUserIdByCustomerId(customerId);
                if (!userId) break;

                // Update subscription row (authoritative status/period)
                await upsertSubscription(userId, sub);

                // Reset credits for the period on subscription create/cycle
                if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_create') {
                    await supabaseAdmin.rpc('reset_monthly_credits', {
                        p_user_id: userId,
                        p_start: toIso(sub.current_period_start),
                        p_end: toIso(sub.current_period_end),
                        p_total: 25,
                    });
                    console.log(`[stripe] Payment succeeded, credits reset for user ${userId}`);
                }
                break;
            }

            /* ---------------------- Trial created; no credits granted --------------------- */
            case 'customer.subscription.created': {
                const sub = event.data.object;
                const customerId = sub.customer;
                const userId = await findUserIdByCustomerId(customerId);
                if (!userId) break;
                await upsertSubscription(userId, sub); // show periods/status immediately
                console.log(`[stripe] subscription.created: upserted for user ${userId}`);
                break;
            }

            /* ------------------------------ Status changes ------------------------------ */
            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const customerId = sub.customer;
                const userId = await findUserIdByCustomerId(customerId);
                if (!userId) break;
                await upsertSubscription(userId, sub);
                console.log(`[stripe] subscription.updated ${sub.id} -> ${sub.status}`);
                break;
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                if (!invoice.subscription) break;
                const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                const customerId = sub.customer;
                const userId = await findUserIdByCustomerId(customerId);
                if (!userId) break;
                await upsertSubscription(userId, sub); // status likely past_due
                console.log(`[stripe] invoice.payment_failed -> user ${userId} now ${sub.status}`);
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const customerId = sub.customer;
                const userId = await findUserIdByCustomerId(customerId);
                if (!userId) break;
                await supabaseAdmin.from('app_subscriptions').update({
                    status: 'canceled',
                    cancel_at_period_end: false,
                    current_period_end: new Date().toISOString(),
                }).eq('stripe_subscription_id', sub.id);
                console.log(`[stripe] subscription.deleted ${sub.id} (user ${userId})`);
                break;
            }

            default:
                // no-op; but still return 200 so Stripe doesn't retry
                break;
        }

        return res.json({ received: true });
    } catch (e) {
        console.error('[stripe] webhook error', e);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/* ------------------------------ Admin cancel API ------------------------------ */
/**
 * POST /api/stripe/admin/cancel
 * Headers: x-admin-key: <ADMIN_API_KEY>
 * Body: { userId?: uuid, stripeSubscriptionId?: string }
 */
router.post('/admin/cancel', express.json(), async (req, res) => {
    try {
        if (req.headers['x-admin-key'] !== ADMIN_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const Schema = z.object({
            userId: z.string().uuid().optional(),
            stripeSubscriptionId: z.string().optional(),
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
