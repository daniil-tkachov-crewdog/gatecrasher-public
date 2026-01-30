/**
 * N8N Routes - Webhook forwarding to n8n automation platform
 */
const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

router.use(express.json({ limit: '400kb', strict: true }));

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
if (!N8N_WEBHOOK_URL) {
    console.error('[n8n] Missing N8N_WEBHOOK_URL environment variable');
}

function withTimeout(promise, ms, onAbort) {
    return new Promise((resolve, reject) => {
        if (typeof ms !== 'number' || ms <= 0) {
            reject(new Error('Invalid timeout value'));
            return;
        }

        const id = setTimeout(() => {
            try {
                if (onAbort && typeof onAbort === 'function') {
                    onAbort();
                }
            } catch (abortErr) {
                console.error('[withTimeout] onAbort failed:', abortErr?.message);
            }

            const timeoutError = new Error(`Operation timed out after ${ms}ms`);
            timeoutError.code = 'ETIMEDOUT';
            timeoutError.timeout = ms;
            reject(timeoutError);
        }, ms);

        promise.then(
            (value) => {
                clearTimeout(id);
                resolve(value);
            },
            (error) => {
                clearTimeout(id);
                reject(error);
            }
        );
    });
}

function getRequestId(req) {
    try {
        if (!req || !req.headers) {
            return `fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }

        const headerRequestId = req.headers['x-request-id'];

        if (headerRequestId && typeof headerRequestId === 'string' && headerRequestId.trim()) {
            return headerRequestId.trim();
        }

        return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    } catch (error) {
        return `error-${Date.now()}`;
    }
}

function sendError(res, httpStatus, code, message, details) {
    try {
        if (!res || typeof res.status !== 'function') {
            console.error('[sendError] Invalid response object');
            return;
        }

        if (typeof httpStatus !== 'number' || httpStatus < 100 || httpStatus > 599) {
            httpStatus = 500;
        }

        const errorResponse = {
            status: 'error',
            code: code || 'UNKNOWN_ERROR',
            message: message || 'An unexpected error occurred',
            timestamp: new Date().toISOString(),
        };

        if (details && typeof details === 'object') {
            errorResponse.details = details;
        }

        console.error('[sendError]', httpStatus, code, message);

        return res.status(httpStatus).json(errorResponse);
    } catch (error) {
        console.error('[sendError] Failed:', error?.message);

        try {
            return res.status(500).json({
                status: 'error',
                code: 'ERROR_HANDLER_FAILED',
                message: 'Failed to process error response',
                timestamp: new Date().toISOString()
            });
        } catch (fallbackError) {
            console.error('[sendError] Fallback failed:', fallbackError);
        }
    }
}

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

function toN8nPayload({ jd, jd_link, region, save }) {
    try {
        const payload = {
            'Save to the doc file and the spreadsheet? (+10 sec)': save ? 'Yes' : 'No',
            'Region to search (Candidates)': region || 'Western Europe',
        };

        if (jd) {
            payload.JD = typeof jd === 'string' ? jd : String(jd);
        }

        if (jd_link) {
            payload.JD_link = typeof jd_link === 'string' ? jd_link : String(jd_link);
        }

        return payload;
    } catch (error) {
        console.error('[toN8nPayload] Error:', error?.message);
        throw new Error(`Failed to create n8n payload: ${error?.message}`);
    }
}

/**
 * POST /api/n8n/gatecrasher.json
 * Modern JSON API endpoint for gatecrasher job processing
 */
router.post('/gatecrasher.json', async (req, res) => {
    const started = Date.now();
    const requestId = getRequestId(req);

    try {
        if (!N8N_WEBHOOK_URL || N8N_WEBHOOK_URL.trim() === '') {
            return sendError(
                res,
                503,
                'SERVICE_UNAVAILABLE',
                'N8N webhook service is not configured',
                { requestId }
            );
        }

        if (!req.body || typeof req.body !== 'object') {
            return sendError(
                res,
                400,
                'INVALID_REQUEST',
                'Request body must be a valid JSON object',
                { requestId }
            );
        }

        let input;
        try {
            input = InputSchema.parse(req.body);
        } catch (zodError) {
            return sendError(
                res,
                400,
                'VALIDATION_FAILED',
                'Input validation failed',
                {
                    requestId,
                    errors: zodError.errors?.map(e => ({
                        field: e.path.join('.'),
                        message: e.message
                    })) || []
                }
            );
        }

        let payload;
        try {
            payload = toN8nPayload(input);
        } catch (payloadError) {
            return sendError(
                res,
                500,
                'PAYLOAD_ERROR',
                'Failed to prepare request for n8n',
                { requestId, error: payloadError?.message }
            );
        }

        const ctrl = new AbortController();
        let n8nResponse;

        try {
            n8nResponse = await withTimeout(
                fetch(N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-request-id': requestId,
                        'User-Agent': 'GatecrasherAPI/1.0',
                    },
                    body: JSON.stringify(payload),
                    signal: ctrl.signal,
                }),
                30000,
                () => ctrl.abort()
            );
        } catch (fetchError) {
            console.error('[gatecrasher.json] Fetch error:', fetchError?.message);

            if (fetchError?.code === 'ETIMEDOUT' || fetchError?.name === 'AbortError') {
                return sendError(
                    res,
                    504,
                    'TIMEOUT',
                    'N8N webhook request timed out after 30 seconds',
                    { requestId, timeout: 30000 }
                );
            }

            return sendError(
                res,
                503,
                'N8N_CONNECTION_FAILED',
                'Failed to connect to n8n webhook',
                { requestId, error: fetchError?.message }
            );
        }

        const contentType = (n8nResponse.headers.get('content-type') || '').toLowerCase();

        if (!n8nResponse.ok) {
            console.error('[gatecrasher.json] N8N error status:', n8nResponse.status);

            let errBody = null;

            try {
                if (contentType.includes('application/json')) {
                    errBody = await n8nResponse.json();
                }
            } catch (jsonError) { }

            if (!errBody) {
                try {
                    const textBody = await n8nResponse.text();
                    errBody = { raw: textBody };
                } catch (textError) { }
            }

            return sendError(
                res,
                n8nResponse.status,
                'N8N_FAILED',
                'N8N webhook returned an error',
                {
                    requestId,
                    n8nStatus: n8nResponse.status,
                    n8nResponse: errBody || 'Could not read error response'
                }
            );
        }

        const tookMs = Date.now() - started;

        if (contentType.includes('application/json')) {
            let data;
            try {
                data = await n8nResponse.json();
            } catch (jsonError) {
                return sendError(
                    res,
                    502,
                    'INVALID_N8N_RESPONSE',
                    'N8N returned invalid JSON',
                    { requestId, error: jsonError?.message }
                );
            }

            return res.json({
                status: 'ok',
                data,
                meta: {
                    tookMs,
                    requestId,
                    timestamp: new Date().toISOString()
                },
            });
        }

        let text;
        try {
            text = await n8nResponse.text();
        } catch (textError) {
            return sendError(
                res,
                502,
                'INVALID_N8N_RESPONSE',
                'Failed to read n8n response',
                { requestId, error: textError?.message }
            );
        }

        return res.json({
            status: 'ok',
            data: { html: text },
            meta: {
                tookMs,
                requestId,
                contentType,
                timestamp: new Date().toISOString()
            },
        });

    } catch (e) {
        console.error('[gatecrasher.json] Error:', e?.message);

        if (e?.code === 'ETIMEDOUT' || e?.name === 'AbortError') {
            return sendError(
                res,
                504,
                'TIMEOUT',
                'Request timed out',
                { requestId, error: e?.message }
            );
        }

        return sendError(
            res,
            500,
            'INTERNAL_ERROR',
            e?.message || 'An unexpected error occurred',
            {
                requestId,
                timestamp: new Date().toISOString()
            }
        );
    }
});

/**
 * POST /api/n8n/gatecrasher
 * Legacy HTML endpoint for gatecrasher job processing
 */
router.post('/gatecrasher', async (req, res) => {
    const requestId = getRequestId(req);
    const started = Date.now();

    try {
        if (!N8N_WEBHOOK_URL || N8N_WEBHOOK_URL.trim() === '') {
            return res.status(503).json({
                error: 'Service unavailable',
                message: 'N8N webhook service is not configured',
                requestId
            });
        }

        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({
                error: 'Invalid request body',
                requestId
            });
        }

        const {
            JD,
            JD_link,
            ['Save to the doc file and the spreadsheet? (+10 sec)']: saveFlag,
            ['Region to search (Candidates)']: region,
            outreach_message,
        } = req.body;

        if (!JD && !JD_link) {
            return res.status(400).json({
                error: 'JD or JD_link is required',
                requestId
            });
        }

        if (JD && JD_link) {
            return res.status(400).json({
                error: 'Provide either JD or JD_link, not both',
                requestId
            });
        }

        const payload = {
            'Save to the doc file and the spreadsheet? (+10 sec)': saveFlag || 'No',
            'Region to search (Candidates)': region || 'Western Europe',
        };

        if (JD) {
            payload.JD = typeof JD === 'string' ? JD.trim() : String(JD).trim();
        }

        if (JD_link) {
            payload.JD_link = typeof JD_link === 'string' ? JD_link.trim() : String(JD_link).trim();
        }

        if (outreach_message !== undefined) {
            payload.outreach_message = typeof outreach_message === 'string' ? outreach_message : (outreach_message ? 'yes' : 'no');
        }

        const ctrl = new AbortController();
        let n8nResponse;

        try {
            n8nResponse = await withTimeout(
                fetch(N8N_WEBHOOK_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-request-id': requestId,
                        'User-Agent': 'GatecrasherAPI/1.0-Legacy',
                    },
                    body: JSON.stringify(payload),
                    signal: ctrl.signal,
                }),
                30000,
                () => ctrl.abort()
            );
        } catch (fetchError) {
            console.error('[gatecrasher] Fetch error:', fetchError?.message);

            if (fetchError?.code === 'ETIMEDOUT' || fetchError?.name === 'AbortError') {
                return res.status(504).json({
                    error: 'Timeout',
                    message: 'N8N webhook request timed out',
                    requestId
                });
            }

            return res.status(503).json({
                error: 'Connection failed',
                message: 'Failed to connect to n8n webhook',
                requestId
            });
        }

        let text;
        try {
            text = await n8nResponse.text();
        } catch (textError) {
            return res.status(502).json({
                error: 'Invalid response',
                message: 'Failed to read n8n response',
                requestId
            });
        }

        if (!n8nResponse.ok) {
            return res.status(n8nResponse.status).send(text);
        }

        return res.type('text/html').send(text);

    } catch (err) {
        console.error('[gatecrasher] Error:', err?.message);

        return res.status(500).json({
            error: 'Internal server error',
            message: String(err?.message || err),
            requestId,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * POST /api/n8n/credits/claim
 * Claim a credit for job processing
 */
router.post('/credits/claim', async (req, res) => {
    const requestId = getRequestId(req);

    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({
                error: 'Invalid request body',
                requestId
            });
        }

        const Schema = z.object({
            userId: z.string().uuid('Invalid userId format - must be a valid UUID')
        });

        let userId;
        try {
            const parsed = Schema.parse(req.body);
            userId = parsed.userId;
        } catch (zodError) {
            return res.status(400).json({
                error: 'Validation failed',
                message: 'Invalid request data',
                details: zodError.errors?.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                })) || [],
                requestId
            });
        }

        let data, error;
        try {
            const result = await supabaseAdmin.rpc('claim_credit', {
                p_user_id: userId
            });
            data = result.data;
            error = result.error;
        } catch (rpcException) {
            console.error('[credits.claim] RPC exception:', rpcException?.message);
            return res.status(500).json({
                error: 'Database error',
                message: 'Failed to claim credit',
                requestId
            });
        }

        if (error) {
            console.error('[credits.claim] RPC error:', error.code, error.message);
            return res.status(500).json({
                error: 'Credit claim failed',
                message: error.message || 'Failed to claim credit',
                requestId
            });
        }

        if (data === true) {
            return res.json({
                ok: true,
                message: 'Credit claimed successfully',
                requestId
            });
        }

        return res.status(402).json({
            ok: false,
            error: 'Insufficient credits',
            reason: 'No credits available',
            requestId
        });

    } catch (e) {
        console.error('[credits.claim] Error:', e?.message);

        return res.status(500).json({
            error: 'Internal server error',
            message: e?.message || 'An unexpected error occurred',
            requestId,
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;
