/**
 * Jira Governance Report Worker
 * Cloudflare Workers + Resend
 *
 * Responsibilities:
 * - Fetch Jira data server-side (no browser CORS dependency)
 * - Calculate executive KPIs
 * - Generate Daily / Weekly HTML reports
 * - Send through Resend
 * - Run automatically via Cloudflare Cron
 * - Accept dashboard "Send Now" requests
 *
 * Secrets (set with `wrangler secret put`):
 *   JIRA_BASE_URL
 *   JIRA_EMAIL
 *   JIRA_API_TOKEN
 *   JIRA_JQL
 *   RESEND_API_KEY
 *   REPORT_ADMIN_KEY
 *   REPORT_FROM
 *   REPORT_RECIPIENTS
 *
 * Optional vars:
 *   JIRA_FIELDS
 *   TIMEZONE (default Asia/Kolkata)
 */

const DEFAULT_FIELDS = [
  "summary", "status", "assignee", "priority", "created", "updated",
  "resolutiondate", "issuetype", "components", "parent", "issuelinks",
  "duedate", "timetracking"
];

const CRON_DAILY = "15 3 * * *";   // 09:15 IST
const CRON_WEEKLY = "30 3 * * 1";  // Monday 09:30 IST

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/health") {
        return json({ ok: true, service: "jira-governance-email-worker", now: new Date().toISOString() }, 200, cors);
      }

      if (url.pathname === "/report/send" && request.method === "POST") {
        requireAdmin(request, env);
        const body = await request.json().catch(() => ({}));
        const type = body.type === "weekly" ? "weekly" : "daily";
        const recipients = normalizeRecipients(body.recipients || env.REPORT_RECIPIENTS || "");
        if (!recipients.length) throw new Error("No recipients configured.");
        const metrics = await collectMetrics(env, type);
        const html = buildReportHtml(metrics, type, env);
        const result = await sendWithResend(env, {
          to: recipients,
          subject: reportSubject(type, metrics),
          html
        });
        return json({ ok: true, type, recipients, result, generatedAt: metrics.generatedAt }, 200, cors);
      }

      if (url.pathname === "/report/preview" && request.method === "POST") {
        requireAdmin(request, env);
        const body = await request.json().catch(() => ({}));
        const type = body.type === "weekly" ? "weekly" : "daily";
        const metrics = await collectMetrics(env, type);
        return new Response(buildReportHtml(metrics, type, env), {
          status: 200,
          headers: { ...cors, "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // Compatibility endpoint for the current dashboard's existing Send Now button.
      // The dashboard posts { type, recipients, subject, html, ... } here.
      if (url.pathname === "/report" && request.method === "POST") {
        requireAdmin(request, env);
        const body = await request.json().catch(() => ({}));
        const recipients = normalizeRecipients(body.recipients || env.REPORT_RECIPIENTS || "");
        if (!recipients.length) throw new Error("No recipients configured.");

        // Prefer server-generated report data. If the dashboard sends a generated
        // HTML snapshot, it is accepted only as a fallback for UI compatibility.
        const type = body.type === "weekly" ? "weekly" : "daily";
        let html = body.html;
        let metrics = null;
        try {
          metrics = await collectMetrics(env, type);
          html = buildReportHtml(metrics, type, env);
        } catch (e) {
          if (!html) throw e;
        }

        const result = await sendWithResend(env, {
          to: recipients,
          subject: body.subject || reportSubject(type, metrics || { today: new Date().toISOString().slice(0, 10) }),
          html
        });
        return json({ ok: true, sent: true, type, recipients, result }, 200, cors);
      }

      return json({ ok: false, error: "Not found" }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: err?.message || String(err) }, 400, cors);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller, env));
  }
};

async function runScheduled(controller, env) {
  const cron = controller.cron;
  let type = "daily";
  if (cron === CRON_WEEKLY) type = "weekly";
  else if (cron !== CRON_DAILY) return;

  const recipients = normalizeRecipients(env.REPORT_RECIPIENTS || "");
  if (!recipients.length) throw new Error("REPORT_RECIPIENTS is not configured.");

  const metrics = await collectMetrics(env, type);
  const html = buildReportHtml(metrics, type, env);
  await sendWithResend(env, {
    to: recipients,
    subject: reportSubject(type, metrics),
    html
  });
}

function requireAdmin(request, env) {
  const configured = String(env.REPORT_ADMIN_KEY || "").trim();
  if (!configured) throw new Error("REPORT_ADMIN_KEY is not configured.");
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!supplied || !timingSafeEqual(supplied, configured)) throw new Error("Unauthorized");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function collectMetrics(env, type) {
  const issues = await fetchAllJiraIssues(env);
  const now = new Date();
  const today = dateKey(now);
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 7);
  const nextWeekEnd = addDays(today, 14);

  const done = issues.filter(isDone);
  const open = issues.filter(i => !isDone(i));
  const overdue = open.filter(i => i.dueDate && i.dueDate < today);
  const dueToday = open.filter(i => i.dueDate === today).sort(issueRank);
  const dueWeek = open.filter(i => i.dueDate && i.dueDate >= today && i.dueDate <= weekEnd).sort(issueRank);
  const dueNextWeek = open.filter(i => i.dueDate && i.dueDate > weekEnd && i.dueDate <= nextWeekEnd).sort(issueRank);
  const blocked = issues.filter(isBlocked);
  const unassigned = open.filter(i => !i.assignee);
  const critical = [...overdue, ...blocked, ...dueToday.filter(i => !isStarted(i))].filter(uniqueByKey()).length;

  const periodDays = type === "weekly" ? 7 : 1;
  const completedPeriod = done.filter(i => i.resolvedDate && i.resolvedDate >= addDays(today, -periodDays + 1));
  const createdPeriod = issues.filter(i => i.created && i.created >= addDays(today, -periodDays + 1));

  const throughputWeeks = [];
  for (let n = 7; n >= 0; n--) {
    const end = addDays(today, -n * 7);
    const start = addDays(end, -6);
    const count = done.filter(i => i.resolvedDate && i.resolvedDate >= start && i.resolvedDate <= end).length;
    throughputWeeks.push({ label: start.slice(5) + "–" + end.slice(5), completed: count });
  }

  const riskRows = [...overdue, ...blocked, ...dueToday.filter(i => !isStarted(i)), ...dueWeek.filter(i => i.priority === "Highest" || i.priority === "High")]
    .filter(uniqueByKey()).sort(riskRank).slice(0, 10);

  const aging = { "0-3": 0, "4-7": 0, "8-14": 0, "15-30": 0, "30+": 0 };
  open.forEach(i => {
    const age = daysBetween(i.created, today);
    if (age <= 3) aging["0-3"]++;
    else if (age <= 7) aging["4-7"]++;
    else if (age <= 14) aging["8-14"]++;
    else if (age <= 30) aging["15-30"]++;
    else aging["30+"]++;
  });

  const dependencies = computeDependencies(issues);
  const completedThisWeek = done.filter(i => i.resolvedDate && i.resolvedDate >= addDays(today, -6)).length;
  const createdThisWeek = issues.filter(i => i.created && i.created >= addDays(today, -6)).length;
  const netBacklogThisWeek = createdThisWeek - completedThisWeek;

  return {
    generatedAt: now.toISOString(), today, type,
    total: issues.length, open: open.length, completed: done.length,
    completedToday: done.filter(i => i.resolvedDate === today).length,
    completedPeriod: completedPeriod.length, createdPeriod: createdPeriod.length,
    completedThisWeek, createdThisWeek, netBacklogThisWeek,
    overdue: overdue.length, blocked: blocked.length, unassigned: unassigned.length,
    dueToday: dueToday.slice(0, 10), dueWeek: dueWeek.slice(0, 10), dueNextWeek: dueNextWeek.slice(0, 10),
    dueTodayTotal: dueToday.length, dueWeekTotal: dueWeek.length, dueNextWeekTotal: dueNextWeek.length,
    critical, atRisk: riskRows.length, onTrack: Math.max(0, open.length - riskRows.length),
    throughputAvg: Math.round((throughputWeeks.reduce((a, x) => a + x.completed, 0) / 8) * 10) / 10,
    throughputWeeks, aging, riskRows, dependencies,
    topOverdue: overdue.sort(riskRank).slice(0, 10),
    topAging: open.map(i => ({ ...i, age: daysBetween(i.created, today) })).sort((a,b) => b.age-a.age).slice(0, 10),
    capacity: null
  };
}

async function fetchAllJiraIssues(env) {
  const base = String(env.JIRA_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("JIRA_BASE_URL is not configured.");
  if (!env.JIRA_EMAIL || !env.JIRA_API_TOKEN) throw new Error("Jira credentials are not configured.");

  const jql = env.JIRA_JQL || "ORDER BY updated DESC";
  const fields = env.JIRA_FIELDS || DEFAULT_FIELDS.join(",");
  const auth = btoa(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`);
  const out = [];
  let startAt = 0;
  const maxResults = 100;

  for (let page = 0; page < 50; page++) {
    const url = `${base}/rest/api/2/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=${encodeURIComponent(fields)}`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Jira search failed: HTTP ${res.status} ${await res.text()}`);
    const data = await res.json();
    for (const raw of data.issues || []) out.push(normalizeJiraIssue(raw));
    startAt += (data.issues || []).length;
    if (!data.issues?.length || startAt >= (data.total || 0)) break;
  }
  return out;
}

function normalizeJiraIssue(raw) {
  const f = raw.fields || {};
  const status = f.status?.name || "";
  const type = f.issuetype?.name || "";
  const priority = f.priority?.name || "";
  const assignee = f.assignee?.displayName || f.assignee?.name || "";
  const resolvedDate = (f.resolutiondate || "").slice(0, 10);
  const dueDate = (f.duedate || "").slice(0, 10);
  const created = (f.created || "").slice(0, 10);
  const summary = f.summary || "";
  const links = Array.isArray(f.issuelinks) ? f.issuelinks : [];
  return {
    key: raw.key || "", summary, status, statusCategory: f.status?.statusCategory?.key || "",
    type, priority, assignee, dueDate, created, resolvedDate,
    points: Number(f.customfield_10016 || 0) || 0,
    links
  };
}

function computeDependencies(issues) {
  const rows = [];
  const seen = new Set();
  for (const source of issues) {
    for (const link of source.links || []) {
      const t = link.type || {};
      if (link.outwardIssue) {
        const type = String(t.outward || t.name || "Linked to").toLowerCase();
        if (["blocks", "depends on", "relates to"].includes(type)) add(source, link.outwardIssue, "outbound", t.outward || t.name);
      }
      if (link.inwardIssue) {
        const type = String(t.inward || t.name || "Linked to").toLowerCase();
        if (["is blocked by", "is depended on by", "relates to"].includes(type)) add(source, link.inwardIssue, "inbound", t.inward || t.name);
      }
    }
  }
  function add(source, linked, direction, dependencyType) {
    if (!linked?.key || linked.key === source.key) return;
    const id = `${source.key}|${dependencyType}|${linked.key}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ sourceKey: source.key, sourceSummary: source.summary, direction, dependencyType, linkedKey: linked.key, linkedSummary: linked.fields?.summary || "" });
  }
  return {
    total: rows.length,
    outbound: rows.filter(r => r.direction === "outbound").length,
    inbound: rows.filter(r => r.direction === "inbound").length,
    blocked: rows.filter(r => r.dependencyType === "blocks" || r.dependencyType === "is blocked by").length,
    rows: rows.slice(0, 100)
  };
}

function buildReportHtml(m, type, env) {
  const weekly = type === "weekly";
  const health = m.critical > 0 ? "AT RISK" : "ON TRACK";
  const healthSymbol = m.critical > 0 ? "🔴" : "🟢";
  const title = weekly ? "Weekly Executive Delivery Report" : "Daily Jira Delivery Report";
  const periodText = weekly ? "Previous 7 days + upcoming delivery radar" : "Daily delivery control tower";

  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#202124">
  <div style="max-width:960px;margin:0 auto;background:#fff">
    <div style="padding:22px 24px;background:#24215f;color:#fff"><div style="font-size:12px;opacity:.8">JIRA GOVERNANCE</div><h1 style="margin:5px 0 4px;font-size:24px">${esc(title)}</h1><div style="font-size:13px;opacity:.9">${esc(periodText)} · ${esc(m.today)}</div></div>
    <div style="padding:20px 24px"><div style="font-size:18px;font-weight:800">${healthSymbol} Executive Health: ${health}</div>
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:14px">${kpi("Open",m.open)}${kpi("Completed",m.completedPeriod)}${kpi("Throughput/wk",m.throughputAvg)}${kpi("Due today",m.dueTodayTotal)}${kpi("Overdue",m.overdue)}${kpi("Blocked",m.blocked)}</div>
    <h2>Delivery Due Radar</h2>${dueCards(m)}
    <h2>Delivery Performance</h2><p><b>Created:</b> ${m.createdThisWeek} &nbsp; <b>Completed:</b> ${m.completedThisWeek} &nbsp; <b>Net backlog:</b> ${m.netBacklogThisWeek >= 0 ? "+" : ""}${m.netBacklogThisWeek}</p>
    <h2>Top Risks</h2>${issueTable(m.riskRows)}
    <h2>Aging Work</h2>${agingTable(m.aging)}
    <h2>Dependency Health</h2><p><b>${m.dependencies.total}</b> total · ${m.dependencies.outbound} outbound · ${m.dependencies.inbound} inbound · ${m.dependencies.blocked} blocking</p>
    <h2>What Changed</h2><p>Completed <b>${m.completedThisWeek}</b> · Created <b>${m.createdThisWeek}</b> · Net backlog <b>${m.netBacklogThisWeek >= 0 ? "+" : ""}${m.netBacklogThisWeek}</b></p>
    <p style="font-size:11px;color:#777;border-top:1px solid #ddd;padding-top:12px">Generated automatically by Jira Governance Worker. Snapshot: ${esc(m.generatedAt)}.</p></div></div></body></html>`;
}

function kpi(label, value) { return `<div style="border:1px solid #ddd;border-radius:8px;padding:10px"><div style="font-size:10px;color:#777">${label}</div><div style="font-size:20px;font-weight:800;margin-top:3px">${value}</div></div>`; }
function dueCards(m) { return `<table width="100%" cellpadding="0" cellspacing="0"><tr><td width="33%" valign="top" style="padding-right:6px">${dueCard("Due Today",m.dueTodayTotal,m.dueToday)}</td><td width="33%" valign="top" style="padding:0 3px">${dueCard("This Week",m.dueWeekTotal,m.dueWeek)}</td><td width="33%" valign="top" style="padding-left:6px">${dueCard("Next Week",m.dueNextWeekTotal,m.dueNextWeek)}</td></tr></table>`; }
function dueCard(title,total,rows) { return `<div style="border:1px solid #ddd;border-radius:8px;padding:10px"><div style="font-size:11px;color:#777">${title}</div><div style="font-size:26px;font-weight:800;margin-bottom:8px">${total}</div>${rows.map(i=>`<div style="padding:6px 0;border-top:1px solid #eee"><b>${esc(i.key)}</b> ${esc(i.summary)}</div>`).join("") || `<div style="color:#777;font-size:12px">No open issues.</div>`}</div>`; }
function issueTable(rows) { if(!rows.length) return `<p style="color:#777">No critical risks detected.</p>`; return `<table width="100%" cellpadding="7" cellspacing="0" style="border-collapse:collapse;font-size:12px"><tr style="background:#f3f4f6"><th align="left">Issue</th><th align="left">Summary</th><th align="left">Status</th><th align="left">Due</th><th align="left">Owner</th></tr>${rows.map(i=>`<tr><td style="border-bottom:1px solid #eee"><b>${esc(i.key)}</b></td><td style="border-bottom:1px solid #eee">${esc(i.summary)}</td><td style="border-bottom:1px solid #eee">${esc(i.status)}</td><td style="border-bottom:1px solid #eee">${esc(i.dueDate || "-")}</td><td style="border-bottom:1px solid #eee">${esc(i.assignee || "Unassigned")}</td></tr>`).join("")}</table>`; }
function agingTable(a) { return `<table width="100%" cellpadding="7" cellspacing="0" style="border-collapse:collapse;font-size:12px"><tr>${Object.entries(a).map(([k,v])=>`<td style="border:1px solid #eee"><div style="color:#777">${k} days</div><b style="font-size:18px">${v}</b></td>`).join("")}</tr></table>`; }

async function sendWithResend(env, {to, subject, html}) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured.");
  const from = env.REPORT_FROM || "Jira Governance <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Resend failed: HTTP ${res.status} ${data.message || JSON.stringify(data)}`);
  return data;
}

function reportSubject(type, m) { return `Jira ${type === "weekly" ? "Weekly Executive" : "Daily Delivery"} Report — ${m.today}`; }
function normalizeRecipients(value) { return Array.isArray(value) ? value.map(String).map(s=>s.trim()).filter(Boolean) : String(value).split(",").map(s=>s.trim()).filter(Boolean); }
function isDone(i) { return i.statusCategory === "done" || /^(done|closed|resolved|complete|completed)$/i.test(i.status); }
function isBlocked(i) { return /block/i.test(i.status) || /block/i.test(i.summary); }
function isStarted(i) { return !/^(to do|open|backlog|new|selected for development)$/i.test(i.status); }
function issueRank(a,b) { return priorityScore(b.priority)-priorityScore(a.priority) || (a.dueDate||"9999").localeCompare(b.dueDate||"9999"); }
function riskRank(a,b) { return priorityScore(b.priority)-priorityScore(a.priority) || (a.dueDate||"9999").localeCompare(b.dueDate||"9999") || b.key.localeCompare(a.key); }
function priorityScore(p) { return ({Highest:5,Blocker:5,High:4,Medium:3,Low:2,Lowest:1}[p] || 0); }
function uniqueByKey() { const seen=new Set(); return i=>{if(seen.has(i.key))return false;seen.add(i.key);return true;}; }
function dateKey(d) { return new Date(d).toISOString().slice(0,10); }
function addDays(key,n) { const d=new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); }
function daysBetween(a,b) { if(!a)return 0; return Math.max(0,Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000)); }
function esc(v) { return String(v ?? "").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function json(data,status,headers={}) { return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8",...headers}}); }
function corsHeaders(request, env) {
  const origin=request.headers.get("Origin")||"*";
  const allowed=env.ALLOWED_ORIGIN||"*";
  return {"Access-Control-Allow-Origin":allowed==="*"?"*":origin,"Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Vary":"Origin"};
}
