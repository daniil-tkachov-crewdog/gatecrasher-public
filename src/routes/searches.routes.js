// src/routes/searches.routes.js
const express = require("express");
const router = express.Router();
const { z } = require("zod");
const { supabaseAdmin } = require("../lib/supabaseAdmin");

// ---------- Validation ----------
const HRContact = z.object({
    name: z.string().min(1).trim(),
    title: z.string().trim().optional().nullable(),
    profileUrl: z.string().url().optional().nullable(),
});

// FIX: allow empty jdRaw for non-"paste" sources while keeping it required for "paste"
const LogBody = z
    .object({
        userId: z.string().uuid(),
        sourceType: z.enum(["paste", "url", "linkedin"]).optional().default("paste"),
        sourceUrl: z.string().url().optional().nullable(),
        includeLeads: z.boolean().optional().default(false),

        // was: z.string().min(1).max(100_000)
        // now optional with default "", upper bound kept
        jdRaw: z.string().max(100_000).optional().default(""),

        jobTitle: z.string().trim().optional().nullable(),
        companyName: z.string().trim().optional().nullable(),
        companyUrl: z.string().url().optional().nullable(),
        location: z.string().trim().optional().nullable(),
        whyCompany: z.string().trim().optional().nullable(),
        hrContacts: z.array(HRContact).optional().default([]),
    })
    .superRefine((val, ctx) => {
        // Enforce non-empty jdRaw only when sourceType is "paste"
        if (val.sourceType === "paste" && (!val.jdRaw || val.jdRaw.trim().length === 0)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["jdRaw"],
                message: "jdRaw is required when sourceType is 'paste'",
            });
        }
    });

/**
 * NOTE: Postgres often returns microsecond timestamps like
 * 2025-10-04T16:36:59.892235+00:00
 * which Zod's .datetime() rejects.  We trim microseconds before validation.
 */
const ListQuery = z.object({
    userId: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: z
        .preprocess(
            (val) => {
                if (typeof val === "string") {
                    // Trim microseconds to 3 digits so Zod accepts
                    return val.replace(/(\.\d{3})\d+/, "$1");
                }
                return val;
            },
            z.string().datetime().optional()
        ),
});

// ---------- Helpers ----------
function excerpt(s, max = 500) {
    if (!s) return "";
    return s.length <= max ? s : s.slice(0, max);
}

// ---------- Routes ----------

// POST /api/searches/log
router.post("/log", async (req, res) => {
    try {
        const input = LogBody.parse(req.body);

        const { data, error } = await supabaseAdmin
            .from("app_searches")
            .insert({
                user_id: input.userId,

                source_type: input.sourceType,
                source_url: input.sourceUrl ?? null,
                include_leads: !!input.includeLeads,

                jd_raw: input.jdRaw, // remains same; now safely defaults to ""
                jd_excerpt: excerpt(input.jdRaw, 500),

                job_title: input.jobTitle ?? null,
                company_name: input.companyName ?? null,
                company_url: input.companyUrl ?? null,
                location: input.location ?? null,
                why_company: input.whyCompany ?? null,
                hr_contacts: input.hrContacts ?? [],

                status: "succeeded",
            })
            .select("id")
            .single();

        if (error) {
            console.error("[searches.log] insert error:", error);
            return res.status(202).json({ ok: false, error: "insert_failed" });
        }

        return res.json({ ok: true, id: data.id });
    } catch (e) {
        console.error("[searches.log] validation error:", e);
        return res.status(400).json({ ok: false, error: "bad_request" });
    }
});

// GET /api/searches?userId=...&limit=20&cursor=ISO
router.get("/", async (req, res) => {
    try {
        const parsed = ListQuery.safeParse(req.query);

        if (!parsed.success) {
            console.warn("[searches.list] invalid query:", parsed.error.format());
            return res.status(400).json({ ok: false, error: "bad_request" });
        }

        const { userId, limit, cursor } = parsed.data;
        console.log("[searches.list] query:", { userId, limit, cursor });

        let q = supabaseAdmin
            .from("app_searches")
            .select(
                `
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
      `
            )
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(limit);

        if (cursor) q = q.lt("created_at", cursor);

        const { data, error } = await q;
        if (error) {
            console.error("[searches.list] select error:", error);
            return res.status(500).json({ ok: false, error: "db_error" });
        }

        // Normalize created_at to valid ISO strings (millisecond precision)
        const items = (data || []).map((r) => {
            const createdIso = r.created_at
                ? new Date(r.created_at).toISOString()
                : null;
            return {
                id: r.id,
                createdAt: createdIso,
                jobTitle: r.job_title,
                companyName: r.company_name,
                companyUrl: r.company_url,
                location: r.location,
                whyCompany: r.why_company,
                hrContacts: r.hr_contacts || [],
                jdExcerpt: r.jd_excerpt,
                sourceType: r.source_type,
                sourceUrl: r.source_url,
            };
        });

        // Compute nextCursor using normalized ISO date
        const nextCursor =
            items.length && items[items.length - 1].createdAt
                ? items[items.length - 1].createdAt
                : null;

        return res.json({ ok: true, items, nextCursor });
    } catch (e) {
        console.error("[searches.list] runtime error:", e);
        return res.status(400).json({ ok: false, error: "bad_request" });
    }
});

module.exports = router;
