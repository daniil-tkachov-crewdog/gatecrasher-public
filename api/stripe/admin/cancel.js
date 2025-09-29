const { z } = require('zod');
const { stripe } = require('../../../lib/stripe');
const { supabaseAdmin } = require('../../../lib/supabaseAdmin');

module.exports = async (req, res) => {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }

    try {
        if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const Schema = z.object({
            userId: z.string().uuid().optional(),
            stripeSubscriptionId: z.string().optional(),
        }).refine(v => v.userId || v.stripeSubscriptionId, { message: 'Provide userId or stripeSubscriptionId' });

        const body = Schema.parse(req.body || {});
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
};
