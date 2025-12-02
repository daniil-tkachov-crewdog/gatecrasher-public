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

app.set('trust proxy', 1);

// Raw body for Stripe webhook signature verification
app.use('/api/stripe/webhook', express.raw({ type: '*/*' }));
app.use('/api/stripe/webhook-test', express.raw({ type: '*/*' }));

applySecurity(app);

app.use(express.static(path.join(__dirname, '..', 'public')));

// JSON parser (skip webhook routes)
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook' || req.originalUrl === '/api/stripe/webhook-test') {
    return next();
  }
  return express.json({ limit: '1mb' })(req, res, next);
});

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.use('/api/stripe', stripeRoutes);
app.use('/api/n8n', n8nRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/searches', searchesRoutes);

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

module.exports = app;
