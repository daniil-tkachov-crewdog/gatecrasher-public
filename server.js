// Node 18+ required (built-in fetch).
import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve static site
app.use(express.static(path.join(__dirname, 'public')));

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL; // e.g. https://YOUR-SUBDOMAIN.n8n.cloud/webhook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
if (!N8N_WEBHOOK_URL) console.warn('Missing N8N_WEBHOOK_URL');

app.post('/api/gatecraher', async (req, res) => {
  try {
    const { JD, ['Save to the doc file and the spreadsheet? (+10 sec)']: saveFlag, ['Region to search (Candidates)']: region } = req.body || {};
    if (!JD || !JD.trim()) return res.status(400).json({ error: 'JD is required' });

    // Always send Save = "No"
    const payload = {
      JD: JD.trim(),
      'Save to the doc file and the spreadsheet? (+10 sec)': 'No',
      'Region to search (Candidates)': region || 'Western Europe',
    };

    const r = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text);
    res.type('text/html').send(text);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Root route -> serve index.html
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Gatecraher live on :${port}`));
