require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || "jira_governance";
const API_KEY = process.env.API_KEY || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI environment variable.");
  process.exit(1);
}

app.use(cors({
  origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map(x => x.trim()),
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-API-Key"]
}));
app.use(express.json({ limit: "25mb" }));

function authorize(req, res, next) {
  if (!API_KEY) return next();
  if (req.get("X-API-Key") !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

let client;
let db;
let snapshots;
let issues;

async function connectMongo() {
  client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10000
  });
  await client.connect();
  db = client.db(DB_NAME);
  snapshots = db.collection("jira_snapshots");
  issues = db.collection("jira_issues");

  await snapshots.createIndex({ fetchedAt: -1 });
  await issues.createIndex({ jiraUrl: 1, key: 1 }, { unique: true });
  await issues.createIndex({ snapshotId: 1 });
}

app.get("/health", async (_req, res) => {
  try {
    await db.command({ ping: 1 });
    res.json({ ok: true, database: DB_NAME });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.post("/api/jira/snapshot", authorize, async (req, res) => {
  try {
    const body = req.body || {};
    const jiraUrl = String(body.jiraUrl || "").replace(/\/$/, "");
    const jql = String(body.jql || "");
    const fetchedAt = body.fetchedAt ? new Date(body.fetchedAt) : new Date();
    const rawIssues = Array.isArray(body.rawIssues) ? body.rawIssues : [];
    const normalized = Array.isArray(body.issues) ? body.issues : [];

    if (!jiraUrl) return res.status(400).json({ error: "jiraUrl is required" });
    if (rawIssues.length !== normalized.length && normalized.length !== 0) {
      return res.status(400).json({
        error: `rawIssues (${rawIssues.length}) and issues (${normalized.length}) must have the same length`
      });
    }

    const snapshotId = `${jiraUrl}|${fetchedAt.toISOString()}|${Math.random().toString(36).slice(2, 8)}`;

    const operations = normalized.map((item, idx) => {
      const raw = rawIssues[idx] || null;
      const key = String(item.key || raw?.key || `UNKNOWN-${idx}`);
      return {
        replaceOne: {
          filter: { jiraUrl, key },
          replacement: {
            jiraUrl,
            key,
            snapshotId,
            fetchedAt,
            normalized: item,
            raw
          },
          upsert: true
        }
      };
    });

    if (operations.length) {
      await issues.bulkWrite(operations, { ordered: false });
    }

    const summary = {
      snapshotId,
      source: "jira",
      jiraUrl,
      jql,
      fetchedAt,
      issueCount: normalized.length,
      storedAt: new Date()
    };

    await snapshots.insertOne(summary);

    res.json({
      ok: true,
      snapshotId,
      storedIssues: operations.length,
      database: DB_NAME,
      collections: {
        snapshots: "jira_snapshots",
        issues: "jira_issues"
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/jira/latest", authorize, async (req, res) => {
  try {
    const jiraUrl = String(req.query.jiraUrl || "").replace(/\/$/, "");
    const latest = await snapshots.find(jiraUrl ? { jiraUrl } : {})
      .sort({ fetchedAt: -1 })
      .limit(1)
      .next();

    if (!latest) return res.status(404).json({ error: "No Jira snapshot found" });

    const includeIssues = req.query.includeIssues === "1";
    const result = { snapshot: latest };

    if (includeIssues) {
      result.issues = await issues.find({ snapshotId: latest.snapshotId }).toArray();
    }

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

process.on("SIGINT", async () => {
  try { if (client) await client.close(); } finally { process.exit(0); }
});
process.on("SIGTERM", async () => {
  try { if (client) await client.close(); } finally { process.exit(0); }
});

connectMongo()
  .then(() => app.listen(PORT, () => {
    console.log(`Jira Mongo API listening on http://localhost:${PORT}`);
  }))
  .catch(err => {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  });
