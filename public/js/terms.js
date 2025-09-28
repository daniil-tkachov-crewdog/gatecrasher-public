// Keep original ESM usage and logic intact
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
    'https://lurzlzhpjxcxhuoqpbok.supabase.co',
    'sb_publishable_x0hlg96FMQ9arkjGd2F9Pw_yQ-fLI3r'
);

(async () => {
    try {
        const hash = window.location.hash.substring(1);
        const params = new URLSearchParams(hash);
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        const type = params.get('type');

        if (!access_token || !refresh_token) return;
        if (type !== 'signup' && type !== 'email_change') return;

        const { error } = await supabase.auth.setSession({ access_token, refresh_token });
        if (error) throw error;

        if (window.history.replaceState) {
            const clean = window.location.origin + window.location.pathname;
            window.history.replaceState({}, document.title, clean);
        }
    } catch (e) {
        const box = document.getElementById('err');
        if (box) {
            box.style.display = 'block';
            box.textContent = 'Verification failed: ' + (e?.message || e);
        }
    }
})();
