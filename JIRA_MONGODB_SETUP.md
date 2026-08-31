# Jira Dashboard + MongoDB integration

## What was changed

The supplied `jira-dashboard-final.html` was extended without removing the existing Gantt, Jira Hygiene, Sprint Insights, portfolio and AI functionality.

### Landing page
A new 6-tile governance section is placed at the top of the landing page, matching the supplied screenshot's dark tile style:

1. Stories without parent
2. Stories without story points
3. Stories without sprint
4. Stories without assignee
5. Stuck in "New"/To Do 30+ days
6. Status: New → Closed

The tile counts are calculated from the same normalized Jira dataset already used by the existing dashboard. Clicking a tile opens the existing issue list modal; "View JQL" expands the corresponding JQL.

### MongoDB
The browser does **not** contain a MongoDB server or a MongoDB connection string. The HTML calls a small backend API. The backend uses the official MongoDB Node.js driver and stores:

- `jira_snapshots`: one document per Jira sync
- `jira_issues`: one document per Jira issue, containing both the normalized dashboard object and the original Jira issue payload

This avoids putting MongoDB credentials in browser code.

## Setup

1. Create a MongoDB Atlas cluster and database user.
2. Copy `.env.example` to `.env`.
3. Put the Atlas connection string in `MONGODB_URI`.
4. Set `CORS_ORIGIN` to the URL serving the HTML.
5. Install and start:

```bash
npm install
npm start
```

6. Serve the HTML from a web server (for example VS Code Live Server) rather than opening it with `file://`.
7. Open **⚙ Data Connections** in the dashboard and set:

`MongoDB API URL = http://localhost:3000`

8. Configure Jira as before and click **Sync All Tabs**.

Every successful Jira sync will save the complete fetched issue payload to MongoDB. If MongoDB is unavailable, the dashboard continues to work and shows an error toast rather than failing the Jira refresh.

## Production

Deploy `server.js` to a small Node service (Render, Railway, Fly.io, Azure App Service, AWS, etc.), set the environment variables there, and use the HTTPS API URL in the dashboard.

Do not put `MONGODB_URI`, a MongoDB username/password, or an Atlas admin API key in the HTML.

## API

- `GET /health`
- `POST /api/jira/snapshot`
- `GET /api/jira/latest`
- Add `X-API-Key` when `API_KEY` is configured.
