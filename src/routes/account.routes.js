const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseAdmin');
// Assumes you have a Stripe client export like: module.exports = { stripe }
const { stripe } = require('../lib/stripe');

/**
 * GET /api/account/summary/:userId
 * Returns plan status, remaining credits, renewal date, price, and cancel flag.
 */
router.get('/summary/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        console.log(`[account.summary] Fetching summary for userId: ${userId}`);

        // Latest subscription (optional)
        const { data: subs, error: subErr } = await supabaseAdmin
            .from('app_subscriptions')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false })
            .limit(1);

        if (subErr) throw subErr;

        // Quota
        const { data: quota, error: quotaErr } = await supabaseAdmin
            .from('app_quotas')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (quotaErr) throw quotaErr;

        const sub = subs?.[0] || null;

        // Compute remaining credits (server truth)
        const remaining = quota ? Math.max(0, (quota.total_credits || 0) - (quota.used_credits || 0)) : 0;

        // Enrich summary with price + cancel flag where possible
        let price = null; // { amount, currency, interval }
        let cancelAtPeriodEnd = !!sub?.cancel_at_period_end;
        let renewalDate = sub?.current_period_end || null;

        try {
            // Prefer live Stripe subscription (most authoritative)
            if (stripe && sub?.stripe_subscription_id) {
                const s = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
                    expand: ['items.data.price'],
                });

                cancelAtPeriodEnd = !!s?.cancel_at_period_end;
                renewalDate = s?.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : renewalDate;

                const pr = s?.items?.data?.[0]?.price;
                if (pr) {
                    price = {
                        amount: pr.unit_amount || 0, // minor units; e.g. 200 = £2.00
                        currency: (pr.currency || 'gbp').toLowerCase(),
                        interval: pr.recurring?.interval || null,
                    };
                }
            }

            // Fallback: fetch price via stored price id (if present)
            if (!price && stripe && (sub?.price_id || sub?.stripe_price_id)) {
                const pr = await stripe.prices.retrieve(sub.price_id || sub.stripe_price_id);
                price = {
                    amount: pr.unit_amount || 0,
                    currency: (pr.currency || 'gbp').toLowerCase(),
                    interval: pr.recurring?.interval || null,
                };
            }
        } catch (e) {
            // Non-fatal: still return summary without price if Stripe is unavailable
            console.warn('[account.summary] Price/Stripe lookup failed:', e?.message || e);
        }

        const response = {
            status: sub?.status || 'none',
            renewalDate,
            creditsRemaining: remaining,
            freeTryUsed: !!quota?.has_claimed_free_try,
            cancelAtPeriodEnd,
            price, // { amount (minor units), currency, interval } or null
        };

        console.log('[account.summary] Response:', response);
        res.json(response);
    } catch (e) {
        console.error('[account.summary] Error:', e);
        res.status(500).json({ error: e.message || 'Failed to load summary' });
    }
});

/**
 * POST /api/account/consume
 * Body: { userId }
 * Decrements credits by 1 (server truth). Never goes below zero.
 * Returns: { remaining }
 */
router.post('/consume', async (req, res) => {
    try {
        const { userId } = req.body || {};
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        // Try RPC first (atomic decrement in DB)
        let rpcTried = false;
        let rpcData = null, rpcErr = null;
        try {
            rpcTried = true;
            const resRpc = await supabaseAdmin.rpc('app_consume_credit', { p_user_id: userId });
            rpcData = resRpc.data; rpcErr = resRpc.error;
        } catch (e) {
            rpcErr = e;
        }

        if (rpcTried && !rpcErr && Array.isArray(rpcData)) {
            if (rpcData.length === 0) {
                return res.status(409).json({ error: 'No credits remaining', remaining: 0 });
            }
            const { total_credits, used_credits } = rpcData[0] || {};
            return res.json({ remaining: Math.max(0, (total_credits || 0) - (used_credits || 0)) });
        }

        // ---------- Fallback (non-RPC, small race risk) ----------
        const { data: quota, error: qErr } = await supabaseAdmin
            .from('app_quotas')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();
        if (qErr) throw qErr;

        if (!quota) {
            // If quota row is missing, create a default one (Free by default)
            const DEFAULT_CAP = 1;
            const { data: inserted, error: insErr } = await supabaseAdmin
                .from('app_quotas')
                .insert({ user_id: userId, total_credits: DEFAULT_CAP, used_credits: 1 })
                .select()
                .maybeSingle();
            if (insErr) throw insErr;
            const remaining = Math.max(0, (inserted.total_credits || 0) - (inserted.used_credits || 0));
            return res.json({ remaining });
        }

        const total = quota.total_credits || 0;
        const used = quota.used_credits || 0;
        if (used >= total) {
            return res.status(409).json({ error: 'No credits remaining', remaining: 0 });
        }

        const { data: updated, error: upErr } = await supabaseAdmin
            .from('app_quotas')
            .update({ used_credits: used + 1, updated_at: new Date().toISOString() })
            .eq('user_id', userId)
            .select()
            .maybeSingle();
        if (upErr) throw upErr;

        const remaining = Math.max(0, (updated.total_credits || 0) - (updated.used_credits || 0));
        return res.json({ remaining });
    } catch (e) {
        console.error('[account.consume] Error:', e);
        res.status(500).json({ error: e.message || 'Failed to consume credit' });
    }
});

module.exports = router;
