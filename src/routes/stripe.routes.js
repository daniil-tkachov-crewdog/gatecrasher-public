// server/routes/stripe.routes.js - Handles Stripe checkout sessions, billing portal, webhooks, and subscription management.
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
// New plan price IDs (current product catalog)
const PRICE_PLATINUM = must('STRIPE_PRICE_PLATINUM');
const PRICE_SILVER = must('STRIPE_PRICE_SILVER');
const PRICE_GOLD = must('STRIPE_PRICE_GOLD');
const PRICE_BUSINESS = must('STRIPE_PRICE_BUSINESS');
const PRICE_RETENTION = must('STRIPE_PRICE_RETENTION');

// Map plan code (from frontend) -> Stripe price id
const PLAN_TO_PRICE = {
    platinum: PRICE_PLATINUM,
    silver: PRICE_SILVER,
    gold: PRICE_GOLD,
    business: PRICE_BUSINESS,
};

console.log("💰 Loaded price IDs:", {
    PRICE_PLATINUM,
    PRICE_SILVER,
    PRICE_GOLD,
    PRICE_BUSINESS,
    PRICE_RETENTION
});


// Legacy prices (archived in Stripe, kept for existing subs only)
const LEGACY_PRICE_PRO = process.env.STRIPE_PRICE_ID || null;        // old £5 Pro
const LEGACY_PRICE_DOWNSELL = process.env.STRIPE_PRICE_ID_2GBP || null; // old £2 downsell

const APP_BASE_URL = must('APP_BASE_URL');
const ADMIN_API_KEY = must('ADMIN_API_KEY');


// Single source of truth: price_id -> plan info
const PLAN_CONFIG = {
    [PRICE_PLATINUM]: { code: 'platinum', credits: 20 },
    [PRICE_SILVER]: { code: 'silver', credits: 60 },
    [PRICE_GOLD]: { code: 'gold', credits: 200 },
    [PRICE_BUSINESS]: { code: 'business', credits: 1000 },
    [PRICE_RETENTION]: { code: 'retention', credits: 10 }, 
};

// Legacy mappings so existing subs still get 25 credits
if (LEGACY_PRICE_PRO) {
    PLAN_CONFIG[LEGACY_PRICE_PRO] = { code: 'legacy_pro', credits: 25 };
}
if (LEGACY_PRICE_DOWNSELL) {
    PLAN_CONFIG[LEGACY_PRICE_DOWNSELL] = { code: 'legacy_downsell', credits: 25 };
}

/**
 * Lookup helper. If a price_id is unknown (e.g. truly weird legacy),
 * we fall back to 25 credits but log a warning.
 */
function getPlanForPriceId(priceId) {
    if (!priceId) return null;
    const plan = PLAN_CONFIG[priceId];
    if (!plan) {
        console.warn('[plans] Unknown price_id in subscription:', priceId, '→ falling back to 25 credits');
        return { code: 'unknown', credits: 25 };
    }
    return plan;
}


// NEW: separate webhook secrets with fallback to legacy var
const STRIPE_WEBHOOK_SECRET_LIVE =
    (process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const STRIPE_WEBHOOK_SECRET_TEST = (process.env.STRIPE_WEBHOOK_SECRET_TEST || '').trim();

if (!STRIPE_WEBHOOK_SECRET_LIVE) {
    throw new Error('Missing STRIPE_WEBHOOK_SECRET_LIVE (or STRIPE_WEBHOOK_SECRET)');
}

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
    return supabaseAdmin.from('app_subscriptions').upsert(
        {
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
        },
        { onConflict: 'stripe_subscription_id' }
    );
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

async function isAdminUser(userId) {
    try {
        const { data, error } = await supabaseAdmin.rpc('is_admin', { p_user_id: userId });
        if (error) {
            console.warn('[isAdminUser] RPC error:', error);
            return false;
        }
        return data === true;
    } catch (e) {
        console.warn('[isAdminUser] RPC threw:', e?.message || e);
        return false;
    }
}

/* ----------------------------- NEW: Safe Stripe fetches ----------------------------- */
async function getSubscriptionSafe(subId) {
    try {
        return await stripe.subscriptions.retrieve(subId);
    } catch (e) {
        const msg = e?.raw?.message || '';
        if (e?.statusCode === 404 && /exists in test mode/i.test(msg)) {
            // stale TEST id saved in prod – log + allow caller to treat as null
            console.warn(`[stripe] stale TEST subscription id in live context: ${subId}`);
            // If you map subId -> user, you could also clear it here.
            return null;
        }
        throw e;
    }
}

/* ----------------------------- ROUTES: Checkout ----------------------------- */

/** POST /api/stripe/create-checkout-session */
router.post('/create-checkout-session', express.json(), async (req, res) => {
    try {

        console.log("🔥 Incoming checkout request:");
        console.log("req.body =", req.body);

        const Schema = z.object({
            userId: z.string().uuid(),
            email: z.string().email(),
            plan: z.enum(['platinum', 'silver', 'gold', 'business']).optional(),
        });

        const { userId, email, plan } = Schema.parse(req.body);

        console.log("🟡 Parsed checkout data:", { userId, email, plan });

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

        // 1) Re-use an OPEN Checkout Session if one exists (prevents duplicates)
        // const openSessions = await stripe.checkout.sessions.list({
        //     customer: customerId,
        //     status: 'open',
        //     limit: 1,
        //     expand: ['data.subscription'],
        // });
        // if (openSessions?.data?.[0]?.url) {
        //     return res.json({ url: openSessions.data[0].url });
        // }

        // console.log("🟢 Final chosen price:", {
        //     receivedPlan: plan,
        //     chosenPrice,
        //     mapping: PLAN_TO_PRICE,
        // });

        console.log("💰 Loaded price IDs:", {
            PRICE_PLATINUM,
            PRICE_SILVER,
            PRICE_GOLD,
            PRICE_BUSINESS,
            PRICE_RETENTION
        });

        // 2) Otherwise create a new session with a FRESH idempotency key
        // Use plan from frontend if provided, otherwise default to platinum
        const chosenPrice = PLAN_TO_PRICE[plan] || PRICE_PLATINUM;

        const idempotencyKey = `co_${userId}_${chosenPrice}_${Date.now()}`;
        const session = await stripe.checkout.sessions.create(
            {
                mode: 'subscription',
                customer: customerId,
                line_items: [{ price: chosenPrice, quantity: 1 }],
                allow_promotion_codes: true,
                success_url: `${APP_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${APP_BASE_URL}/account`,
                client_reference_id: userId,
                metadata: { user_id: userId, plan: plan || 'platinum' },
                payment_method_types: ['card', 'link'],
            },
            { idempotencyKey }
        );

        return res.json({ url: session.url });
    } catch (e) {
        console.error('[stripe] create-checkout-session error:', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});


/* ============================ Billing Portal ============================ */
/** POST /api/stripe/portal
 * Body: { userId: uuid, email: string }
 * Returns: { url }
 */
router.post('/portal', express.json(), async (req, res) => {
    try {
        const Schema = z.object({
            userId: z.string().uuid(),
            email: z.string().email(),
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
            return_url: `${APP_BASE_URL}/account`,
            ...(STRIPE_BILLING_PORTAL_CONFIGURATION_ID ? { configuration: STRIPE_BILLING_PORTAL_CONFIGURATION_ID } : {}),
        });

        return res.json({ url: session.url });
    } catch (e) {
        console.error('[stripe] portal error:', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/* ------------------------------ ROUTES: Webhook (LIVE) ------------------------------ */
/** POST /api/stripe/webhook
 * NOTE: raw body is already applied in server.js; we keep this here too for safety with your current setup.
 */
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing signature' });

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET_LIVE);
    } catch (err) {
        console.error('[stripe] LIVE webhook signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        // // ✅ Only trust/live-mutate on live events
        // if (event.livemode !== true) {
        //     console.warn('[stripe] LIVE endpoint received non-live event; ignoring:', event.type);
        //     return res.json({ received: true });
        // }

        console.log('[stripe] WH (LIVE) event:', event.type);

        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                if (session.mode !== 'subscription') break;
                const subId = session.subscription;
                const customerId = session.customer;
                const userId = await findUserIdByCustomerId(customerId);
                console.log('[stripe] WH checkout.session.completed -> userId:', userId, 'subId:', subId);
                if (!userId || !subId) break;

                const sub = await getSubscriptionSafe(subId);
                if (!sub) break; // stale TEST id; do nothing
                await upsertSubscription(userId, sub);
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                console.log(
                    '[stripe] WH invoice.payment_succeeded invoice_id:',
                    invoice.id,
                    'billing_reason:',
                    invoice.billing_reason
                );
                if (!invoice.subscription) break;

                const sub = await getSubscriptionSafe(invoice.subscription);
                if (!sub) break;
                const userId = await findUserIdByCustomerId(sub.customer);
                console.log('[stripe] WH payment_succeeded -> userId:', userId, 'subId:', sub.id);
                if (!userId) break;

                await upsertSubscription(userId, sub);

                // Admins are unlimited – no credit reset needed
                const admin = await isAdminUser(userId);
                if (admin) {
                    console.log('[stripe] invoice.payment_succeeded: user is admin, skipping credit reset');
                    break;
                }

                // Reset credits on subscription_create and normal cycle renewals
                if (
                    invoice.billing_reason === 'subscription_cycle' ||
                    invoice.billing_reason === 'subscription_create'
                ) {
                    const priceId = sub.items?.data?.[0]?.price?.id || null;
                    const plan = getPlanForPriceId(priceId);
                    const totalCredits = plan?.credits ?? 25;

                    const { error: rpcErr } = await supabaseAdmin.rpc('reset_monthly_credits', {
                        p_user_id: userId,
                        p_start: toIso(sub.current_period_start),
                        p_end: toIso(sub.current_period_end),
                        p_total: totalCredits,
                    });
                    console.log(
                        '[stripe] RPC reset_monthly_credits =>',
                        rpcErr || 'ok',
                        '| priceId=',
                        priceId,
                        '| plan=',
                        plan
                    );
                }
                break;
            }

            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const userId = await findUserIdByCustomerId(sub.customer);
                console.log('[stripe] WH sub upsert ->', event.type, 'userId:', userId, 'subId:', sub.id);
                if (!userId) break;
                await upsertSubscription(userId, sub);
                break;
            }

            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                console.log('[stripe] WH invoice.payment_failed invoice_id:', invoice.id);
                if (!invoice.subscription) break;

                const sub = await getSubscriptionSafe(invoice.subscription);
                if (!sub) break;
                const userId = await findUserIdByCustomerId(sub.customer);
                if (!userId) break;
                await upsertSubscription(userId, sub); // likely past_due
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const userId = await findUserIdByCustomerId(sub.customer);
                console.log('[stripe] WH sub deleted -> userId:', userId, 'subId:', sub.id);
                if (!userId) break;
                await supabaseAdmin
                    .from('app_subscriptions')
                    .update({
                        status: 'canceled',
                        cancel_at_period_end: false,
                        current_period_end: new Date().toISOString(),
                    })
                    .eq('stripe_subscription_id', sub.id);
                break;
            }

            default:
                // No-op for other events
                break;
        }

        return res.json({ received: true });
    } catch (e) {
        console.error('[stripe] webhook (LIVE) error', e);
        // If your processing is idempotent and logged, you may still return 200 to avoid infinite retries.
        return res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/* ------------------------------ NEW: Webhook (TEST) ------------------------------ */
/** POST /api/stripe/webhook-test
 * We verify with the TEST secret and DO NOT mutate prod DB.
 */
router.post('/webhook-test', express.raw({ type: '*/*' }), async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET_TEST) {
        // If you didn't configure a test secret yet, let the caller know.
        console.warn('[stripe] TEST webhook received but STRIPE_WEBHOOK_SECRET_TEST is not set');
        return res.status(400).send('Test webhook not configured');
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing signature' });

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET_TEST);
    } catch (err) {
        console.error('[stripe] TEST webhook signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        console.log('[stripe] WH (TEST) event:', event.type);
        // Intentionally do nothing that touches prod DB.
        return res.status(200).send('[ok]');
    } catch (e) {
        console.error('[stripe] webhook (TEST) error', e);
        return res.status(200).send('[logged]');
    }
});

/* ------------------------------ Admin cancel API ------------------------------ */
/** POST /api/stripe/admin/cancel */
router.post('/admin/cancel', express.json(), async (req, res) => {
    try {
        if (req.headers['x-admin-key'] !== ADMIN_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const Schema = z
            .object({
                userId: z.string().uuid().optional(),
                stripeSubscriptionId: z.string().optional(),
            })
            .refine(v => v.userId || v.stripeSubscriptionId, { message: 'Provide userId or stripeSubscriptionId' });

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

/* ========================== Customer cancel flow ========================== */
/** POST /api/stripe/cancel/feedback
 * Body: { userId: uuid, reason: string, otherText?: string }
 */
router.post('/cancel/feedback', express.json(), async (req, res) => {
    try {
        const Schema = z.object({
            userId: z.string().uuid(),
            reason: z.string().min(1),
            otherText: z.string().optional(),
        });
        const { userId, reason, otherText } = Schema.parse(req.body);

        const subRow = await getActiveSubRowForUser(userId);
        if (!subRow?.stripe_subscription_id) {
            return res.status(404).json({ error: 'No active subscription' });
        }

        const { error } = await supabaseAdmin.from('app_cancellation_feedback').insert({
            user_id: userId,
            subscription_id: subRow.stripe_subscription_id,
            reason,
            other_text: otherText || null,
            downgraded: false,
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
        if (!PRICE_RETENTION) {
            return res.status(500).json({ error: 'Retention price not configured. Set STRIPE_PRICE_RETENTION.' });
        }

        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body);

        const subRow = await getActiveSubRowForUser(userId);
        if (!subRow?.stripe_subscription_id) {
            return res.status(404).json({ error: 'No active subscription' });
        }

        // Retrieve subscription to get item id + current price
        const sub = await getSubscriptionSafe(subRow.stripe_subscription_id);
        if (!sub) {
            return res.status(400).json({ error: 'Subscription not found (stale test id in live?)' });
        }

        const subItem = sub.items?.data?.[0];
        if (!subItem?.id) throw new Error('Subscription item not found');

        // 🔹 NEW: Only allow downgrade if current plan is PLATINUM
        const currentPriceId = subItem.price?.id || null;
        const currentPlan = getPlanForPriceId(currentPriceId);
        if (!currentPlan || currentPlan.code !== 'platinum') {
            // Only platinum users can access the retention downgrade
            return res.status(400).json({ error: 'Downgrade is only available for Platinum plan users.' });
        }

        const updated = await stripe.subscriptions.update(sub.id, {
            items: [{ id: subItem.id, price: PRICE_RETENTION, quantity: 1 }],
            proration_behavior: 'none', // don't bill/credit mid-cycle
        });

        // Refresh local state
        await upsertSubscription(userId, updated);

        // Insert a marker feedback row indicating the user accepted the downsell
        await supabaseAdmin.from('app_cancellation_feedback').insert({
            user_id: userId,
            subscription_id: updated.id,
            reason: 'downgraded_offer_accepted',
            other_text: null,
            downgraded: true,
        });

        // NOTE: we DO NOT reset credits here. They will be reset on the next
        // invoice.payment_succeeded webhook based on the new retention price,
        // which means: user keeps platinum credits until the end of current period.
        return res.json({ ok: true, status: updated.status, price_id: PRICE_RETENTION });
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

        const current = await getSubscriptionSafe(subRow.stripe_subscription_id);
        if (!current) {
            return res.status(400).json({ error: 'Subscription not found (stale test id in live?)' });
        }

        const canceled = await stripe.subscriptions.update(current.id, {
            cancel_at_period_end: true,
        });

        await upsertSubscription(userId, canceled);

        return res.json({ ok: true, status: canceled.status, cancel_at_period_end: canceled.cancel_at_period_end });
    } catch (e) {
        console.error('[stripe] /cancel error', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/* ============================ Renew-now API ============================ */
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
        const current = await getSubscriptionSafe(subRow.stripe_subscription_id);
        if (!current) {
            return res.status(400).json({ error: 'Subscription not found (stale test id in live?)' });
        }

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
            const inv =
                typeof updated.latest_invoice === 'string'
                    ? await stripe.invoices.retrieve(updated.latest_invoice, { expand: ['payment_intent'] })
                    : updated.latest_invoice;

            invoiceStatus = inv.status;
            paymentIntentStatus = inv.payment_intent?.status || null;

            if (paymentIntentStatus === 'requires_action' || paymentIntentStatus === 'requires_payment_method') {
                clientSecret = inv.payment_intent?.client_secret || null;
            }

            if (invoiceStatus === 'paid') {
                const admin = await isAdminUser(userId);
                if (admin) {
                    console.log('[stripe] renew-now: user is admin, skipping credit reset');
                } else {
                    const priceId = updated.items?.data?.[0]?.price?.id || null;
                    const plan = getPlanForPriceId(priceId);
                    const totalCredits = plan?.credits ?? 25;

                    const { error: rpcErr } = await supabaseAdmin.rpc('reset_monthly_credits', {
                        p_user_id: userId,
                        p_start: toIso(updated.current_period_start),
                        p_end: toIso(updated.current_period_end),
                        p_total: totalCredits,
                    });
                    console.log(
                        '[stripe] renew-now RPC reset_monthly_credits =>',
                        rpcErr || 'ok',
                        '| priceId=',
                        priceId,
                        '| plan=',
                        plan
                    );
                }
            }

        }

        return res.json({
            ok: true,
            subscription_status: updated.status,
            invoice_status: invoiceStatus,
            payment_intent_status: paymentIntentStatus,
            client_secret: clientSecret,
        });
    } catch (e) {
        console.error('[stripe] /renew-now error', e);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

module.exports = router;
