/**
 * Searches Routes - Job search history logging and retrieval
 */
const express = require("express");
const router = express.Router();
const { z } = require("zod");
const { supabaseAdmin } = require("../lib/supabaseAdmin");

const HRContact = z.object({
    name: z.string().min(1, "Contact name is required").trim(),
    title: z.string().trim().optional().nullable(),
    profileUrl: z.string().url("Profile URL must be a valid URL").optional().nullable(),
});

const LogBody = z
    .object({
        userId: z.string().uuid("User ID must be a valid UUID"),
        sourceType: z.enum(["paste", "url", "linkedin"], {
            errorMap: () => ({ message: "Source type must be 'paste', 'url', or 'linkedin'" })
        }).optional().default("paste"),
        sourceUrl: z.string().url("Source URL must be a valid URL").optional().nullable(),
        includeLeads: z.boolean().optional().default(false),
        jdRaw: z.string().max(100_000, "Job description exceeds maximum length of 100,000 characters").optional().default(""),
        jobTitle: z.string().trim().optional().nullable(),
        companyName: z.string().trim().optional().nullable(),
        companyUrl: z.string().url("Company URL must be a valid URL").optional().nullable(),
        location: z.string().trim().optional().nullable(),
        whyCompany: z.string().trim().optional().nullable(),
        hrContacts: z.array(HRContact).optional().default([]),
    })
    .superRefine((val, ctx) => {
        if (val.sourceType === "paste" && (!val.jdRaw || val.jdRaw.trim().length === 0)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["jdRaw"],
                message: "Job description text is required when source type is 'paste'",
            });
        }
    });

const ListQuery = z.object({
    userId: z.string().uuid("User ID must be a valid UUID"),
    limit: z.coerce.number().int().min(1, "Limit must be at least 1").max(50, "Limit cannot exceed 50").optional().default(20),
    cursor: z
        .preprocess(
            (val) => {
                if (typeof val === "string" && val.length > 0) {
                    try {
                        return val.replace(/(\.\d{3})\d+/, "$1");
                    } catch (error) {
                        return val;
                    }
                }
                return val;
            },
            z.string().datetime("Cursor must be a valid ISO 8601 datetime string").optional()
        ),
});

function excerpt(s, max = 500) {
    try {
        if (!s) return "";
        if (typeof s !== 'string') {
            s = String(s);
        }
        if (typeof max !== 'number' || max < 0) {
            max = 500;
        }
        return s.length <= max ? s : s.slice(0, max);
    } catch (error) {
        console.error('[excerpt] Error:', error?.message);
        return "";
    }
}

/**
 * POST /api/searches/log
 * Log a new job search with metadata
 */
router.post("/log", async (req, res) => {
    const requestId = `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({
                ok: false,
                error: 'invalid_request_body',
                requestId
            });
        }

        let input;
        try {
            input = LogBody.parse(req.body);
        } catch (zodError) {
            return res.status(400).json({
                ok: false,
                error: 'validation_failed',
                message: 'Input validation failed',
                details: zodError.errors?.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                })) || [],
                requestId
            });
        }

        const insertData = {
            user_id: input.userId,
            source_type: input.sourceType,
            source_url: input.sourceUrl ?? null,
            include_leads: !!input.includeLeads,
            jd_raw: input.jdRaw || "",
            jd_excerpt: excerpt(input.jdRaw, 500),
            job_title: input.jobTitle ?? null,
            company_name: input.companyName ?? null,
            company_url: input.companyUrl ?? null,
            location: input.location ?? null,
            why_company: input.whyCompany ?? null,
            hr_contacts: input.hrContacts ?? [],
            status: "succeeded",
        };

        let data, error;
        try {
            const result = await supabaseAdmin
                .from("app_searches")
                .insert(insertData)
                .select("id")
                .single();

            data = result.data;
            error = result.error;
        } catch (dbException) {
            console.error('[searches.log] Database exception:', dbException?.message);
            return res.status(500).json({
                ok: false,
                error: 'database_error',
                requestId
            });
        }

        if (error) {
            console.error('[searches.log] Insert error:', error.code, error.message);

            const statusCode = error.code === '23505' ? 409 :
                error.code === '23503' ? 400 : 500;

            return res.status(statusCode).json({
                ok: false,
                error: 'insert_failed',
                requestId
            });
        }

        if (!data || !data.id) {
            console.error('[searches.log] Insert returned no data');
            return res.status(500).json({
                ok: false,
                error: 'insert_failed',
                requestId
            });
        }

        return res.json({
            ok: true,
            id: data.id,
            requestId
        });

    } catch (e) {
        console.error('[searches.log] Error:', e?.message);

        return res.status(500).json({
            ok: false,
            error: 'internal_error',
            message: e?.message || 'An unexpected error occurred',
            requestId,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * GET /api/searches
 * Retrieve paginated list of user's search history
 */
router.get("/", async (req, res) => {
    const requestId = `list-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    try {
        if (!req.query || typeof req.query !== 'object') {
            return res.status(400).json({
                ok: false,
                error: 'invalid_query',
                requestId
            });
        }

        const parsed = ListQuery.safeParse(req.query);

        if (!parsed.success) {
            return res.status(400).json({
                ok: false,
                error: 'validation_failed',
                details: parsed.error.errors?.map(e => ({
                    field: e.path.join('.'),
                    message: e.message
                })) || [],
                requestId
            });
        }

        const { userId, limit, cursor } = parsed.data;

        let query = supabaseAdmin
            .from("app_searches")
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
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(limit);

        if (cursor) {
            query = query.lt("created_at", cursor);
        }

        let data, error;
        try {
            const result = await query;
            data = result.data;
            error = result.error;
        } catch (dbException) {
            console.error('[searches.list] Database exception:', dbException?.message);
            return res.status(500).json({
                ok: false,
                error: 'database_error',
                requestId
            });
        }

        if (error) {
            console.error('[searches.list] Select error:', error.code, error.message);
            return res.status(500).json({
                ok: false,
                error: 'db_error',
                requestId
            });
        }

        if (!Array.isArray(data)) {
            console.error('[searches.list] Invalid data format returned');
            return res.status(500).json({
                ok: false,
                error: 'invalid_response',
                requestId
            });
        }

        let items;
        try {
            items = data.map((record) => {
                let createdIso = null;
                if (record.created_at) {
                    try {
                        createdIso = new Date(record.created_at).toISOString();
                    } catch (dateError) {
                        createdIso = null;
                    }
                }

                return {
                    id: record.id,
                    createdAt: createdIso,
                    jobTitle: record.job_title || null,
                    companyName: record.company_name || null,
                    companyUrl: record.company_url || null,
                    location: record.location || null,
                    whyCompany: record.why_company || null,
                    hrContacts: Array.isArray(record.hr_contacts) ? record.hr_contacts : [],
                    jdExcerpt: record.jd_excerpt || "",
                    sourceType: record.source_type || "paste",
                    sourceUrl: record.source_url || null,
                };
            });
        } catch (mappingError) {
            console.error('[searches.list] Mapping error:', mappingError?.message);
            return res.status(500).json({
                ok: false,
                error: 'data_transformation_error',
                requestId
            });
        }

        let nextCursor = null;
        if (items.length > 0) {
            const lastItem = items[items.length - 1];
            if (lastItem && lastItem.createdAt) {
                nextCursor = lastItem.createdAt;
            }
        }

        return res.json({
            ok: true,
            items,
            nextCursor,
            meta: {
                count: items.length,
                limit,
                hasMore: items.length === limit,
                requestId
            }
        });

    } catch (e) {
        console.error('[searches.list] Error:', e?.message);

        return res.status(500).json({
            ok: false,
            error: 'internal_error',
            message: e?.message || 'An unexpected error occurred',
            requestId,
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;
