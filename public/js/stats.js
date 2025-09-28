// Simple count-up animation for demo stats (mobile friendly, no libs)
export function initStats() {
    var nums = document.querySelectorAll(".num[data-count]");
    if (!nums.length) return;

    var run = function (el) {
        var target = parseInt(el.getAttribute("data-count"), 10) || 0;
        var cur = 0, steps = 30, t = 600 / steps;
        var inc = Math.max(1, Math.round(target / steps));
        var timer = setInterval(function () {
            cur += inc;
            if (cur >= target) { cur = target; clearInterval(timer); }
            el.textContent = cur.toString();
        }, t);
    };

    // Trigger when visible
    var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
            if (e.isIntersecting) { run(e.target); obs.unobserve(e.target); }
        });
    }, { threshold: 0.3 });

    nums.forEach(function (n) { obs.observe(n); });
}
