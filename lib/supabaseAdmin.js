const { createClient } = require('@supabase/supabase-js');

console.log('Initializing Supabase Admin client...');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '***hidden***' : 'Not set');

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

console.log('Supabase Admin client initialized.');

module.exports = { supabaseAdmin };