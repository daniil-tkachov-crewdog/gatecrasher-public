import "./theme.js";
import "./views.js";
import "./helpers.js"; // ensures helpers are defined before auth binds (optional)
import "./auth.js";

// Ensure dataLayer exists for analytics pushes even before GTM
window.dataLayer = window.dataLayer || [];
