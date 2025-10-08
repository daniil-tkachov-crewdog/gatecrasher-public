// src/routes/stripe.routes.js
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
const PRICE_ID = must('STRIPE_PRICE_ID');                  // main Pro plan
// Optional so the server boots even before you configure the £2 price:
const PRICE_ID_2GBP = process.env.STRIPE_PRICE_ID_2GBP || null;
const APP_BASE_URL = must('APP_BASE_URL');
const ADMIN_API_KEY = must('ADMIN_API_KEY');
const STRIPE_WEBHOOK_SECRET = must('STRIPE_WEBHOOK_SECRET').trim();

/* Optional: explicit portal configuration id (bpc_...), not required */
const STRIPE_BILLING_PORTAL_CONFIGURATION_ID =
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || null;

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

/* Active/trialing subscription for a user (from our DB) */
async function getActiveSubRowForUser(userId) {
    const { data: row, error } = await supabaseAdmin
        .from('app_subscriptions')
        .select('stripe_subscription_id, status')
        .eq('user_id', userId)
        .in('status', ['active', 'trialing', 'past_due', 'unpaid'])
        .order('current_period_end', { ascending: false })
        .maybeSingle();
    if (error) throw error;
    return row || null;
}

/* ----------------------------- ROUTES: Checkout ----------------------------- */
/** POST /api/stripe/create-checkout-session */
router.post('/create-checkout-session', express.json(), async (req, res) => {
    try {
        const Schema = z.object({ userId: z.string().uuid(), email: z.string().email() });
        const { userId, email } = Schema.parse(req.body);

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
                await supabaseAdmin.from('app_users')
                    .update({ email, stripe_customer_id: customerId })
                    .eq('user_id', userId);
            } else {
                await supabaseAdmin.from('app_users')
                    .insert({ user_id: userId, email, stripe_customer_id: customerId });
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
            metadata: { user_id: userId },
        }, { idempotencyKey });

        return res.json({ url: session.url });
    } catch (e) {
        console.error('[stripe] create-checkout-session error:', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/* ============================ NEW: Billing Portal ============================ */
/** POST /api/stripe/portal
 * Body: { userId: uuid, email: string }
 * Returns: { url }
 */
router.post('/portal', express.json(), async (req, res) => {
    try {
        const Schema = z.object({
            userId: z.string().uuid(),
            email: z.string().email()
        });
        const { userId, email } = Schema.parse(req.body);

        // Find or create Stripe customer and persist if needed
        let { data: existing, error: selErr } = await supabaseAdmin
            .from('app_users')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .maybeSingle();
        if (selErr) throw selErr;

        let customerId = existing?.stripe_customer_id;
        if (!customerId) {
            customerId = await getOrCreateCustomerByEmail(email, userId);
            await supabaseAdmin
                .from('app_users')
                .upsert({ user_id: userId, email, stripe_customer_id: customerId }, { onConflict: 'user_id' });
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${APP_BASE_URL}/account.html`,
            ...(STRIPE_BILLING_PORTAL_CONFIGURATION_ID ? { configuration: STRIPE_BILLING_PORTAL_CONFIGURATION_ID } : {})
        });

        return res.json({ url: session.url });
    } catch (e) {
        console.error('[stripe] portal error:', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/* ------------------------------ ROUTES: Webhook ------------------------------ */
/** POST /api/stripe/webhook */
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
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
            case 'checkout.session.completed': {
                const session = event.data.object;
                if (session.mode !== 'subscription') break;
                const subId = session.subscription;
                const customerId = session.customer;
                const userId = await findUserIdByCustomerId(customerId);
                if (!userId || !subId) break;
                const sub = await stripe.subscriptions.retrieve(subId);
                await upsertSubscription(userId, sub);
                break;
            }
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                if (!invoice.subscription) break;
                const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                const userId = await findUserIdByCustomerId(sub.customer);
                if (!userId) break;
                await upsertSubscription(userId, sub);
                if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_create') {
                    await supabaseAdmin.rpc('reset_monthly_credits', {
                        p_user_id: userId,
                        p_start: toIso(sub.current_period_start),
                        p_end: toIso(sub.current_period_end),
                        p_total: 25,
                    });
                }
                break;
            }
            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const userId = await findUserIdByCustomerId(sub.customer);
                if (!userId) break;
                await upsertSubscription(userId, sub);
                break;
            }
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                if (!invoice.subscription) break;
                const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                const userId = await findUserIdByCustomerId(sub.customer);
                if (!userId) break;
                await upsertSubscription(userId, sub); // likely past_due
                break;
            }
            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const userId = await findUserIdByCustomerId(sub.customer);
                if (!userId) break;
                await supabaseAdmin.from('app_subscriptions').update({
                    status: 'canceled',
                    cancel_at_period_end: false,
                    current_period_end: new Date().toISOString(),
                }).eq('stripe_subscription_id', sub.id);
                break;
            }
            default:
                break;
        }
        return res.json({ received: true });
    } catch (e) {
        console.error('[stripe] webhook error', e);
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/* ------------------------------ Admin cancel API ------------------------------ */
/** POST /api/stripe/admin/cancel */
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

/* ========================== NEW: Customer cancel flow ========================== */
/** POST /api/stripe/cancel/feedback
 * Body: { userId: uuid, reason: string, otherText?: string }
 */
router.post('/cancel/feedback', express.json(), async (req, res) => {
    try {
        const Schema = z.object({
            userId: z.string().uuid(),
            reason: z.string().min(1),
            otherText: z.string().optional()
        });
        const { userId, reason, otherText } = Schema.parse(req.body);

        const subRow = await getActiveSubRowForUser(userId);
        if (!subRow?.stripe_subscription_id) {
            return res.status(404).json({ error: 'No active subscription' });
        }

        const { error } = await supabaseAdmin
            .from('app_cancellation_feedback')
            .insert({
                user_id: userId,
                subscription_id: subRow.stripe_subscription_id,
                reason,
                other_text: otherText || null,
                downgraded: false
            });
        if (error) throw error;

        return res.json({ ok: true });
    } catch (e) {
        console.error('[stripe] /cancel/feedback error', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/** POST /api/stripe/downgrade
 * Body: { userId: uuid }
 */
router.post('/downgrade', express.json(), async (req, res) => {
    try {
        if (!PRICE_ID_2GBP) {
            return res.status(500).json({ error: 'Downsell price not configured. Set STRIPE_PRICE_ID_2GBP.' });
        }

        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body);

        const subRow = await getActiveSubRowForUser(userId);
        if (!subRow?.stripe_subscription_id) {
            return res.status(404).json({ error: 'No active subscription' });
        }

        // Retrieve subscription to get item id
        const sub = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id);
        const subItem = sub.items?.data?.[0];
        if (!subItem?.id) throw new Error('Subscription item not found');

        const updated = await stripe.subscriptions.update(sub.id, {
            items: [{ id: subItem.id, price: PRICE_ID_2GBP, quantity: 1 }],
            proration_behavior: 'none'
        });

        // Refresh local state
        await upsertSubscription(userId, updated);

        // Insert a marker feedback row indicating the user accepted the downsell
        await supabaseAdmin.from('app_cancellation_feedback').insert({
            user_id: userId,
            subscription_id: updated.id,
            reason: 'downgraded_offer_accepted',
            other_text: null,
            downgraded: true
        });

        return res.json({ ok: true, status: updated.status, price_id: PRICE_ID_2GBP });
    } catch (e) {
        console.error('[stripe] /downgrade error', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/** POST /api/stripe/cancel
 * Body: { userId: uuid }
 */
router.post('/cancel', express.json(), async (req, res) => {
    try {
        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body);

        const subRow = await getActiveSubRowForUser(userId);
        if (!subRow?.stripe_subscription_id) {
            return res.status(404).json({ error: 'No active subscription' });
        }

        const canceled = await stripe.subscriptions.update(subRow.stripe_subscription_id, {
            cancel_at_period_end: true
        });

        await upsertSubscription(userId, canceled);

        return res.json({ ok: true, status: canceled.status, cancel_at_period_end: canceled.cancel_at_period_end });
    } catch (e) {
        console.error('[stripe] /cancel error', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/* ============================ NEW: Renew-now API ============================ */
/** POST /api/stripe/renew-now
 * Body: { userId: uuid }
 * Forces a new billing cycle to start NOW (no proration). If the invoice is
 * immediately paid, we also reset credits; otherwise your webhook will.
 */
router.post('/renew-now', express.json(), async (req, res) => {
    try {
        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body);

        const subRow = await getActiveSubRowForUser(userId);
        if (!subRow?.stripe_subscription_id) {
            return res.status(404).json({ error: 'No active subscription' });
        }

        // Retrieve subscription (expand latest invoice & payment intent on update)
        const current = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id);

        const updated = await stripe.subscriptions.update(current.id, {
            cancel_at_period_end: false,
            billing_cycle_anchor: 'now',
            proration_behavior: 'none',
            expand: ['latest_invoice.payment_intent', 'latest_invoice.charge'],
        });

        // Persist subscription locally
        await upsertSubscription(userId, updated);

        // Try to reset credits immediately if the new invoice is already paid
        let invoiceStatus = null;
        let paymentIntentStatus = null;
        let clientSecret = null;

        if (updated.latest_invoice) {
            const inv = typeof updated.latest_invoice === 'string'
                ? await stripe.invoices.retrieve(updated.latest_invoice, { expand: ['payment_intent'] })
                : updated.latest_invoice;

            invoiceStatus = inv.status;
            paymentIntentStatus = inv.payment_intent?.status || null;

            if (paymentIntentStatus === 'requires_action' || paymentIntentStatus === 'requires_payment_method') {
                clientSecret = inv.payment_intent?.client_secret || null;
            }

            if (invoiceStatus === 'paid') {
                await supabaseAdmin.rpc('reset_monthly_credits', {
                    p_user_id: userId,
                    p_start: toIso(updated.current_period_start),
                    p_end: toIso(updated.current_period_end),
                    p_total: 25,
                });
            }
        }

        return res.json({
            ok: true,
            subscription_status: updated.status,
            invoice_status: invoiceStatus,
            payment_intent_status: paymentIntentStatus,
            client_secret: clientSecret
        });
    } catch (e) {
        console.error('[stripe] /renew-now error', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

module.exports = router;