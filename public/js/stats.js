// Simple count-up animation for demo stats (mobile friendly, no libs)
(function () {
    const nums = document.querySelectorAll(".num[data-count]");
    if (!nums.length) return;

    function run(el) {
        const target = parseInt(el.getAttribute("data-count"), 10) || 0;
        let cur = 0;
        const steps = 30;
        const t = 600 / steps;
        const inc = Math.max(1, Math.round(target / steps));

        const timer = setInterval(function () {
            cur += inc;
            if (cur >= target) {
                cur = target;
                clearInterval(timer);
            }
            el.textContent = String(cur);
        }, t);
    }

    const obs = new IntersectionObserver(
        function (entries) {
            entries.forEach(function (e) {
                if (e.isIntersecting) {
                    run(e.target);
                    obs.unobserve(e.target);
                }
            });
        },
        { threshold: 0.3 }
    );

    nums.forEach(function (n) {
        obs.observe(n);
    });
})();
