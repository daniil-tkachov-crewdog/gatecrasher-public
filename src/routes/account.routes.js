/**
 * Account Routes - User account operations, quota management, and credit consumption
 */
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseAdmin');
const { stripe } = require('../lib/stripe');

const PLAN_CONFIG = {
    [process.env.STRIPE_PRICE_PLATINUM]: { code: 'platinum', credits: 20 },
    [process.env.STRIPE_PRICE_SILVER]: { code: 'silver', credits: 60 },
    [process.env.STRIPE_PRICE_GOLD]: { code: 'gold', credits: 200 },
    [process.env.STRIPE_PRICE_BUSINESS]: { code: 'business', credits: 1000 },
    [process.env.STRIPE_PRICE_RETENTION]: { code: 'retention', credits: 10 },
};

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
        console.error('[getPlanForPriceId] Unknown price_id:', priceId);
        return { code: 'unknown', credits: 25 };
    }
    return plan;
}

async function ensureUserAndQuota(userId, email, defaultCap = 3) {
    try {
        if (!userId) {
            console.error('[ensureUserAndQuota] Invalid userId');
            return false;
        }

        if (typeof defaultCap !== 'number' || defaultCap < 0) {
            defaultCap = 3;
        }

        const { error } = await supabaseAdmin.rpc('ensure_user_and_quota', {
            uid: userId,
            uemail: email || null,
            default_cap: defaultCap,
        });

        if (error) {
            console.error('[ensureUserAndQuota] RPC error:', error.code, error.message);
            return false;
        }

        return true;
    } catch (e) {
        console.error('[ensureUserAndQuota] Error:', e?.message);
        return false;
    }
}

/**
 * GET /api/account/summary/:userId
 * Returns plan status, remaining credits, renewal date, price, and cancel flag
 */
router.get('/summary/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;

        if (!userId) {
            return res.status(400).json({
                error: 'Missing userId',
                details: 'userId parameter is required'
            });
        }

        const email = (req.user && req.user.email) || req.query.email || null;

        let isAdmin = false;
        try {
            const { data: isAdminData, error: isAdminErr } = await supabaseAdmin.rpc('is_admin', {
                p_user_id: userId
            });
            if (!isAdminErr && isAdminData === true) isAdmin = true;
        } catch (e) {
            console.error('[account.summary] is_admin check failed:', e?.message);
        }

        const { data: subs, error: subErr } = await supabaseAdmin
            .from('app_subscriptions')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false })
            .limit(1);

        if (subErr) {
            console.error('[account.summary] Subscription query failed:', subErr.message);
            throw subErr;
        }

        const sub = subs?.[0] || null;

        let { data: quota, error: quotaErr } = await supabaseAdmin
            .from('app_quotas')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (quotaErr) {
            console.error('[account.summary] Quota query failed:', quotaErr.message);
            throw quotaErr;
        }

        if (!quota) {
            const success = await ensureUserAndQuota(userId, email, 3);
            if (!success) {
                return res.status(500).json({
                    error: 'Failed to initialize user account'
                });
            }

            const { data: quota2, error: quotaErr2 } = await supabaseAdmin
                .from('app_quotas')
                .select('*')
                .eq('user_id', userId)
                .maybeSingle();

            if (quotaErr2) {
                console.error('[account.summary] Quota retry failed:', quotaErr2.message);
                throw quotaErr2;
            }

            quota = quota2 || null;

            if (!quota) {
                return res.status(500).json({
                    error: 'Failed to initialize quota'
                });
            }
        }

        let remaining = quota ? Math.max(0, (quota.total_credits || 0) - (quota.used_credits || 0)) : 3;

        let price = null;
        let cancelAtPeriodEnd = !!sub?.cancel_at_period_end;
        let renewalDate = sub?.current_period_end || quota?.period_end || null;

        try {
            if (stripe && sub?.stripe_subscription_id) {
                const s = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, {
                    expand: ['items.data.price'],
                });

                if (s) {
                    cancelAtPeriodEnd = !!s?.cancel_at_period_end;
                    renewalDate = s?.current_period_end
                        ? new Date(s.current_period_end * 1000).toISOString()
                        : renewalDate;

                    const pr = s?.items?.data?.[0]?.price;
                    if (pr) {
                        price = {
                            amount: pr.unit_amount || 0,
                            currency: (pr.currency || 'usd').toLowerCase(),
                            interval: pr.recurring?.interval || null,
                        };
                    }
                }
            }

            if (!price && stripe && (sub?.price_id || sub?.stripe_price_id)) {
                const pr = await stripe.prices.retrieve(sub.price_id || sub.stripe_price_id);
                if (pr) {
                    price = {
                        amount: pr.unit_amount || 0,
                        currency: (pr.currency || 'usd').toLowerCase(),
                        interval: pr.recurring?.interval || null,
                    };
                }
            }
        } catch (e) {
            console.error('[account.summary] Stripe lookup error:', e?.message);
        }

        if (isAdmin) {
            remaining = null;
        }

        return res.json({
            status: sub?.status || 'none',
            renewalDate: renewalDate ? new Date(renewalDate).toISOString() : null,
            creditsRemaining: remaining,
            freeTryUsed: !!quota?.has_claimed_free_try,
            cancelAtPeriodEnd,
            price,
            unlimited: isAdmin,
            isAdmin,
        });

    } catch (e) {
        console.error('[account.summary] Error:', e?.message);
        return res.status(500).json({
            error: e.message || 'Failed to load summary',
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * POST /api/account/consume
 * Decrements credits by 1. Never goes below zero.
 */
router.post('/consume', async (req, res) => {
    try {
        const { userId } = req.body || {};

        if (!userId) {
            return res.status(400).json({
                error: 'Missing userId'
            });
        }

        const email = (req.user && req.user.email) || req.query?.email || null;

        await ensureUserAndQuota(userId, email, 3);

        try {
            const { data: isAdmin, error: adminErr } = await supabaseAdmin.rpc('is_admin', {
                p_user_id: userId
            });
            if (!adminErr && isAdmin === true) {
                return res.json({ remaining: null, unlimited: true });
            }
        } catch (e) {
            console.error('[account.consume] is_admin check failed:', e?.message);
        }

        try {
            const { data: rpcRows, error: rpcErr } = await supabaseAdmin.rpc('app_consume_credit', {
                p_user_id: userId
            });
            if (!rpcErr) {
                if (Array.isArray(rpcRows) && rpcRows.length) {
                    const { total_credits, used_credits } = rpcRows[0] || {};
                    return res.json({
                        remaining: Math.max(0, (total_credits || 0) - (used_credits || 0)),
                    });
                }
                return res.status(409).json({
                    error: 'No credits remaining',
                    remaining: 0
                });
            }
            console.error('[account.consume] RPC error:', rpcErr.message);
        } catch (e) {
            console.error('[account.consume] RPC exception:', e?.message);
        }

        const { data: quota, error: qErr } = await supabaseAdmin
            .from('app_quotas')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();

        if (qErr) {
            console.error('[account.consume] Quota query failed:', qErr.message);
            throw qErr;
        }

        if (!quota) {
            const DEFAULT_CAP = 3;
            const { data: inserted, error: insErr } = await supabaseAdmin
                .from('app_quotas')
                .insert({
                    user_id: userId,
                    total_credits: DEFAULT_CAP,
                    used_credits: 1,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .select()
                .maybeSingle();

            if (insErr) {
                console.error('[account.consume] Insert failed:', insErr.message);
                throw insErr;
            }

            if (!inserted) {
                throw new Error('Failed to create quota');
            }

            const remaining = Math.max(0, (inserted.total_credits || 0) - (inserted.used_credits || 0));
            return res.json({ remaining });
        }

        const nowIso = new Date().toISOString();
        const periodEnd = quota.period_end || null;
        const periodExpired = !periodEnd || periodEnd <= nowIso;

        let total = quota.total_credits || 0;
        let used = quota.used_credits || 0;

        if (periodExpired) {
            const { data: subRow, error: subRowErr } = await supabaseAdmin
                .from('app_subscriptions')
                .select('status, price_id')
                .eq('user_id', userId)
                .in('status', ['active', 'trialing', 'past_due', 'unpaid'])
                .maybeSingle();

            if (subRowErr) {
                console.error('[account.consume] Subscription query failed:', subRowErr.message);
            }

            let desiredCap = 3;

            if (subRow) {
                const priceId = subRow.price_id || null;
                const plan = getPlanForPriceId(priceId);
                desiredCap = plan?.credits ?? 25;
            }

            if (total !== desiredCap) {
                const { data: fixed, error: fixErr } = await supabaseAdmin
                    .from('app_quotas')
                    .update({
                        total_credits: desiredCap,
                        updated_at: new Date().toISOString()
                    })
                    .eq('user_id', userId)
                    .select()
                    .maybeSingle();

                if (fixErr) {
                    console.error('[account.consume] Cap update failed:', fixErr.message);
                    total = desiredCap;
                } else if (fixed) {
                    total = fixed.total_credits || desiredCap;
                    used = fixed.used_credits || used;
                } else {
                    total = desiredCap;
                }
            } else {
                total = desiredCap;
            }
        } else {
            total = quota.total_credits || 0;
            used = quota.used_credits || 0;
        }

        if (used >= total) {
            return res.status(409).json({
                error: 'No credits remaining',
                remaining: 0,
                used,
                total
            });
        }

        const { data: updated, error: upErr } = await supabaseAdmin
            .from('app_quotas')
            .update({
                used_credits: used + 1,
                updated_at: new Date().toISOString()
            })
            .eq('user_id', userId)
            .select()
            .maybeSingle();

        if (upErr) {
            console.error('[account.consume] Update failed:', upErr.message);
            throw upErr;
        }

        if (!updated) {
            throw new Error('Failed to consume credit');
        }

        const remaining = Math.max(0, (updated.total_credits || 0) - (updated.used_credits || 0));
        return res.json({ remaining });

    } catch (e) {
        console.error('[account.consume] Error:', e?.message);
        return res.status(500).json({
            error: e.message || 'Failed to consume credit',
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;
