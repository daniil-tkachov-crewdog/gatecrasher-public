// routes/account.js (drop-in replacement)
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const { stripe } = require('../lib/stripe');

// Map Stripe price_id -> credits (must match stripe.routes.js)
const PLAN_CONFIG = {
    [process.env.STRIPE_PRICE_PLATINUM]: { code: 'platinum', credits: 20 },
    [process.env.STRIPE_PRICE_SILVER]: { code: 'silver', credits: 60 },
    [process.env.STRIPE_PRICE_GOLD]: { code: 'gold', credits: 200 },
    [process.env.STRIPE_PRICE_BUSINESS]: { code: 'business', credits: 1000 },
    [process.env.STRIPE_PRICE_RETENTION]: { code: 'retention', credits: 10 },
};

// Optional: legacy support for old archived prices (25 credits)
if (process.env.STRIPE_PRICE_ID) {
    PLAN_CONFIG[process.env.STRIPE_PRICE_ID] = { code: 'legacy_pro', credits: 25 };
}
if (process.env.STRIPE_PRICE_ID_2GBP) {
    PLAN_CONFIG[process.env.STRIPE_PRICE_ID_2GBP] = { code: 'legacy_downsell', credits: 25 };
}

function getPlanForPriceId(priceId) {
    if (!priceId) return null;
    const plan = PLAN_CONFIG[priceId];
    if (!plan) {
        console.warn('[account] Unknown price_id in app_subscriptions:', priceId, '→ falling back to 25 credits');
        return { code: 'unknown', credits: 25 };
    }
    return plan;
}


/** small helper */
async function ensureUserAndQuota(userId, email, defaultCap = 3) {
    try {
        // email is optional; function tolerates null
        const { error } = await supabaseAdmin.rpc('ensure_user_and_quota', {
            uid: userId,
            uemail: email || null,
            default_cap: defaultCap,
        });
        if (error) {
            console.warn('[ensure_user_and_quota] RPC error:', error);
        }
    } catch (e) {
        console.warn('[ensure_user_and_quota] RPC threw:', e?.message || e);
    }
}

/**
 * GET /api/account/summary/:userId
 * Returns plan status, remaining credits, renewal date, price, and cancel flag.
 */
router.get('/summary/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        if (!userId) return res.status(400).json({ error: 'Missing userId' });
        console.log(`[account.summary] Fetching summary for userId: ${userId}`);

        // If you can attach email from your auth middleware, pass it; otherwise null
        const email = (req.user && req.user.email) || req.query.email || null;

        // ❌ REMOVED:
        // await ensureUserAndQuota(userId, email, 3);

        // --- Admin check
        let isAdmin = false;
        try {
            const { data: isAdminData, error: isAdminErr } = await supabaseAdmin.rpc('is_admin', { p_user_id: userId });
            if (!isAdminErr && isAdminData === true) isAdmin = true;
        } catch (e) {
            console.warn('[account.summary] is_admin RPC failed:', e?.message || e);
        }

        // Latest subscription (optional)
        const { data: subs, error: subErr } = await supabaseAdmin
            .from('app_subscriptions')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false })
            .limit(1);

        if (subErr) throw subErr;
        const sub = subs?.[0] || null;

        // Quota: first attempt
        let { data: quota, error: quotaErr } = await supabaseAdmin
            .from('app_quotas')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (quotaErr) throw quotaErr;

        // ✅ Only create / normalise quota if it doesn't exist yet
        if (!quota) {
            await ensureUserAndQuota(userId, email, 3);
            const { data: quota2, error: quotaErr2 } = await supabaseAdmin
                .from('app_quotas')
                .select('*')
                .eq('user_id', userId)
                .maybeSingle();
            if (quotaErr2) throw quotaErr2;
            quota = quota2 || null;
        }

        // Compute remaining credits (server truth)
        let remaining = quota ? Math.max(0, (quota.total_credits || 0) - (quota.used_credits || 0)) : 3;

        // Enrich with Stripe price + cancel flag when possible
        let price = null; // { amount, currency, interval }
        let cancelAtPeriodEnd = !!sub?.cancel_at_period_end;
        let renewalDate = sub?.current_period_end || quota?.period_end || null;

        try {
            if (stripe && sub?.stripe_subscription_id) {
                const s = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
                    expand: ['items.data.price'],
                });
                cancelAtPeriodEnd = !!s?.cancel_at_period_end;
                renewalDate = s?.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : renewalDate;

                const pr = s?.items?.data?.[0]?.price;
                if (pr) {
                    price = {
                        amount: pr.unit_amount || 0,
                        currency: (pr.currency || 'usd').toLowerCase(),
                        interval: pr.recurring?.interval || null,
                    };
                }
            }

            if (!price && stripe && (sub?.price_id || sub?.stripe_price_id)) {
                const pr = await stripe.prices.retrieve(sub.price_id || sub.stripe_price_id);
                price = {
                    amount: pr.unit_amount || 0,
                    currency: (pr.currency || 'usd').toLowerCase(),
                    interval: pr.recurring?.interval || null,
                };
            }
        } catch (e) {
            console.warn('[account.summary] Price/Stripe lookup failed:', e?.message || e);
        }

        // Admin: unlimited on server truth too (remaining = null)
        if (isAdmin) {
            remaining = null;
        }

        const response = {
            status: sub?.status || 'none',
            renewalDate: renewalDate ? new Date(renewalDate).toISOString() : null,
            creditsRemaining: remaining,
            freeTryUsed: !!quota?.has_claimed_free_try,
            cancelAtPeriodEnd,
            price,
            unlimited: isAdmin,
            isAdmin,
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
 * Returns: { remaining, unlimited? }
 */
router.post('/consume', async (req, res) => {
    try {
        const { userId } = req.body || {};
        if (!userId) return res.status(400).json({ error: 'Missing userId' });

        // If you can attach email from auth middleware, pass it; else null
        const email = (req.user && req.user.email) || req.query?.email || null;

        // --- NEW: ensure app_users + app_quotas row exist BEFORE any write
        await ensureUserAndQuota(userId, email, 3);

        // Admin short-circuit: unlimited (do not decrement)
        try {
            const { data: isAdmin, error: adminErr } = await supabaseAdmin.rpc('is_admin', { p_user_id: userId });
            if (!adminErr && isAdmin === true) {
                return res.json({ remaining: null, unlimited: true });
            }
        } catch (e) {
            console.warn('[account.consume] is_admin RPC failed:', e?.message || e);
            // fall through
        }

        // 1) Try atomic decrement RPC (now safe since rows exist)
        try {
            const { data: rpcRows, error: rpcErr } = await supabaseAdmin.rpc('app_consume_credit', { p_user_id: userId });
            if (!rpcErr) {
                if (Array.isArray(rpcRows) && rpcRows.length) {
                    const { total_credits, used_credits } = rpcRows[0] || {};
                    return res.json({
                        remaining: Math.max(0, (total_credits || 0) - (used_credits || 0)),
                    });
                }
                // RPC returns empty when no credits
                return res.status(409).json({ error: 'No credits remaining', remaining: 0 });
            }
            console.warn('[account.consume] app_consume_credit RPC error:', rpcErr);
        } catch (e) {
            console.warn('[account.consume] app_consume_credit RPC threw:', e?.message || e);
        }

        // 2) Fallback path (non-atomic): read → adjust cap → bump used
        const { data: quota, error: qErr } = await supabaseAdmin
            .from('app_quotas')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();
        if (qErr) throw qErr;

        // Should exist after ensureUserAndQuota; still guard just in case
        if (!quota) {
            const DEFAULT_CAP = 3;
            const { data: inserted, error: insErr } = await supabaseAdmin
                .from('app_quotas')
                .insert({ user_id: userId, total_credits: DEFAULT_CAP, used_credits: 1 })
                .select()
                .maybeSingle();
            if (insErr) throw insErr;
            const remaining = Math.max(0, (inserted.total_credits || 0) - (inserted.used_credits || 0));
            return res.json({ remaining });
        }

        // 🔹 NEW: only "self-heal" total_credits when the current period has ended.
        // This ensures mid-cycle downgrades (e.g. platinum → retention) do NOT
        // immediately chop their cap from 20 → 10. The user keeps the higher cap
        // until quota.period_end, then next cycle uses the lower cap.
        const nowIso = new Date().toISOString();
        const periodEnd = quota.period_end || null;
        const periodExpired = !periodEnd || periodEnd <= nowIso;

        let total = quota.total_credits || 0;
        let used = quota.used_credits || 0;

        if (periodExpired) {
            // Self-heal cap based on subscription status ONLY when period is over
            const { data: subRow } = await supabaseAdmin
                .from('app_subscriptions')
                .select('status, price_id')
                .eq('user_id', userId)
                .in('status', ['active', 'trialing', 'past_due', 'unpaid'])
                .maybeSingle();

            let desiredCap = 3; // default: free tier

            if (subRow) {
                const priceId = subRow.price_id || null;
                const plan = getPlanForPriceId(priceId);
                desiredCap = plan?.credits ?? 25; // e.g. 20/60/200/1000 or legacy 25
            }

            if (total !== desiredCap) {
                const { data: fixed, error: fixErr } = await supabaseAdmin
                    .from('app_quotas')
                    .update({ total_credits: desiredCap, updated_at: new Date().toISOString() })
                    .eq('user_id', userId)
                    .select()
                    .maybeSingle();
                if (!fixErr && fixed) {
                    total = fixed.total_credits || desiredCap;
                    used = fixed.used_credits || used;
                } else {
                    total = desiredCap; // fallback
                }
            } else {
                total = desiredCap;
            }
        } else {
            // Period still active → keep existing total_credits as-is
            total = quota.total_credits || 0;
            used = quota.used_credits || 0;
        }

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
