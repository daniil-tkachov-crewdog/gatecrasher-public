require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder?.('ipv4first');

const path = require('path');
const express = require('express');

const { applySecurity } = require('./middleware/security');
const stripeRoutes = require('./routes/stripe.routes');
const n8nRoutes = require('./routes/n8n.routes');
const accountRoutes = require('./routes/account.routes');

const app = express();

// Quick sanity log so we can see the secret is actually loaded
console.log('[BOOT] STRIPE_WEBHOOK_SECRET present?', !!(process.env.STRIPE_WEBHOOK_SECRET || '').trim());

// Security (Helmet, CORS, rate limit, xss-clean)
applySecurity(app);

// 🔎 Global request logger
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  console.log(`      IP: ${req.ip}, Host: ${req.get('host')}, Origin: ${req.get('origin') || 'n/a'}`);
  console.log(`      UA: ${req.get('user-agent')}`);
  next();
});

// Static (optional)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Use JSON for everything EXCEPT the Stripe webhook path
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next(); // do not parse
  return express.json()(req, res, next);
});

// 🔎 Health check endpoint
app.get('/api/ping', (req, res) => {
  console.log('[PING] Health check hit');
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Mount routers exactly once
app.use('/api/stripe', stripeRoutes);
app.use('/api/n8n', n8nRoutes);
app.use('/api/account', accountRoutes);

// Centralized error handler (minimal)
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

module.exports = app;
