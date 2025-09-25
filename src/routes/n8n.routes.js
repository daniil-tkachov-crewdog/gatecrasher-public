// src/routes/n8n.routes.js
const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
if (!N8N_WEBHOOK_URL) console.warn('[warn] Missing N8N_WEBHOOK_URL');

router.post('/gatecrasher', async (req, res) => {
    try {
        console.log('[POST] /gatecrasher - body:', req.body);
        const { JD, ['Save to the doc file and the spreadsheet? (+10 sec)']: _saveFlag, ['Region to search (Candidates)']: region } = req.body || {};
        if (!JD || !JD.trim()) {
            console.warn('Missing JD in request');
            return res.status(400).json({ error: 'JD is required' });
        }

        const payload = {
            JD: JD.trim(),
            'Save to the doc file and the spreadsheet? (+10 sec)': 'No',
            'Region to search (Candidates)': region || 'Western Europe',
        };

        console.log('Forwarding payload to N8N:', payload);

        const r = await fetch(N8N_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const text = await r.text();
        console.log('N8N response status:', r.status);
        if (!r.ok) {
            console.error('N8N error response:', text);
            return res.status(r.status).send(text);
        }
        res.type('text/html').send(text);
    } catch (err) {
        console.error('Error in /gatecrasher:', err);
        res.status(500).json({ error: String(err?.message || err) });
    }
});

router.post('/credits/claim', express.json(), async (req, res) => {
    try {
        console.log('[POST] /credits/claim - body:', req.body);
        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body);
        console.log('Parsed userId:', userId);
        const { data, error } = await supabaseAdmin.rpc('claim_credit', { p_user_id: userId });
        if (error) {
            console.error('Supabase error:', error);
            throw error;
        }
        console.log('Supabase claim_credit result:', data);
        if (data === true) return res.json({ ok: true });
        return res.status(402).json({ ok: false, reason: 'No credits' });
    } catch (e) {
        console.error('Error in /credits/claim:', e);
        return res.status(400).json({ error: e.message });
    }
});

module.exports = router;
