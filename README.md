# Gatecraher — Public Web + Proxy

## Deploy (Render)
1) Push this folder to a new GitHub repo: `gatecraher-public`.
2) Go to https://render.com → New + → Web Service → Connect the repo.
3) Environment: Node 18+. Build Command: `npm install`. Start Command: `npm start`.
4) Add env var: `N8N_WEBHOOK_URL` = **Production** webhook URL from your n8n Form Trigger.
5) Deploy. Open the public URL. Paste a JD. Run.

## Get n8n Production URL
- In n8n Cloud open your workflow.
- Open node **On form submission1** (Form Trigger) → **Production URL**. Copy.
- That URL is your `N8N_WEBHOOK_URL`.

## Local run
```
npm install
N8N_WEBHOOK_URL=https://YOUR-SUBDOMAIN.n8n.cloud/webhook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx npm start
# then open http://localhost:3000
```

## Notes
- Field labels/IDs must remain: `JD`, `Save to the doc file and the spreadsheet? (+10 sec)`, `Region to search (Candidates)`.
- Save is always sent as `No`.
- The page renders the HTML returned by your final Form node (5 HR + 6 JH links).
- On failure, the raw error text from n8n is shown.
