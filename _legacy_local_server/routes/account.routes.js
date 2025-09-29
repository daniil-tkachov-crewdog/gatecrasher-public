const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../lib/supabaseAdmin');

router.get('/summary/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        console.log(`[account.summary] Fetching summary for userId: ${userId}`);

        // latest subscription (if any)
        const { data: subs, error: subErr } = await supabaseAdmin
            .from('app_subscriptions')
            .select('*')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false })
            .limit(1);
        console.log('[account.summary] Subscription query result:', subs, 'Error:', subErr);
        if (subErr) throw subErr;

        // quota (if any)
        const { data: quota, error: quotaErr } = await supabaseAdmin
            .from('app_quotas')
            .select('*')
            .eq('user_id', userId)
            .maybeSingle();
        console.log('[account.summary] Quota query result:', quota, 'Error:', quotaErr);
        if (quotaErr) throw quotaErr;

        const sub = subs?.[0] || null;
        const response = {
            status: sub?.status || 'none',
            renewalDate: sub?.current_period_end || null,
            creditsRemaining: quota ? Math.max(0, quota.total_credits - quota.used_credits) : 0,
            freeTryUsed: !!quota?.has_claimed_free_try,
        };
        console.log('[account.summary] Response:', response);
        res.json(response);
    } catch (e) {
        console.error('[account.summary] Error:', e);
        res.status(500).json({ error: e.message || 'Failed to load summary' });
    }
});

module.exports = router;
