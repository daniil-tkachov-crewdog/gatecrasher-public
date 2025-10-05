// src/routes/n8n.routes.js
const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

router.use(express.json({ limit: '400kb', strict: true }));

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
if (!N8N_WEBHOOK_URL) console.warn('[warn] Missing N8N_WEBHOOK_URL');

/* -----------------------------------------------------------
   Helpers
----------------------------------------------------------- */
function withTimeout(promise, ms, onAbort) {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() => {
            try { onAbort && onAbort(); } catch { }
            reject(Object.assign(new Error('Upstream timeout'), { code: 'ETIMEDOUT' }));
        }, ms);
        promise.then(
            (v) => { clearTimeout(id); resolve(v); },
            (e) => { clearTimeout(id); reject(e); }
        );
    });
}

function getRequestId(req) {
    return req.headers['x-request-id'] || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendError(res, httpStatus, code, message, details) {
    return res.status(httpStatus).json({
        status: 'error',
        code,
        message,
        ...(details ? { details } : {}),
    });
}

/* -----------------------------------------------------------
   Input schema: either JD (text) OR JD_link (URL)
----------------------------------------------------------- */
const InputSchema = z.object({
    jd: z.string().min(300, 'JD too short (min 300 chars)').optional(),
    jd_link: z.string().url('Invalid JD_link URL').optional(),
    region: z.string().optional().default('Western Europe'),
    save: z.boolean().optional().default(false),
})
    .refine((d) => d.jd || d.jd_link, {
        message: 'Either JD or JD_link is required',
    })
    .refine((d) => !(d.jd && d.jd_link), {
        message: 'Provide either JD or JD_link, not both',
    });

/* -----------------------------------------------------------
   n8n payload mapper
----------------------------------------------------------- */
function toN8nPayload({ jd, jd_link, region, save }) {
    const payload = {
        'Save to the doc file and the spreadsheet? (+10 sec)': save ? 'Yes' : 'No',
        'Region to search (Candidates)': region || 'Western Europe',
    };
    if (jd) payload.JD = jd;
    if (jd_link) payload.JD_link = jd_link;
    return payload;
}

/* -----------------------------------------------------------
   JSON endpoint (clean contract)
----------------------------------------------------------- */
router.post('/gatecrasher.json', async (req, res) => {
    const started = Date.now();
    const requestId = getRequestId(req);

    try {
        // 1) Validate input
        const input = InputSchema.parse(req.body || {});
        const payload = toN8nPayload(input);

        // 2) Forward to n8n
        const ctrl = new AbortController();
        const r = await withTimeout(
            fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-request-id': requestId,
                },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
            }),
            30000,
            () => ctrl.abort()
        );

        const contentType = (r.headers.get('content-type') || '').toLowerCase();

        if (!r.ok) {
            let errBody = null;
            try { if (contentType.includes('application/json')) errBody = await r.json(); } catch { }
            if (!errBody) {
                try { errBody = { raw: await r.text() }; } catch { errBody = null; }
            }
            return sendError(res, r.status, 'N8N_FAILED', 'n8n webhook failed', errBody || undefined);
        }

        // 3) Normalize response (JSON or HTML)
        if (contentType.includes('application/json')) {
            const data = await r.json();
            return res.json({
                status: 'ok',
                data,
                meta: { tookMs: Date.now() - started, requestId },
            });
        }

        const text = await r.text();
        return res.json({
            status: 'ok',
            data: { html: text },
            meta: { tookMs: Date.now() - started, requestId, contentType },
        });
    } catch (e) {
        if (e?.code === 'ETIMEDOUT' || e?.name === 'AbortError') {
            return sendError(res, 504, 'TIMEOUT', 'n8n timed out');
        }
        return sendError(res, 400, 'BAD_REQUEST', e?.message || 'Unexpected error');
    }
});

/* -----------------------------------------------------------
   Legacy endpoint (HTML flow, unchanged)
----------------------------------------------------------- */
router.post('/gatecrasher', async (req, res) => {
    const requestId = getRequestId(req);

    try {
        const {
            JD,
            JD_link,
            ['Save to the doc file and the spreadsheet? (+10 sec)']: saveFlag,
            ['Region to search (Candidates)']: region,
        } = req.body || {};

        if (!JD && !JD_link) {
            return res.status(400).json({ error: 'JD or JD_link is required' });
        }
        if (JD && JD_link) {
            return res.status(400).json({ error: 'Provide either JD or JD_link, not both' });
        }

        const payload = {
            'Save to the doc file and the spreadsheet? (+10 sec)': saveFlag || 'No',
            'Region to search (Candidates)': region || 'Western Europe',
        };
        if (JD) payload.JD = JD.trim();
        if (JD_link) payload.JD_link = JD_link.trim();

        const ctrl = new AbortController();
        const r = await withTimeout(
            fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-request-id': requestId,
                },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
            }),
            30000,
            () => ctrl.abort()
        );

        const text = await r.text();
        if (!r.ok) return res.status(r.status).send(text);

        res.type('text/html').send(text);
    } catch (err) {
        console.error('Error in /gatecrasher:', err);
        res.status(500).json({ error: String(err?.message || err) });
    }
});

/* -----------------------------------------------------------
   Credits endpoint (unchanged)
----------------------------------------------------------- */
router.post('/credits/claim', async (req, res) => {
    try {
        const Schema = z.object({ userId: z.string().uuid() });
        const { userId } = Schema.parse(req.body);
        const { data, error } = await supabaseAdmin.rpc('claim_credit', { p_user_id: userId });
        if (error) throw error;
        if (data === true) return res.json({ ok: true });
        return res.status(402).json({ ok: false, reason: 'No credits' });
    } catch (e) {
        return res.status(400).json({ error: e?.message || 'invalid_request' });
    }
});

module.exports = router;
