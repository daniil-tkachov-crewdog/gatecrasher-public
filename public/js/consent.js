(function () {
    // -- SET THIS --
    var GTM_ID = "GTM-NV2DBM3P";

    var KEY = "gc-consent-v1";
    var saved = null;

    // 1) Default: no analytics until user chooses
    window.dataLayer = window.dataLayer || [];
    function gtag() { dataLayer.push(arguments); }
    gtag('consent', 'default', {
        ad_storage: 'denied',
        analytics_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
        wait_for_update: 500
    });
    gtag('set', 'ads_data_redaction', true);

    // 2) Banner UI
    function h(tag, attrs, text) {
        var el = document.createElement(tag);
        for (var k in (attrs || {})) el.setAttribute(k, attrs[k]);
        if (text) el.textContent = text;
        return el;
    }
    function showBanner() {
        if (document.getElementById("gc-consent")) return;

        var bar = h('div', {
            id: 'gc-consent', style:
                'position:fixed;left:0;right:0;bottom:0;z-index:9999;' +
                'background:var(--card,#12161c);color:var(--text,#e6eaf2);' +
                'border-top:1px solid var(--border,#1f2937);' +
                'display:flex;gap:12px;align-items:center;justify-content:space-between;' +
                'padding:12px 16px;font-size:14px;flex-wrap:wrap;'
        });
        var msg = h('div', { style: 'flex:1;min-width:220px;' },
            'We use Google Analytics only if you consent. You can change this later in Privacy.');
        var actions = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' });
        var btnAccept = h('button', {
            style:
                'background:#3b82f6;border:1px solid #3b82f6;color:#fff;padding:8px 12px;border-radius:8px;cursor:pointer;'
        }, 'Accept');
        var btnReject = h('button', {
            style:
                'background:transparent;border:1px solid var(--border,#1f2937);color:inherit;padding:8px 12px;border-radius:8px;cursor:pointer;'
        }, 'Reject');

        btnAccept.onclick = function () { setConsent(true); };
        btnReject.onclick = function () { setConsent(false); };
        actions.appendChild(btnAccept); actions.appendChild(btnReject);
        bar.appendChild(msg); bar.appendChild(actions);
        document.body.appendChild(bar);
    }

    function removeBanner() {
        var el = document.getElementById("gc-consent");
        if (el) el.remove();
    }

    // Optional: reflect status text if an element exists
    function updateStatusText() {
        var el = document.getElementById("consent-status");
        if (!el) return;
        var status = 'Not set';
        try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
        if (saved) status = (saved.analytics_storage === 'granted') ? 'Analytics: ON' : 'Analytics: OFF';
        el.textContent = status;
    }

    // 3) Apply choice
    function setConsent(granted) {
        var choice = {
            ad_storage: granted ? 'granted' : 'denied',
            analytics_storage: granted ? 'granted' : 'denied',
            ad_user_data: granted ? 'granted' : 'denied',
            ad_personalization: granted ? 'granted' : 'denied'
        };
        try { localStorage.setItem(KEY, JSON.stringify(choice)); } catch (e) { }
        gtag('consent', 'update', choice);
        if (granted) loadGTM(); // strictly load GTM only after opt-in
        removeBanner();
        updateStatusText();
    }

    function loadGTM() {
        if (!GTM_ID || document.getElementById('gc-gtm')) return;
        var s = document.createElement('script');
        s.id = 'gc-gtm';
        s.async = true;
        s.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(GTM_ID);
        document.head.appendChild(s);
    }

    // 4) Restore saved choice or show banner
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { }
    if (saved && saved.analytics_storage === 'granted') {
        gtag('consent', 'update', saved);
        loadGTM(); // user already opted in
    } else if (saved) {
        gtag('consent', 'update', saved); // still denied
    } else {
        // first visit → show banner
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', showBanner);
        } else {
            showBanner();
        }
    }

    // 5) Expose API
    window.gcConsent = {
        open: showBanner,
        accept: function () { setConsent(true); },
        reject: function () { setConsent(false); }
    };

    // 6) CSP-safe event delegation for buttons/links with data-consent="..."
    document.addEventListener('click', function (e) {
        var t = e.target.closest('[data-consent]');
        if (!t) return;
        var action = t.getAttribute('data-consent');
        if (!action) return;

        // Prevent navigation if it's an <a href="#">
        var tag = t.tagName.toLowerCase();
        if (tag === 'a') e.preventDefault();

        if (action === 'open') showBanner();
        else if (action === 'accept') setConsent(true);
        else if (action === 'reject') setConsent(false);
    });

    // Update status text on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateStatusText);
    } else {
        updateStatusText();
    }
})();
