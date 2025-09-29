require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const fetch = require('node-fetch'); // install with: npm i node-fetch@2

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

(async () => {
    if (!url || !key) {
        console.error("❌ SUPABASE_URL or SERVICE_ROLE_KEY missing");
        process.exit(1);
    }

    console.log("🔍 Testing Supabase connectivity to:", url);

    try {
        const r = await fetch(`${url}/rest/v1/`, {
            method: 'HEAD',
            headers: {
                apikey: key,
                Authorization: `Bearer ${key}`
            }
        });
        console.log("✅ Response:", r.status, r.statusText);
    } catch (e) {
        console.error("❌ Fetch failed:", e);
    }
})();
