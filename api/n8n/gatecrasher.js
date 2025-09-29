module.exports = async (req, res) => {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }
    try {
        const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
        if (!N8N_WEBHOOK_URL) return res.status(500).json({ error: 'Missing N8N_WEBHOOK_URL' });

        const { JD, ['Save to the doc file and the spreadsheet? (+10 sec)']: _saveFlag, ['Region to search (Candidates)']: region } = req.body || {};
        if (!JD || !JD.trim()) return res.status(400).json({ error: 'JD is required' });

        const payload = {
            JD: JD.trim(),
            'Save to the doc file and the spreadsheet? (+10 sec)': 'No',
            'Region to search (Candidates)': region || 'Western Europe',
        };

        const r = await fetch(N8N_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const text = await r.text();
        if (!r.ok) return res.status(r.status).send(text);

        res.type('text/html').send(text);
    } catch (err) {
        return res.status(500).json({ error: String(err?.message || err) });
    }
};
