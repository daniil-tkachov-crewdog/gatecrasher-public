const { stripe } = require('../../lib/stripe');
const { supabaseAdmin } = require('../../lib/supabaseAdmin');

function must(name) {
    const v = (process.env[name] || '').trim();
    if (!v) throw new Error(`Missing env ${name}`);
    return v;
}
const STRIPE_WEBHOOK_SECRET = must('STRIPE_WEBHOOK_SECRET');

function toIso(ts) { return ts ? new Date(ts * 1000).toISOString() : null; }
async function findUserIdByCustomerId(customerId) {
    const { data: row, error } = await supabaseAdmin
        .from('app_users').select('user_id').eq('stripe_customer_id', customerId).maybeSingle();
    if (error) throw error;
    return row?.user_id || null;
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

async function readRaw(req) {
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).send('Method Not Allowed');
    }
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).send('Missing stripe-signature');

    try {
        const raw = await readRaw(req);
        const event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);

        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                if (session.mode !== 'subscription') break;
                const sub = await stripe.subscriptions.retrieve(session.subscription);
                const userId = await findUserIdByCustomerId(sub.customer);
                if (userId) await upsertSubscription(userId, sub);
                break;
            }
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                if (!invoice.subscription) break;
                const sub = await stripe.subscriptions.retrieve(invoice.subscription);
                const userId = await findUserIdByCustomerId(sub.customer);
                if (userId) {
                    await upsertSubscription(userId, sub);
                    if (['subscription_cycle', 'subscription_create'].includes(invoice.billing_reason)) {
                        await supabaseAdmin.rpc('reset_monthly_credits', {
                            p_user_id: userId,
                            p_start: toIso(sub.current_period_start),
                            p_end: toIso(sub.current_period_end),
                            p_total: 25,
                        });
                    }
                }
                break;
            }
            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const sub = event.data.object;
                const userId = await findUserIdByCustomerId(sub.customer);
                if (userId) await upsertSubscription(userId, sub);
                break;
            }
            case 'invoice.payment_failed':
            case 'customer.subscription.deleted': {
                const subLike = event.data.object;
                const sub = subLike.id ? subLike : (await stripe.subscriptions.retrieve(subLike.subscription));
                const userId = await findUserIdByCustomerId(sub.customer);
                if (userId) await upsertSubscription(userId, sub);
                break;
            }
            default: break;
        }

        return res.status(200).json({ received: true });
    } catch (e) {
        console.error('webhook error:', e);
        return res.status(400).send(`Webhook Error: ${e.message}`);
    }
};
