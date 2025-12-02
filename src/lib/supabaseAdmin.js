/**
 * Supabase Admin Client - Database connection with validation
 */
const { createClient } = require('@supabase/supabase-js');

function validateSupabaseUrl(url) {
    if (!url) {
        throw new Error('SUPABASE_URL is not set');
    }

    const trimmedUrl = url.trim();
    if (trimmedUrl.length === 0) {
        throw new Error('SUPABASE_URL is empty');
    }

    try {
        const parsedUrl = new URL(trimmedUrl);

        if (parsedUrl.protocol !== 'https:') {
            throw new Error(`SUPABASE_URL must use HTTPS protocol`);
        }

        if (!parsedUrl.hostname.includes('supabase')) {
            console.error(`[supabase] URL doesn't appear to be a Supabase URL: ${parsedUrl.hostname}`);
        }

    } catch (error) {
        throw new Error(`SUPABASE_URL is not a valid URL: ${error.message}`);
    }

    return trimmedUrl;
}

function validateServiceRoleKey(key) {
    if (!key) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
    }

    const trimmedKey = key.trim();
    if (trimmedKey.length === 0) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY is empty');
    }

    if (!trimmedKey.startsWith('eyJ')) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY has invalid format - expected JWT token');
    }

    if (trimmedKey.length < 100) {
        console.error('[supabase] Service role key seems unusually short');
    }

    try {
        const parts = trimmedKey.split('.');
        if (parts.length !== 3) {
            throw new Error('JWT must have 3 parts');
        }

        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

        if (payload.role !== 'service_role') {
            console.error(`[supabase] Key role is '${payload.role}', not 'service_role'`);
        }

    } catch (error) {
        console.error('[supabase] Could not decode JWT:', error.message);
    }

    return trimmedKey;
}

let supabaseAdmin;

try {
    const supabaseUrl = validateSupabaseUrl(process.env.SUPABASE_URL);
    const serviceRoleKey = validateServiceRoleKey(process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        supabaseAdmin = createClient(
            supabaseUrl,
            serviceRoleKey,
            {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false,
                    detectSessionInUrl: false
                },
                global: {
                    headers: {
                        'X-Client-Info': 'supabase-admin-node'
                    }
                }
            }
        );
    } catch (clientError) {
        throw new Error(`Failed to create Supabase client: ${clientError.message}`);
    }

    if (!supabaseAdmin || typeof supabaseAdmin.from !== 'function') {
        throw new Error('Supabase client was created but appears invalid');
    }

    if (!supabaseAdmin.auth || !supabaseAdmin.storage) {
        console.error('[supabase] Client is missing expected properties (auth/storage)');
    }

} catch (error) {
    console.error('[supabase] Critical initialization error:', error.message);
    throw new Error(`Failed to initialize Supabase: ${error.message}`);
}

const supabaseAdminProxy = new Proxy(supabaseAdmin, {
    get(target, prop) {
        const value = target[prop];

        if (prop === 'from' && typeof value === 'function') {
            return function (tableName) {
                try {
                    return value.call(target, tableName);
                } catch (error) {
                    console.error(`[supabase] Error accessing table '${tableName}':`, error.message);
                    throw error;
                }
            };
        }

        if (typeof value === 'function') {
            return function (...args) {
                try {
                    return value.apply(target, args);
                } catch (error) {
                    console.error(`[supabase] Error calling supabase.${String(prop)}:`, error.message);
                    throw error;
                }
            };
        }

        return value;
    }
});

module.exports = {
    supabaseAdmin: supabaseAdminProxy,
    validateSupabaseUrl,
    validateServiceRoleKey
};
