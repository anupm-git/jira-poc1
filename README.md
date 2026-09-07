# Jira Governance + Resend Cloudflare Worker

This Worker is the backend for the Jira Executive Governance dashboard's Daily/Weekly report automation.

## What it does

- Fetches Jira server-side, so the scheduled job does not depend on the dashboard browser being open.
- Calculates Due Today / This Week / Next Week, throughput, overdue, blocked, aging, risks and dependency counts.
- Generates responsive-ish HTML email reports.
- Sends through Resend's REST API.
- Runs automatically with Cloudflare Cron.
- Exposes authenticated `/report`, `/report/send`, and `/report/preview` endpoints.

Cloudflare Cron executes in UTC. The included schedules are:
- `15 3 * * *` = 09:15 IST daily
- `30 3 * * 1` = 09:30 IST Monday

Change these in `wrangler.jsonc` if required.

## 1. Install

```bash
npm install -D wrangler
npx wrangler login
```

## 2. Set secrets

Do NOT put Jira tokens or Resend keys in `wrangler.jsonc` or source control. Cloudflare recommends Worker Secrets for API keys/tokens.

```bash
npx wrangler secret put JIRA_BASE_URL
npx wrangler secret put JIRA_EMAIL
npx wrangler secret put JIRA_API_TOKEN
npx wrangler secret put JIRA_JQL
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put REPORT_ADMIN_KEY
npx wrangler secret put REPORT_FROM
npx wrangler secret put REPORT_RECIPIENTS
```

`REPORT_FROM` must use a sender/domain that Resend allows for your account. For production, verify your sending domain in Resend.

## 3. Deploy

```bash
npx wrangler deploy
```

Cloudflare Cron changes can take several minutes to propagate.

## 4. Test

Health:

```bash
curl https://YOUR-WORKER.workers.dev/health
```

Send a daily report:

```bash
curl -X POST https://YOUR-WORKER.workers.dev/report/send \
  -H "Authorization: Bearer YOUR_REPORT_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"daily","recipients":["you@company.com"]}'
```

Preview:

```bash
curl -X POST https://YOUR-WORKER.workers.dev/report/preview \
  -H "Authorization: Bearer YOUR_REPORT_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"weekly"}'
```

## 5. Connect the current dashboard

In **Overview → Report & Email Automation**, set the endpoint to:

`https://YOUR-WORKER.workers.dev/report`

The current dashboard already POSTs `{type, recipients, subject, html, metrics, schedule}`. The Worker deliberately regenerates the report from Jira server-side, so scheduled and manual reports use the same backend calculation and do not depend on browser state.

For production, add the Worker URL as the only `ALLOWED_ORIGIN` in `wrangler.jsonc` if the dashboard is hosted on a fixed origin.

## Important Jira note

The Worker uses Jira REST `/rest/api/2/search`. If your Jira Cloud tenant only permits the newer API shape, adapt `fetchAllJiraIssues()` to `/rest/api/3/search`. The dashboard's existing proxy uses the same general Jira search model, so this is straightforward to change if needed.
