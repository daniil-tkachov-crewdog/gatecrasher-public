const { z } = require('zod');
const { supabaseAdmin } = require('../../../lib/supabaseAdmin');

module.exports = async (req, res) => {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    try {
        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body || {});
        const { data, error } = await supabaseAdmin.rpc('claim_credit', { p_user_id: userId });
        if (error) throw error;
        if (data === true) return res.json({ ok: true });
        return res.status(402).json({ ok: false, reason: 'No credits' });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
};
