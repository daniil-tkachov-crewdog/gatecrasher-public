const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseAdmin');

/**
 * GET /api/account/summary/:userId
 * Returns plan status and remaining credits.
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
        const remaining = quota ? Math.max(0, (quota.total_credits || 0) - (quota.used_credits || 0)) : 0;

        const response = {
            status: sub?.status || 'none',
            renewalDate: sub?.current_period_end || null,
            creditsRemaining: remaining,
            freeTryUsed: !!quota?.has_claimed_free_try,
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

        // Atomic decrement using Postgres UPDATE ... WHERE used_credits < total_credits
        // NB: Supabase JS cannot express arithmetic in update directly; use RPC if you have it.
        // Fallback here: do it with a single SQL statement via PostgREST RPC.
        // If you DON'T have the RPC, uncomment the two-step fallback below.

        // Try RPC first (recommended — create it in SQL editor):
        // create or replace function app_consume_credit(p_user_id uuid)
        // returns table(total_credits int, used_credits int)
        // language sql as $$
        //   update app_quotas
        //   set used_credits = used_credits + 1,
        //       updated_at = now()
        //   where user_id = p_user_id and used_credits < total_credits
        //   returning total_credits, used_credits;
        // $$;

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
            // If no row returned, user had no credits left — keep at 0.
            if (rpcData.length === 0) {
                return res.status(409).json({ error: 'No credits remaining', remaining: 0 });
            }
            const { total_credits, used_credits } = rpcData[0] || {};
            return res.json({ remaining: Math.max(0, (total_credits || 0) - (used_credits || 0)) });
        }

        // ---------- Fallback (non-RPC, best-effort; small race risk if many concurrent calls) ----------
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
