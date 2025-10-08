require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder?.('ipv4first');

const path = require('path');
const express = require('express');

const { applySecurity } = require('./middleware/security');
const stripeRoutes = require('./routes/stripe.routes');
const n8nRoutes = require('./routes/n8n.routes');
const accountRoutes = require('./routes/account.routes');
const searchesRoutes = require('./routes/searches.routes');

const app = express();

/* Trust proxy headers (needed for correct IPs/rate-limit behind Cloudflare/Traefik) */
app.set('trust proxy', 1);

/* 1) Give Stripe webhook a raw body BEFORE any JSON parsing */
app.use('/api/stripe/webhook', express.raw({ type: '*/*' }));

/* 2) Security middlewares (Helmet, CORS, rate limit, xss-clean, etc.) */
applySecurity(app);

/* 3) Static files (local dev only; in prod you likely serve via CDN/static host) */
app.use(express.static(path.join(__dirname, '..', 'public')));

/* 4) Parse JSON for all requests EXCEPT the Stripe webhook */
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  return express.json()(req, res, next);
});

/* 5) Health check */
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

/* 6) Routers */
app.use('/api/stripe', stripeRoutes);
app.use('/api/n8n', n8nRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/searches', searchesRoutes);

/* 7) Centralized error handler */
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

/* 8) Render/infra health */
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

module.exports = app;
