// src/routes/searches.routes.js
const express = require('express');
const router = express.Router();
const { z } = require('zod');
const { supabaseAdmin } = require('../lib/supabaseAdmin');

// ---------- Validation ----------
const HRContact = z.object({
    name: z.string().min(1).trim(),
    title: z.string().trim().optional().nullable(),
    profileUrl: z.string().url().optional().nullable(),
});

const LogBody = z.object({
    userId: z.string().uuid(),
    sourceType: z.enum(['paste', 'url', 'linkedin']).optional().default('paste'),
    sourceUrl: z.string().url().optional().nullable(),
    includeLeads: z.boolean().optional().default(false),

    jdRaw: z.string().min(1).max(100_000), // cap at 100KB
    jobTitle: z.string().trim().optional().nullable(),
    companyName: z.string().trim().optional().nullable(),
    companyUrl: z.string().url().optional().nullable(),
    location: z.string().trim().optional().nullable(),
    whyCompany: z.string().trim().optional().nullable(),
    hrContacts: z.array(HRContact).optional().default([]),
});

const ListQuery = z.object({
    userId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: z.string().datetime().optional(), // ISO timestamp
});

// ---------- Helpers ----------
function excerpt(s, max = 500) {
    if (!s) return '';
    return s.length <= max ? s : s.slice(0, max);
}

// ---------- Routes ----------

// POST /api/searches/log  (fire-and-forget)
router.post('/log', async (req, res) => {
    try {
        const input = LogBody.parse(req.body);

        const { data, error } = await supabaseAdmin
            .from('app_searches')
            .insert({
                user_id: input.userId,

                source_type: input.sourceType,
                source_url: input.sourceUrl ?? null,
                include_leads: !!input.includeLeads,

                jd_raw: input.jdRaw,
                jd_excerpt: excerpt(input.jdRaw, 500),

                job_title: input.jobTitle ?? null,
                company_name: input.companyName ?? null,
                company_url: input.companyUrl ?? null,
                location: input.location ?? null,
                why_company: input.whyCompany ?? null,
                hr_contacts: input.hrContacts ?? [],

                status: 'succeeded',
            })
            .select('id')
            .single();

        if (error) {
            console.error('[searches.log] insert error:', error);
            return res.status(202).json({ ok: false, error: 'insert_failed' });
        }

        return res.json({ ok: true, id: data.id });
    } catch (e) {
        console.error('[searches.log] validation error:', e);
        return res.status(400).json({ ok: false, error: 'bad_request' });
    }
});

// GET /api/searches?userId=...&limit=20&cursor=ISO
router.get('/', async (req, res) => {
    try {
        const { userId, limit, cursor } = ListQuery.parse(req.query);

        let q = supabaseAdmin
            .from('app_searches')
            .select(`
        id,
        created_at,
        job_title,
        company_name,
        company_url,
        location,
        why_company,
        hr_contacts,
        jd_excerpt,
        source_type,
        source_url
      `)
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (cursor) q = q.lt('created_at', cursor);

        const { data, error } = await q;
        if (error) {
            console.error('[searches.list] select error:', error);
            return res.status(500).json({ ok: false, error: 'db_error' });
        }

        const nextCursor = data?.length ? data[data.length - 1].created_at : null;

        const items = (data || []).map((r) => ({
            id: r.id,
            createdAt: r.created_at,
            jobTitle: r.job_title,
            companyName: r.company_name,
            companyUrl: r.company_url,
            location: r.location,
            whyCompany: r.why_company,
            hrContacts: r.hr_contacts || [],
            jdExcerpt: r.jd_excerpt,
            sourceType: r.source_type,
            sourceUrl: r.source_url,
        }));

        return res.json({ ok: true, items, nextCursor });
    } catch (e) {
        console.error('[searches.list] validation error:', e);
        return res.status(400).json({ ok: false, error: 'bad_request' });
    }
});

module.exports = router;
