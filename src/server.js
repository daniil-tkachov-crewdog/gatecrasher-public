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

// Apply security middlewares (Helmet, CORS, rate limit, xss-clean)
applySecurity(app);

// Serve static files (only useful for local dev; in prod use Render static site)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Parse JSON for all requests except Stripe webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  return express.json()(req, res, next);
});

// Health check endpoint
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Mount routers
app.use('/api/stripe', stripeRoutes);
app.use('/api/n8n', n8nRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/searches', searchesRoutes);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

// Render health check
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});

module.exports = app;
