const { supabaseAdmin } = require('../../../lib/supabaseAdmin');

module.exports = async (req, res) => {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    try {
        const userId = req.query.userId;
        const { data: subs, error: subErr } = await supabaseAdmin
            .from('app_subscriptions').select('*').eq('user_id', userId).order('updated_at', { ascending: false }).limit(1);
        if (subErr) throw subErr;
        const { data: quota, error: quotaErr } = await supabaseAdmin
            .from('app_quotas').select('*').eq('user_id', userId).maybeSingle();
        if (quotaErr) throw quotaErr;

        const sub = subs?.[0] || null;
        const response = {
            status: sub?.status || 'none',
            renewalDate: sub?.current_period_end || null,
            creditsRemaining: quota ? Math.max(0, quota.total_credits - quota.used_credits) : 0,
            freeTryUsed: !!quota?.has_claimed_free_try,
        };
        res.json(response);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load summary' });
    }
};
