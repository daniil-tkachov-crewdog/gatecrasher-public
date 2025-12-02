/**
 * Stripe Routes - Payment integration, subscriptions, and webhooks
 */
const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { stripe } = require('../lib/stripe');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

function must(name) {
    const value = process.env[name];
    if (!value || value.trim() === '') {
        throw new Error(`Missing environment variable: ${name}`);
    }
    return value.trim();
}

const PRICE_PLATINUM = must('STRIPE_PRICE_PLATINUM');
const PRICE_SILVER = must('STRIPE_PRICE_SILVER');
const PRICE_GOLD = must('STRIPE_PRICE_GOLD');
const PRICE_BUSINESS = must('STRIPE_PRICE_BUSINESS');
const PRICE_RETENTION = must('STRIPE_PRICE_RETENTION');

const PLAN_TO_PRICE = {
    platinum: PRICE_PLATINUM,
    silver: PRICE_SILVER,
    gold: PRICE_GOLD,
    business: PRICE_BUSINESS,
};

const LEGACY_PRICE_PRO = process.env.STRIPE_PRICE_ID || null;
const LEGACY_PRICE_DOWNSELL = process.env.STRIPE_PRICE_ID_2GBP || null;

const APP_BASE_URL = must('APP_BASE_URL');
const ADMIN_API_KEY = must('ADMIN_API_KEY');

const PLAN_CONFIG = {
    [PRICE_PLATINUM]: { code: 'platinum', credits: 20 },
    [PRICE_SILVER]: { code: 'silver', credits: 60 },
    [PRICE_GOLD]: { code: 'gold', credits: 200 },
    [PRICE_BUSINESS]: { code: 'business', credits: 1000 },
    [PRICE_RETENTION]: { code: 'retention', credits: 10 },
};

if (LEGACY_PRICE_PRO) {
    PLAN_CONFIG[LEGACY_PRICE_PRO] = { code: 'legacy_pro', credits: 25 };
}
if (LEGACY_PRICE_DOWNSELL) {
    PLAN_CONFIG[LEGACY_PRICE_DOWNSELL] = { code: 'legacy_downsell', credits: 25 };
}

function getPlanForPriceId(priceId) {
    if (!priceId) return null;
    const plan = PLAN_CONFIG[priceId];
    if (!plan) {
        console.error('[getPlanForPriceId] Unknown price_id:', priceId);
        return { code: 'unknown', credits: 25 };
    }
    return plan;
}

const STRIPE_WEBHOOK_SECRET_LIVE =
    (process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const STRIPE_WEBHOOK_SECRET_TEST = (process.env.STRIPE_WEBHOOK_SECRET_TEST || '').trim();

if (!STRIPE_WEBHOOK_SECRET_LIVE) {
    throw new Error('Missing STRIPE_WEBHOOK_SECRET_LIVE');
}

const STRIPE_BILLING_PORTAL_CONFIGURATION_ID =
    process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID || null;

async function getOrCreateCustomerByEmail(email, userId) {
    if (!email || !email.includes('@')) {
        throw new Error(`Invalid email: ${email}`);
    }
    if (!userId) {
        throw new Error(`Invalid userId: ${userId}`);
    }

    const found = await stripe.customers.search({ query: `email:"${email}"` });
    const existing = found.data?.[0];

    if (existing) {
        if (!existing.metadata?.user_id) {
            await stripe.customers.update(existing.id, {
                metadata: { user_id: userId }
            });
        }
        return existing.id;
    }

    const created = await stripe.customers.create({
        email,
        metadata: { user_id: userId }
    });

    return created.id;
}

async function findUserIdByCustomerId(customerId) {
    if (!customerId) return null;

    const { data: row, error } = await supabaseAdmin
        .from('app_users')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();

    if (error) {
        console.error('[findUserIdByCustomerId] Error:', error.message);
        throw error;
    }

    return row?.user_id || null;
}

function toIso(ts) {
    if (!ts) return null;
    try {
        return new Date(ts * 1000).toISOString();
    } catch (error) {
        return null;
    }
}

async function upsertSubscription(userId, sub) {
    if (!userId || !sub || !sub.id) {
        throw new Error('Invalid parameters for upsertSubscription');
    }

    const result = await supabaseAdmin.from('app_subscriptions').upsert(
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

    if (result.error) {
        console.error('[upsertSubscription] Error:', result.error.message);
        throw result.error;
    }

    return result;
}

async function getActiveSubRowForUser(userId) {
    if (!userId) return null;

    const { data: row, error } = await supabaseAdmin
        .from('app_subscriptions')
        .select('stripe_subscription_id, status')
        .eq('user_id', userId)
        .in('status', ['active', 'trialing', 'past_due', 'unpaid'])
        .order('current_period_end', { ascending: false })
        .maybeSingle();

    if (error) {
        console.error('[getActiveSubRowForUser] Error:', error.message);
        throw error;
    }

    return row || null;
}

async function isAdminUser(userId) {
    try {
        if (!userId) return false;

        const { data, error } = await supabaseAdmin.rpc('is_admin', { p_user_id: userId });

        if (error) {
            console.error('[isAdminUser] Error:', error.message);
            return false;
        }

        return data === true;
    } catch (e) {
        console.error('[isAdminUser] Exception:', e?.message);
        return false;
    }
}

async function getSubscriptionSafe(subId) {
    if (!subId) return null;

    try {
        return await stripe.subscriptions.retrieve(subId);
    } catch (e) {
        const msg = e?.raw?.message || '';
        if (e?.statusCode === 404 && /exists in test mode/i.test(msg)) {
            console.error('[getSubscriptionSafe] Stale test subscription ID:', subId);
            return null;
        }
        throw e;
    }
}

/**
 * POST /api/stripe/create-checkout-session
 * Create checkout session for subscription purchase
 */
router.post('/create-checkout-session', express.json(), async (req, res) => {
    try {
        if (!req.body) {
            return res.status(400).json({
                error: 'Invalid request body'
            });
        }

        const Schema = z.object({
            userId: z.string().uuid('Invalid UUID'),
            email: z.string().email('Invalid email'),
            plan: z.enum(['platinum', 'silver', 'gold', 'business']).optional(),
        });

        let userId, email, plan;
        try {
            const parsed = Schema.parse(req.body);
            userId = parsed.userId;
            email = parsed.email;
            plan = parsed.plan;
        } catch (zodError) {
            return res.status(400).json({
                error: 'validation_failed',
                details: zodError.errors?.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                })) || []
            });
        }

        let { data: existing, error: selErr } = await supabaseAdmin
            .from('app_users')
            .select('user_id, email, stripe_customer_id')
            .eq('user_id', userId)
            .maybeSingle();

        if (selErr) {
            console.error('[create-checkout-session] User query failed:', selErr.message);
            throw selErr;
        }

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

        const chosenPrice = PLAN_TO_PRICE[plan] || PRICE_PLATINUM;
        const finalPlan = plan || 'platinum';

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
                metadata: { user_id: userId, plan: finalPlan },
                payment_method_types: ['card', 'link'],
            },
            { idempotencyKey }
        );

        if (!session || !session.url) {
            console.error('[create-checkout-session] No URL in session');
            return res.status(500).json({
                error: 'Failed to create checkout session'
            });
        }

        return res.json({ url: session.url });

    } catch (e) {
        console.error('[create-checkout-session] Error:', e?.message);
        return res.status(500).json({
            error: e?.message || 'An error occurred',
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * POST /api/stripe/portal
 * Create billing portal session
 */
router.post('/portal', express.json(), async (req, res) => {
    try {
        const Schema = z.object({
            userId: z.string().uuid(),
            email: z.string().email(),
        });

        const { userId, email } = Schema.parse(req.body);

        let { data: existing, error: selErr } = await supabaseAdmin
            .from('app_users')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .maybeSingle();

        if (selErr) {
            console.error('[portal] Query failed:', selErr.message);
            throw selErr;
        }

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
        console.error('[portal] Error:', e?.message);
        return res.status(500).json({
            error: e?.message || 'Failed to create portal session',
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * POST /api/stripe/webhook
 * Handle live Stripe webhook events
 */
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (!sig) {
        return res.status(400).json({ error: 'Missing signature' });
    }

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET_LIVE);
    } catch (err) {
        console.error('[webhook] Signature verification failed:', err.message);
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

                const sub = await getSubscriptionSafe(subId);
                if (!sub) break;
                await upsertSubscription(userId, sub);
                break;
            }

            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                if (!invoice.subscription) break;

                const sub = await getSubscriptionSafe(invoice.subscription);
                if (!sub) break;
                const userId = await findUserIdByCustomerId(sub.customer);
                if (!userId) break;

                await upsertSubscription(userId, sub);

                const admin = await isAdminUser(userId);
                if (admin) break;

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

                    if (rpcErr) {
                        console.error('[webhook] reset_monthly_credits error:', rpcErr.message);
                    }
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

                const sub = await getSubscriptionSafe(invoice.subscription);
                if (!sub) break;
                const userId = await findUserIdByCustomerId(sub.customer);
                if (!userId) break;
                await upsertSubscription(userId, sub);
                break;
            }

            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const userId = await findUserIdByCustomerId(sub.customer);
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
                break;
        }

        return res.json({ received: true });
    } catch (e) {
        console.error('[webhook] Processing error:', e?.message);
        return res.status(500).json({
            error: 'Webhook processing failed',
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * POST /api/stripe/webhook-test
 * Handle test Stripe webhook events
 */
router.post('/webhook-test', express.raw({ type: '*/*' }), async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET_TEST) {
        return res.status(400).send('Test webhook not configured');
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing signature' });

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET_TEST);
    } catch (err) {
        console.error('[webhook-test] Signature failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        return res.status(200).send('[ok]');
    } catch (e) {
        console.error('[webhook-test] Error:', e?.message);
        return res.status(200).send('[logged]');
    }
});

/**
 * POST /api/stripe/admin/cancel
 * Admin endpoint to cancel subscriptions
 */
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
            .refine(v => v.userId || v.stripeSubscriptionId, {
                message: 'Provide userId or stripeSubscriptionId'
            });

        const body = Schema.parse(req.body);
        let subId = body.stripeSubscriptionId;

        if (!subId && body.userId) {
            const { data: row } = await supabaseAdmin
                .from('app_subscriptions')
                .select('stripe_subscription_id, status')
                .eq('user_id', body.userId)
                .in('status', ['active', 'trialing', 'past_due'])
                .maybeSingle();
            if (!row?.stripe_subscription_id) {
                return res.status(404).json({ error: 'No active subscription' });
            }
            subId = row.stripe_subscription_id;
        }

        const canceled = await stripe.subscriptions.update(subId, {
            cancel_at_period_end: true
        });

        return res.json({
            ok: true,
            status: canceled.status,
            cancel_at_period_end: canceled.cancel_at_period_end
        });
    } catch (e) {
        console.error('[admin/cancel] Error:', e?.message);
        return res.status(400).json({ error: e.message });
    }
});

/**
 * POST /api/stripe/cancel/feedback
 * Submit cancellation feedback
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

        if (error) {
            console.error('[cancel/feedback] Insert error:', error.message);
            throw error;
        }

        return res.json({ ok: true });
    } catch (e) {
        console.error('[cancel/feedback] Error:', e?.message);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/**
 * POST /api/stripe/downgrade
 * Downgrade from Platinum to Retention plan
 */
router.post('/downgrade', express.json(), async (req, res) => {
    try {
        if (!PRICE_RETENTION) {
            return res.status(500).json({
                error: 'Retention price not configured'
            });
        }

        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body);

        const subRow = await getActiveSubRowForUser(userId);
        if (!subRow?.stripe_subscription_id) {
            return res.status(404).json({ error: 'No active subscription' });
        }

        const sub = await getSubscriptionSafe(subRow.stripe_subscription_id);
        if (!sub) {
            return res.status(400).json({
                error: 'Subscription not found'
            });
        }

        const subItem = sub.items?.data?.[0];
        if (!subItem?.id) {
            throw new Error('Subscription item not found');
        }

        const currentPriceId = subItem.price?.id || null;
        const currentPlan = getPlanForPriceId(currentPriceId);

        if (!currentPlan || currentPlan.code !== 'platinum') {
            return res.status(400).json({
                error: 'Downgrade is only available for Platinum users'
            });
        }

        const updated = await stripe.subscriptions.update(sub.id, {
            items: [{ id: subItem.id, price: PRICE_RETENTION, quantity: 1 }],
            proration_behavior: 'none',
        });

        await upsertSubscription(userId, updated);

        await supabaseAdmin.from('app_cancellation_feedback').insert({
            user_id: userId,
            subscription_id: updated.id,
            reason: 'downgraded_offer_accepted',
            other_text: null,
            downgraded: true,
        });

        return res.json({
            ok: true,
            status: updated.status,
            price_id: PRICE_RETENTION
        });
    } catch (e) {
        console.error('[downgrade] Error:', e?.message);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/**
 * POST /api/stripe/cancel
 * Cancel subscription at period end
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
            return res.status(400).json({
                error: 'Subscription not found'
            });
        }

        const canceled = await stripe.subscriptions.update(current.id, {
            cancel_at_period_end: true,
        });

        await upsertSubscription(userId, canceled);

        return res.json({
            ok: true,
            status: canceled.status,
            cancel_at_period_end: canceled.cancel_at_period_end
        });
    } catch (e) {
        console.error('[cancel] Error:', e?.message);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

/**
 * POST /api/stripe/renew-now
 * Force immediate subscription renewal
 */
router.post('/renew-now', express.json(), async (req, res) => {
    try {
        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body);

        const subRow = await getActiveSubRowForUser(userId);
        if (!subRow?.stripe_subscription_id) {
            return res.status(404).json({ error: 'No active subscription' });
        }

        const current = await getSubscriptionSafe(subRow.stripe_subscription_id);
        if (!current) {
            return res.status(400).json({
                error: 'Subscription not found'
            });
        }

        const updated = await stripe.subscriptions.update(current.id, {
            cancel_at_period_end: false,
            billing_cycle_anchor: 'now',
            proration_behavior: 'none',
            expand: ['latest_invoice.payment_intent', 'latest_invoice.charge'],
        });

        await upsertSubscription(userId, updated);

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
                if (!admin) {
                    const priceId = updated.items?.data?.[0]?.price?.id || null;
                    const plan = getPlanForPriceId(priceId);
                    const totalCredits = plan?.credits ?? 25;

                    const { error: rpcErr } = await supabaseAdmin.rpc('reset_monthly_credits', {
                        p_user_id: userId,
                        p_start: toIso(updated.current_period_start),
                        p_end: toIso(updated.current_period_end),
                        p_total: totalCredits,
                    });

                    if (rpcErr) {
                        console.error('[renew-now] reset_monthly_credits error:', rpcErr.message);
                    }
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
        console.error('[renew-now] Error:', e?.message);
        return res.status(400).json({ error: e.message || 'Bad request' });
    }
});

module.exports = router;
