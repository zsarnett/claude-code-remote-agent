const express = require("express");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const PORT = 7777;
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const LOGS_DIR = path.join(CLAUDE_DIR, "logs");
const CHANNEL_MAP_PATH = path.join(
  CLAUDE_DIR,
  "channels",
  "discord",
  "channel-map.json"
);
const HEARTBEAT_PATH = process.env.HEARTBEAT_PATH || path.join(
  HOME,
  "HEARTBEAT.md"
);
const SECOND_BRAIN_DIR = process.env.SECOND_BRAIN_DIR || path.join(
  HOME,
  "SecondBrain"
);

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

function run(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function getTmuxSessions() {
  const raw = run(
    'tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}|#{session_windows}|#{pane_current_path}" 2>/dev/null'
  );
  if (!raw) return [];

  // Load channel map to resolve session -> discord channel
  let channelMap = {};
  try {
    const cm = JSON.parse(fs.readFileSync(CHANNEL_MAP_PATH, "utf-8"));
    for (const [chId, info] of Object.entries(cm.channels || {})) {
      channelMap[info.name] = { channelId: chId, dir: info.dir };
    }
  } catch {}

  return raw
    .split("\n")
    .filter((l) => l.includes("claude"))
    .map((line) => {
      const [name, created, attached, windows, cwd] = line.split("|");
      const createdDate = new Date(parseInt(created, 10) * 1000);
      const uptimeMs = Date.now() - createdDate.getTime();
      const hours = Math.floor(uptimeMs / 3600000);
      const minutes = Math.floor((uptimeMs % 3600000) / 60000);
      const projectName = name.replace("claude-", "");
      const isHub = projectName === "agent";
      const channelInfo = channelMap[projectName] || null;
      // Capture last 15 lines of the tmux pane
      let lastOutput = "";
      try {
        lastOutput = run(
          `tmux capture-pane -t "${name}" -p -S -15 2>/dev/null`
        );
      } catch {}

      return {
        name,
        role: isHub ? "hub" : "project",
        project: isHub ? null : projectName,
        discordChannel: channelInfo ? "#" + projectName : isHub ? "#hub" : null,
        dir: cwd || (channelInfo ? channelInfo.dir : null),
        created: createdDate.toISOString(),
        attached: attached === "1",
        windows: parseInt(windows, 10) || 0,
        uptime: hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`,
        lastOutput: lastOutput || "(empty)",
      };
    });
}

function getSystemStats() {
  // CPU -- use vm_stat + sysctl on macOS
  let cpuUsage = "N/A";
  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  cpuUsage = `${((loadAvg[0] / cpuCount) * 100).toFixed(1)}%`;

  // Memory -- use vm_stat for accurate active+wired (macOS counts inactive as "used" otherwise)
  const totalMem = os.totalmem();
  let usedMem, memPercent;
  const vmStat = run("vm_stat");
  if (vmStat) {
    const pageSize = 16384;
    const active = parseInt((vmStat.match(/Pages active:\s+(\d+)/) || [])[1] || "0");
    const wired = parseInt((vmStat.match(/Pages wired down:\s+(\d+)/) || [])[1] || "0");
    usedMem = (active + wired) * pageSize;
    memPercent = ((usedMem / totalMem) * 100).toFixed(1);
  } else {
    const freeMem = os.freemem();
    usedMem = totalMem - freeMem;
    memPercent = ((usedMem / totalMem) * 100).toFixed(1);
  }

  // Disk
  let diskUsage = { used: "N/A", total: "N/A", percent: "N/A" };
  const dfOut = run("df -h / | tail -1");
  if (dfOut) {
    const parts = dfOut.split(/\s+/);
    diskUsage = {
      total: parts[1] || "N/A",
      used: parts[2] || "N/A",
      available: parts[3] || "N/A",
      percent: parts[4] || "N/A",
    };
  }

  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cpuCount,
    loadAverage: loadAvg.map((l) => l.toFixed(2)),
    cpuUsage,
    memory: {
      total: formatBytes(totalMem),
      used: formatBytes(usedMem),
      free: formatBytes(totalMem - usedMem),
      percent: memPercent,
    },
    disk: diskUsage,
    uptime: formatUptime(os.uptime()),
  };
}

function getDiscordChannelMap() {
  try {
    const raw = fs.readFileSync(CHANNEL_MAP_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getCronJobs() {
  const raw = run("crontab -l 2>/dev/null");
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((line) => ({ schedule: line }));
}

function getLogFiles() {
  try {
    return fs
      .readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const full = path.join(LOGS_DIR, f);
        const stat = fs.statSync(full);
        return { name: f, path: full, modified: stat.mtime.toISOString() };
      });
  } catch {
    return [];
  }
}

function getRecentActivity() {
  const logFiles = getLogFiles();
  const lines = [];
  for (const lf of logFiles) {
    try {
      const content = fs.readFileSync(lf.path, "utf-8");
      const fileLines = content.split("\n").filter(Boolean);
      const last = fileLines.slice(-20);
      for (const l of last) {
        lines.push({ source: lf.name, line: l });
      }
    } catch {
      // skip unreadable
    }
  }
  // Return last 20 overall, newest first
  return lines.slice(-20).reverse();
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// SecondBrain helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const raw = match[1];
  const body = match[2].trim();
  const meta = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    // Parse array values like [a, b, c]
    if (val.startsWith("[") && val.endsWith("]")) {
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    meta[m[1]] = val;
  }
  return { meta, body };
}

function readBrainFiles(dir, folder) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs, node_modules, docs
      if (
        entry.name.startsWith(".") ||
        entry.name === "node_modules" ||
        entry.name === "docs"
      ) {
        continue;
      }
      results.push(...readBrainFiles(fullPath, folder || entry.name));
    } else if (entry.name.endsWith(".md") && entry.name !== "CLAUDE.md" && entry.name !== "Today.md") {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const { meta, body } = parseFrontmatter(content);
        results.push({
          file: entry.name,
          folder: folder || "_root",
          path: fullPath,
          ...meta,
          body,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
  return results;
}

function getBrainData() {
  const items = readBrainFiles(SECOND_BRAIN_DIR, null);
  const counts = { active: 0, planning: 0, needs_review: 0, done: 0, inbox: 0 };
  for (const item of items) {
    if (item.folder === "_Inbox") {
      counts.inbox++;
    }
    if (item.status && counts.hasOwnProperty(item.status)) {
      counts[item.status]++;
    }
  }
  return { items, counts };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get("/api/status", (_req, res) => {
  const data = {
    timestamp: new Date().toISOString(),
    sessions: getTmuxSessions(),
    system: getSystemStats(),
    discord: getDiscordChannelMap(),
    cron: getCronJobs(),
    logs: getLogFiles(),
    recentActivity: getRecentActivity(),
  };
  res.json(data);
});

app.get("/api/heartbeat", (_req, res) => {
  try {
    const content = fs.readFileSync(HEARTBEAT_PATH, "utf-8");
    // Parse checklist items
    const items = [];
    const lines = content.split("\n");
    for (const line of lines) {
      const match = line.match(/^- \[([ x])\] \*\*(.+?)\*\*:?\s*(.*)/);
      if (match) {
        items.push({
          checked: match[1] === "x",
          name: match[2],
          description: match[3],
        });
      }
    }
    // Get last heartbeat log entry
    let lastRun = null;
    try {
      const log = fs.readFileSync(path.join(LOGS_DIR, "heartbeat.log"), "utf-8");
      const logLines = log.trim().split("\n").filter(Boolean);
      lastRun = logLines[logLines.length - 1] || null;
    } catch {}
    res.json({ items, lastRun, raw: content });
  } catch {
    res.json({ items: [], lastRun: null, raw: "" });
  }
});

app.get("/api/brain", (_req, res) => {
  res.json(getBrainData());
});

app.get("/api/brain/:id", (req, res) => {
  const { items } = getBrainData();
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  res.json(item);
});

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

app.get("/", (_req, res) => {
  res.send(buildHTML());
});

function buildHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Workstation -- Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --orange: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 16px;
    max-width: 960px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 8px;
  }
  header h1 { font-size: 1.3rem; font-weight: 600; }
  header .meta { font-size: 0.8rem; color: var(--text-dim); }
  .status-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }
  .dot-green { background: var(--green); }
  .dot-orange { background: var(--orange); }
  .dot-red { background: var(--red); }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .card h2 {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
  }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: var(--text-dim); }
  .stat-value { font-weight: 500; font-variant-numeric: tabular-nums; }
  .bar-container {
    width: 100%;
    height: 6px;
    background: var(--surface2);
    border-radius: 3px;
    margin-top: 4px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.5s ease;
  }
  .session-item {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 8px;
  }
  .session-item .name { font-weight: 600; font-size: 0.95rem; }
  .session-item .detail { font-size: 0.8rem; color: var(--text-dim); margin-top: 4px; }
  .session-output {
    margin-top: 8px;
    padding: 8px;
    background: #0d1117;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 0.7rem;
    line-height: 1.4;
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: #8b949e;
  }
  .channel-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.9rem;
    gap: 12px;
    flex-wrap: wrap;
  }
  .channel-row:last-child { border-bottom: none; }
  .channel-name { color: var(--purple); font-weight: 500; }
  .channel-dir {
    color: var(--text-dim);
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 0.8rem;
    word-break: break-all;
  }
  .log-line {
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 0.75rem;
    color: var(--text-dim);
    padding: 3px 0;
    border-bottom: 1px solid var(--border);
    word-break: break-all;
    line-height: 1.4;
  }
  .log-line:last-child { border-bottom: none; }
  .log-source {
    color: var(--orange);
    font-weight: 500;
    margin-right: 8px;
    white-space: nowrap;
  }
  .cron-line {
    font-family: "SF Mono", Monaco, Consolas, monospace;
    font-size: 0.8rem;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    word-break: break-all;
  }
  .cron-line:last-child { border-bottom: none; }
  .btn-group { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 0.85rem;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    font-family: inherit;
  }
  .btn:hover { border-color: var(--accent); background: var(--surface); }
  .btn:active { background: var(--border); }
  .empty { color: var(--text-dim); font-style: italic; font-size: 0.9rem; }
  .refresh-note { text-align: center; color: var(--text-dim); font-size: 0.75rem; padding: 12px 0; }
  nav {
    display: flex;
    gap: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  nav a {
    flex: 1;
    text-align: center;
    padding: 12px 20px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
    transition: background 0.2s, color 0.2s;
    border-right: 1px solid var(--border);
  }
  nav a:last-child { border-right: none; }
  nav a:hover { background: var(--surface2); color: var(--text); }
  nav a.active { background: var(--surface2); color: var(--accent); border-bottom: 2px solid var(--accent); }
  @media (max-width: 600px) {
    body { padding: 10px; }
    .grid { grid-template-columns: 1fr; }
    header h1 { font-size: 1.1rem; }
    nav a { padding: 10px 12px; font-size: 0.8rem; }
  }
</style>
</head>
<body>
  <header>
    <h1>Claude Workstation</h1>
    <div class="meta">
      <span id="last-updated">Loading...</span>
    </div>
  </header>
  <nav>
    <a href="/" class="active">Dashboard</a>
    <a href="/docs">Documentation</a>
    <a href="/brain">Brain</a>
  </nav>

  <div id="dashboard">
    <p class="empty">Loading dashboard data...</p>
  </div>

  <div class="refresh-note">Auto-refreshes every 15 seconds</div>

<script>
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function barColor(pct) {
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--orange)";
  return "var(--green)";
}

function renderSessions(sessions) {
  if (!sessions || sessions.length === 0) {
    return '<p class="empty">No active claude-* tmux sessions found</p>';
  }
  return sessions.map(function(s) {
    var dotClass = s.attached ? "dot-green" : "dot-orange";
    var status = s.attached ? "Attached" : "Detached";
    var roleLabel = s.role === "hub" ? '<span style="color:#58a6ff;font-size:11px;margin-left:6px;">HUB</span>' : '<span style="color:#8b949e;font-size:11px;margin-left:6px;">PROJECT</span>';
    var channelLabel = s.discordChannel ? ' | Discord: ' + escapeHtml(s.discordChannel) : '';
    var dirLabel = s.dir ? ' | Dir: ' + escapeHtml(s.dir.replace(HOME + '/Documents/', '~/')) : '';
    return '<div class="session-item">' +
      '<div class="name"><span class="status-dot ' + dotClass + '"></span>' + escapeHtml(s.name) + roleLabel + '</div>' +
      '<div class="detail">' + status + ' | Uptime: ' + escapeHtml(s.uptime) + channelLabel + dirLabel + '</div>' +
      '<pre class="session-output">' + escapeHtml(s.lastOutput || '(empty)') + '</pre>' +
    '</div>';
  }).join("");
}

function renderSystem(sys) {
  if (!sys) return '<p class="empty">System stats unavailable</p>';
  var memPct = parseFloat(sys.memory.percent) || 0;
  var diskPct = parseFloat(sys.disk.percent) || 0;
  var cpuPct = parseFloat(sys.cpuUsage) || 0;

  return '<div class="grid">' +
    '<div>' +
      '<div class="stat-row"><span class="stat-label">Hostname</span><span class="stat-value">' + escapeHtml(sys.hostname) + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Platform</span><span class="stat-value">' + escapeHtml(sys.platform) + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">System Uptime</span><span class="stat-value">' + escapeHtml(sys.uptime) + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Load Average</span><span class="stat-value">' + sys.loadAverage.join(" / ") + '</span></div>' +
    '</div>' +
    '<div>' +
      '<div class="stat-row"><span class="stat-label">CPU Usage (approx)</span><span class="stat-value">' + escapeHtml(sys.cpuUsage) + '</span></div>' +
      '<div class="bar-container"><div class="bar-fill" style="width:' + cpuPct + '%;background:' + barColor(cpuPct) + '"></div></div>' +
      '<div class="stat-row" style="margin-top:8px"><span class="stat-label">Memory</span><span class="stat-value">' + sys.memory.used + ' / ' + sys.memory.total + ' (' + sys.memory.percent + '%)</span></div>' +
      '<div class="bar-container"><div class="bar-fill" style="width:' + memPct + '%;background:' + barColor(memPct) + '"></div></div>' +
      '<div class="stat-row" style="margin-top:8px"><span class="stat-label">Disk (/)</span><span class="stat-value">' + sys.disk.used + ' / ' + sys.disk.total + ' (' + sys.disk.percent + ')</span></div>' +
      '<div class="bar-container"><div class="bar-fill" style="width:' + diskPct + '%;background:' + barColor(diskPct) + '"></div></div>' +
    '</div>' +
  '</div>';
}

function renderDiscord(discord) {
  if (!discord || !discord.channels) {
    return '<p class="empty">No channel map found at ~/.claude/channels/discord/channel-map.json</p>';
  }
  var ids = Object.keys(discord.channels);
  if (ids.length === 0) return '<p class="empty">No channels configured</p>';
  return ids.map(function(id) {
    var ch = discord.channels[id];
    return '<div class="channel-row">' +
      '<span class="channel-name">#' + escapeHtml(ch.name) + '</span>' +
      '<span class="channel-dir">' + escapeHtml(ch.dir) + '</span>' +
    '</div>';
  }).join("");
}

function renderCron(cron) {
  if (!cron || cron.length === 0) {
    return '<p class="empty">No cron jobs detected</p>';
  }
  return cron.map(function(c) {
    return '<div class="cron-line">' + escapeHtml(c.schedule) + '</div>';
  }).join("");
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    return '<p class="empty">No log files found</p>';
  }
  return logs.map(function(lf) {
    return '<div class="stat-row">' +
      '<span class="stat-label">' + escapeHtml(lf.name) + '</span>' +
      '<span class="stat-value">' + new Date(lf.modified).toLocaleString() + '</span>' +
    '</div>';
  }).join("");
}

function renderActivity(activity) {
  if (!activity || activity.length === 0) {
    return '<p class="empty">No recent activity</p>';
  }
  return activity.map(function(a) {
    return '<div class="log-line"><span class="log-source">[' + escapeHtml(a.source) + ']</span>' + escapeHtml(a.line) + '</div>';
  }).join("");
}

function renderActions() {
  return '<div class="btn-group">' +
    '<button class="btn" disabled>Restart Agent</button>' +
    '<button class="btn" disabled>Create Channel</button>' +
    '<button class="btn" disabled>Run Git Check</button>' +
    '<button class="btn" onclick="fetchData()">Refresh Now</button>' +
  '</div>';
}

function render(data) {
  var html =
    '<div class="card"><h2>Active Sessions</h2>' + renderSessions(data.sessions) + '</div>' +
    '<div class="card"><h2>System Stats</h2>' + renderSystem(data.system) + '</div>' +
    '<div class="card"><h2>Discord Channel Map</h2>' + renderDiscord(data.discord) + '</div>' +
    '<div class="card"><h2>Cron Jobs</h2>' + renderCron(data.cron) + '</div>' +
    '<div class="card"><h2>Log Files</h2>' + renderLogs(data.logs) + '</div>' +
    '<div class="card"><h2>Recent Activity (last 20 lines)</h2>' + renderActivity(data.recentActivity) + '</div>' +
    '<div class="card"><h2>Quick Actions</h2>' + renderActions() + '</div>' +
    '<div class="card" id="heartbeat-card"><h2>Heartbeat</h2><p class="empty">Loading...</p></div>';
  document.getElementById("dashboard").innerHTML = html;
  document.getElementById("last-updated").textContent = "Updated: " + new Date(data.timestamp).toLocaleTimeString();
  fetchHeartbeat();
}

function fetchHeartbeat() {
  fetch("/api/heartbeat")
    .then(function(r) { return r.json(); })
    .then(function(hb) {
      var card = document.getElementById("heartbeat-card");
      if (!card) return;
      var html = '<h2>Heartbeat <span style="font-size:0.7rem;color:var(--text-dim);font-weight:normal;">every 30 min</span></h2>';
      if (hb.lastRun) {
        html += '<div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:8px;">Last: ' + escapeHtml(hb.lastRun.substring(0, 60)) + '</div>';
      }
      if (hb.items && hb.items.length > 0) {
        html += hb.items.map(function(item) {
          var dot = item.checked ? 'color:#3fb950;' : 'color:var(--text-dim);';
          return '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:0.85rem;">' +
            '<span style="' + dot + 'margin-right:6px;">' + (item.checked ? '&#10003;' : '&#9675;') + '</span>' +
            '<strong>' + escapeHtml(item.name) + '</strong>: ' + escapeHtml(item.description) +
          '</div>';
        }).join('');
      } else {
        html += '<p class="empty">No heartbeat checks configured</p>';
      }
      card.innerHTML = html;
    })
    .catch(function() {});
}

function fetchData() {
  fetch("/api/status")
    .then(function(r) { return r.json(); })
    .then(render)
    .catch(function(err) {
      document.getElementById("dashboard").innerHTML = '<p class="empty">Error loading data: ' + escapeHtml(err.message) + '</p>';
    });
}

fetchData();
setInterval(fetchData, 15000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Documentation HTML
// ---------------------------------------------------------------------------

app.get("/docs", (_req, res) => {
  res.send(buildDocsHTML());
});

function buildDocsHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Workstation -- Documentation</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --orange: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    padding: 16px;
    max-width: 960px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 8px;
  }
  header h1 { font-size: 1.3rem; font-weight: 600; }
  header .meta { font-size: 0.8rem; color: var(--text-dim); }
  nav {
    display: flex;
    gap: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  nav a {
    flex: 1;
    text-align: center;
    padding: 12px 20px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
    transition: background 0.2s, color 0.2s;
    border-right: 1px solid var(--border);
  }
  nav a:last-child { border-right: none; }
  nav a:hover { background: var(--surface2); color: var(--text); }
  nav a.active { background: var(--surface2); color: var(--accent); border-bottom: 2px solid var(--accent); }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 20px;
  }
  .card h2 {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 14px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .card h3 {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--purple);
    margin: 16px 0 8px;
  }
  .card p {
    color: var(--text);
    font-size: 0.9rem;
    margin-bottom: 10px;
  }
  .card ul, .card ol {
    margin: 8px 0 12px 20px;
    font-size: 0.9rem;
  }
  .card li {
    margin-bottom: 6px;
    color: var(--text);
  }
  .card li strong { color: var(--accent); }
  .mermaid-wrapper {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 20px;
    margin: 14px 0;
    overflow-x: auto;
  }
  .mermaid {
    display: flex;
    justify-content: center;
  }
  code {
    font-family: "SF Mono", Monaco, Consolas, "Liberation Mono", monospace;
    background: var(--surface2);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.85rem;
    color: var(--orange);
  }
  .file-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
    margin: 10px 0;
  }
  .file-table th {
    text-align: left;
    padding: 8px 10px;
    background: var(--surface2);
    color: var(--accent);
    border-bottom: 2px solid var(--border);
    font-weight: 600;
  }
  .file-table td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .file-table td:first-child {
    font-family: "SF Mono", Monaco, Consolas, monospace;
    color: var(--orange);
    white-space: nowrap;
    font-size: 0.8rem;
  }
  .file-table td:last-child {
    color: var(--text-dim);
  }
  .file-table tr:hover td { background: var(--surface2); }
  .toc {
    margin: 0 0 10px;
    padding: 0;
    list-style: none;
  }
  .toc li {
    margin-bottom: 4px;
  }
  .toc a {
    color: var(--accent);
    text-decoration: none;
    font-size: 0.9rem;
  }
  .toc a:hover { text-decoration: underline; }
  .component-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
    margin: 12px 0;
  }
  .component-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 14px;
  }
  .component-card h4 {
    font-size: 0.9rem;
    color: var(--green);
    margin-bottom: 6px;
  }
  .component-card p {
    font-size: 0.82rem;
    color: var(--text-dim);
    margin: 0;
  }
  @media (max-width: 600px) {
    body { padding: 10px; }
    header h1 { font-size: 1.1rem; }
    nav a { padding: 10px 12px; font-size: 0.8rem; }
    .component-grid { grid-template-columns: 1fr; }
    .file-table { font-size: 0.75rem; }
    .file-table td:first-child { white-space: normal; word-break: break-all; }
  }
</style>
</head>
<body>
  <header>
    <h1>Claude Workstation</h1>
    <div class="meta">Documentation</div>
  </header>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/docs" class="active">Documentation</a>
    <a href="/brain">Brain</a>
  </nav>

  <!-- Table of Contents -->
  <div class="card">
    <h2>Table of Contents</h2>
    <ul class="toc">
      <li><a href="#overview">1. Architecture Overview</a></li>
      <li><a href="#components">2. System Components</a></li>
      <li><a href="#arch-diagram">3. System Architecture Diagram</a></li>
      <li><a href="#message-flow">4. Message Flow</a></li>
      <li><a href="#session-lifecycle">5. Session Lifecycle</a></li>
      <li><a href="#auto-restart">6. Auto-Restart Flow</a></li>
      <li><a href="#file-structure">7. File Structure</a></li>
      <li><a href="#key-files">8. Key Files Reference</a></li>
      <li><a href="#mcp-servers">9. MCP Servers</a></li>
      <li><a href="#cron-jobs">10. Cron Jobs</a></li>
      <li><a href="#commands">11. Shell Commands</a></li>
    </ul>
  </div>

  <!-- Overview -->
  <div class="card" id="overview">
    <h2>1. Architecture Overview</h2>
    <p>
      This Mac is a dedicated Claude Code workstation controlled remotely via Discord.
      Zack sends messages from his phone or another computer to a Discord server.
      A persistent Claude Code session (the "Hub Agent") receives those messages through the
      Discord channels MCP plugin and routes work to dedicated project sessions.
    </p>
    <p>
      Each project gets its own tmux session with an isolated Claude Code context window,
      allowing parallel autonomous work across multiple codebases. When a project session
      finishes responding, a Stop hook automatically posts the result back to Discord.
    </p>
    <p>
      The entire system is self-healing: sessions auto-restart on crash, a health check
      cron monitors uptime every 5 minutes, and LaunchAgent plists ensure everything comes
      back online after a reboot.
    </p>
  </div>

  <!-- Components -->
  <div class="card" id="components">
    <h2>2. System Components</h2>
    <div class="component-grid">
      <div class="component-card">
        <h4>Hub Agent</h4>
        <p>Main Claude Code session in tmux (<code>claude-agent</code>). Receives all Discord messages, handles #hub commands directly, dispatches project work to dedicated sessions.</p>
      </div>
      <div class="component-card">
        <h4>Project Sessions</h4>
        <p>Dedicated Claude Code tmux sessions per project (e.g., <code>claude-nymblpresent</code>). Each has its own context window and works autonomously.</p>
      </div>
      <div class="component-card">
        <h4>Discord Bot</h4>
        <p>Bot in a private Discord server under the "Claude Agent" category. Channels: <code>#hub</code> for general commands, <code>#projectname</code> per project.</p>
      </div>
      <div class="component-card">
        <h4>Stop Hook</h4>
        <p>When project sessions finish responding, a Claude Code Stop hook reads <code>last_assistant_message</code> and posts it to Discord via <code>discord-notify.sh</code>.</p>
      </div>
      <div class="component-card">
        <h4>Auto-Restart</h4>
        <p><code>agent-loop.sh</code> wraps all sessions. Restarts on crash (up to 5 rapid crashes), notifies Discord of restarts. Health check cron every 5 minutes.</p>
      </div>
      <div class="component-card">
        <h4>Dashboard</h4>
        <p>This web UI on port 7777. Shows active sessions, system stats, Discord channels, cron jobs, log files, and this documentation.</p>
      </div>
      <div class="component-card">
        <h4>Slack Bridge</h4>
        <p>Reads Slack channels via MCP tools and forwards messages to Discord. Prefixes urgent messages with <code>[!]</code>.</p>
      </div>
      <div class="component-card">
        <h4>Boot Auto-Start</h4>
        <p>LaunchAgent plists start both the hub agent and dashboard on login. No manual intervention needed after reboot.</p>
      </div>
    </div>
  </div>

  <!-- System Architecture Diagram -->
  <div class="card" id="arch-diagram">
    <h2>3. System Architecture Diagram</h2>
    <div class="mermaid-wrapper">
      <pre class="mermaid">
graph TB
    subgraph Remote["Remote Control"]
        ZACK["Zack (Phone / Laptop)"]
        DISCORD["Discord Server"]
    end

    subgraph Workstation["Mac Workstation"]
        subgraph Hub["Hub Agent (tmux: claude-agent)"]
            HUB_CLAUDE["Claude Code + Discord MCP"]
            DISPATCH["dispatch-to-session.sh"]
        end

        subgraph Projects["Project Sessions"]
            P1["claude-nymblpresent"]
            P2["claude-nymblpropose"]
            P3["claude-secondbrain"]
            PN["claude-..."]
        end

        subgraph Infra["Infrastructure"]
            LOOP["agent-loop.sh\n(auto-restart)"]
            HEALTH["health-check.sh\n(cron 5min)"]
            NOTIFY["discord-notify.sh"]
            HOOK["post-to-discord.sh\n(Stop Hook)"]
        end

        subgraph Services["MCP Servers"]
            HA["Home Assistant"]
            SSH["SSH Manager"]
            PW["Playwright"]
            SLACK["Slack"]
        end

        DASH["Dashboard\n(:7777)"]
    end

    ZACK -->|"sends message"| DISCORD
    DISCORD -->|"MCP plugin"| HUB_CLAUDE
    HUB_CLAUDE -->|"#hub messages"| HUB_CLAUDE
    HUB_CLAUDE -->|"#project messages"| DISPATCH
    DISPATCH -->|"creates/reuses"| P1
    DISPATCH -->|"creates/reuses"| P2
    DISPATCH -->|"creates/reuses"| P3

    P1 -->|"Stop Hook"| HOOK
    P2 -->|"Stop Hook"| HOOK
    P3 -->|"Stop Hook"| HOOK
    HOOK -->|"posts response"| NOTIFY
    NOTIFY -->|"Discord API"| DISCORD

    LOOP -->|"wraps"| Hub
    LOOP -->|"wraps"| Projects
    HEALTH -->|"monitors"| Hub
    HEALTH -->|"restarts if down"| LOOP
    HEALTH -->|"alerts"| NOTIFY

    HUB_CLAUDE --- HA
    HUB_CLAUDE --- SSH
    HUB_CLAUDE --- PW
    HUB_CLAUDE --- SLACK

    DASH -->|"reads system state"| Hub
    DASH -->|"reads system state"| Projects

    style Remote fill:#1a1a2e,stroke:#58a6ff,color:#e6edf3
    style Workstation fill:#0d1117,stroke:#30363d,color:#e6edf3
    style Hub fill:#161b22,stroke:#3fb950,color:#e6edf3
    style Projects fill:#161b22,stroke:#bc8cff,color:#e6edf3
    style Infra fill:#161b22,stroke:#d29922,color:#e6edf3
    style Services fill:#161b22,stroke:#58a6ff,color:#e6edf3
      </pre>
    </div>
  </div>

  <!-- Message Flow -->
  <div class="card" id="message-flow">
    <h2>4. Message Flow</h2>
    <p>This sequence diagram shows the full lifecycle of a Discord message from Zack's phone through to the response being posted back.</p>

    <h3>Project Channel Message</h3>
    <div class="mermaid-wrapper">
      <pre class="mermaid">
sequenceDiagram
    actor Zack
    participant Discord
    participant Hub as Hub Agent
    participant Dispatch as dispatch-to-session.sh
    participant Session as Project Session
    participant Hook as Stop Hook
    participant Notify as discord-notify.sh

    Zack->>Discord: Sends message in #project
    Discord->>Hub: Message received via MCP plugin
    Hub->>Discord: "Dispatching to #project..."
    Hub->>Dispatch: Runs dispatch script
    Dispatch->>Dispatch: Check for existing tmux session
    alt Session exists
        Dispatch->>Session: Send message via tmux send-keys
    else New session
        Dispatch->>Session: Create tmux session with DISCORD_CHANNEL_ID
        Note over Session: agent-loop.sh wraps the session
    end
    Session->>Session: Claude Code processes the task
    Session-->>Hook: Stop hook fires on response complete
    Hook->>Hook: Read last_assistant_message
    Hook->>Notify: Post response text
    Notify->>Discord: POST to Discord API
    Discord->>Zack: Response appears in #project
      </pre>
    </div>

    <h3>Hub Channel Message</h3>
    <div class="mermaid-wrapper">
      <pre class="mermaid">
sequenceDiagram
    actor Zack
    participant Discord
    participant Hub as Hub Agent

    Zack->>Discord: Sends message in #hub
    Discord->>Hub: Message received via MCP plugin
    Hub->>Hub: Process directly
    Note over Hub: Smart home, system mgmt,<br/>channel creation, etc.
    Hub->>Discord: Responds in #hub
      </pre>
    </div>
  </div>

  <!-- Session Lifecycle -->
  <div class="card" id="session-lifecycle">
    <h2>5. Session Lifecycle</h2>
    <p>Project sessions move through a defined set of states. The <code>agent-loop.sh</code> wrapper manages crash recovery while <code>kill-project-session.sh</code> handles clean teardown.</p>
    <div class="mermaid-wrapper">
      <pre class="mermaid">
stateDiagram-v2
    [*] --> Dispatched: dispatch-to-session.sh called

    Dispatched --> Creating: No existing session
    Dispatched --> Active: Session already running

    Creating --> Active: tmux session created<br/>with DISCORD_CHANNEL_ID

    Active --> Processing: Message received
    Processing --> Responding: Claude generates response
    Responding --> StopHook: Response complete
    StopHook --> Idle: Hook posts to Discord

    Idle --> Active: New message dispatched
    Idle --> Cleared: kill-project-session.sh

    Active --> Crashed: Unexpected exit
    Processing --> Crashed: Unexpected exit
    Crashed --> Restarting: agent-loop.sh detects crash
    Restarting --> Active: Restart successful
    Restarting --> Dead: 5 rapid crashes exceeded

    Dead --> [*]: Manual intervention needed
    Cleared --> [*]: Session terminated

    Cleared --> Creating: New dispatch arrives
      </pre>
    </div>
  </div>

  <!-- Auto-Restart Flow -->
  <div class="card" id="auto-restart">
    <h2>6. Auto-Restart Flow</h2>
    <p>The system uses multiple layers of resilience. <code>agent-loop.sh</code> handles immediate crash recovery, the health check cron provides an external monitor, and LaunchAgent plists handle system reboots.</p>
    <div class="mermaid-wrapper">
      <pre class="mermaid">
flowchart TD
    START["Session Running\n(inside agent-loop.sh)"] --> CRASH{"Session exits\nunexpectedly?"}

    CRASH -->|"No (clean exit)"| DONE["Session ends normally"]
    CRASH -->|"Yes"| CHECK{"Rapid crash count\n< 5?"}

    CHECK -->|"Yes"| NOTIFY1["discord-notify.sh\n'Session crashed, restarting...'"]
    NOTIFY1 --> RESTART["Restart Claude Code\nin same tmux session"]
    RESTART --> INCREMENT["Increment crash counter"]
    INCREMENT --> START

    CHECK -->|"No (5+ rapid crashes)"| NOTIFY2["discord-notify.sh\n'Session failed after 5 crashes'"]
    NOTIFY2 --> DEAD["Session stays down"]

    HEALTH["health-check.sh\n(cron every 5 min)"] --> HCHECK{"Hub agent\nrunning?"}
    HCHECK -->|"Yes"| OK["All good"]
    HCHECK -->|"No"| HNOTIFY["discord-notify.sh\n'Hub down, restarting...'"]
    HNOTIFY --> HRESTART["Restart via\nstart-agent.sh"]
    HRESTART --> START

    BOOT["System Reboot"] --> LAUNCH["LaunchAgent plist\ntriggers on login"]
    LAUNCH --> HRESTART

    style START fill:#161b22,stroke:#3fb950,color:#e6edf3
    style DEAD fill:#161b22,stroke:#f85149,color:#e6edf3
    style HEALTH fill:#161b22,stroke:#d29922,color:#e6edf3
    style BOOT fill:#161b22,stroke:#58a6ff,color:#e6edf3
      </pre>
    </div>
  </div>

  <!-- File Structure -->
  <div class="card" id="file-structure">
    <h2>7. File Structure</h2>
    <p>The <code>~/.claude/</code> directory tree showing the organization of all workstation components.</p>
    <div class="mermaid-wrapper">
      <pre class="mermaid">
graph LR
    ROOT["~/.claude/"] --> BIN["bin/"]
    ROOT --> CHANNELS["channels/"]
    ROOT --> HOOKS["hooks/"]
    ROOT --> DASHBOARD["dashboard/"]
    ROOT --> LOGS["logs/"]
    ROOT --> START["start-agent.sh"]
    ROOT --> CLAUDE_MD["CLAUDE.md"]

    BIN --> B1["agent-loop.sh"]
    BIN --> B2["dispatch-to-session.sh"]
    BIN --> B3["discord-notify.sh"]
    BIN --> B4["discord-create-channel.sh"]
    BIN --> B5["kill-project-session.sh"]
    BIN --> B6["health-check.sh"]
    BIN --> B7["restart-agent.sh"]
    BIN --> B8["slack-bridge-instructions.md"]

    CHANNELS --> DISC["discord/"]
    DISC --> CM["channel-map.json"]
    DISC --> ACC["access.json"]
    DISC --> ENV[".env (bot token)"]

    CHANNELS --> SL["slack/"]
    SL --> SCONF["config.json"]

    HOOKS --> HOOK["post-to-discord.sh"]

    DASHBOARD --> SRV["server.js"]

    LOGS --> L1["health.log"]
    LOGS --> L2["agent.log"]
    LOGS --> L3["..."]

    LAUNCH["~/Library/LaunchAgents/"] --> PL1["com.claude.agent.plist"]
    LAUNCH --> PL2["com.claude.dashboard.plist"]

    style ROOT fill:#161b22,stroke:#58a6ff,color:#e6edf3
    style BIN fill:#1c2128,stroke:#3fb950,color:#e6edf3
    style CHANNELS fill:#1c2128,stroke:#bc8cff,color:#e6edf3
    style HOOKS fill:#1c2128,stroke:#d29922,color:#e6edf3
    style DASHBOARD fill:#1c2128,stroke:#58a6ff,color:#e6edf3
    style LOGS fill:#1c2128,stroke:#8b949e,color:#e6edf3
    style LAUNCH fill:#161b22,stroke:#d29922,color:#e6edf3
      </pre>
    </div>
  </div>

  <!-- Key Files Reference -->
  <div class="card" id="key-files">
    <h2>8. Key Files Reference</h2>
    <table class="file-table">
      <thead>
        <tr><th>File</th><th>Purpose</th></tr>
      </thead>
      <tbody>
        <tr><td>~/.claude/start-agent.sh</td><td>Session launcher. Starts Claude Code in a tmux session with proper environment variables and MCP configuration.</td></tr>
        <tr><td>~/.claude/bin/agent-loop.sh</td><td>Auto-restart wrapper. Runs Claude Code in a loop, restarts on crash (up to 5 rapid crashes), and notifies Discord of restart events.</td></tr>
        <tr><td>~/.claude/bin/dispatch-to-session.sh</td><td>Message router. Receives a project name and message, creates or reuses a tmux session, and injects the message. Sets DISCORD_CHANNEL_ID env var.</td></tr>
        <tr><td>~/.claude/bin/discord-notify.sh</td><td>Discord API poster. Sends a message to a Discord channel. Defaults to #hub. Accepts channel ID as optional second argument.</td></tr>
        <tr><td>~/.claude/bin/discord-create-channel.sh</td><td>Channel provisioner. Creates a new Discord channel in the "Claude Agent" category and registers it in channel-map.json.</td></tr>
        <tr><td>~/.claude/bin/kill-project-session.sh</td><td>Session terminator. Cleanly kills a project tmux session and clears its context to free resources.</td></tr>
        <tr><td>~/.claude/bin/health-check.sh</td><td>Cron monitor. Runs every 5 minutes, checks if the hub agent is alive, restarts it if down, and alerts Discord.</td></tr>
        <tr><td>~/.claude/bin/restart-agent.sh</td><td>Self-restart helper. Called from Discord when Zack says "restart". Detaches the restart so it survives the dying session.</td></tr>
        <tr><td>~/.claude/hooks/post-to-discord.sh</td><td>Stop hook. Fires when a Claude Code session finishes responding. Reads last_assistant_message and posts it to the session's Discord channel.</td></tr>
        <tr><td>~/.claude/channels/discord/channel-map.json</td><td>Channel routing map. Maps Discord channel IDs to project names and directories. Used by dispatch and notify scripts.</td></tr>
        <tr><td>~/.claude/channels/discord/access.json</td><td>Access control. Defines which Discord users are allowed to send commands.</td></tr>
        <tr><td>~/.claude/channels/discord/.env</td><td>Bot token. Contains the Discord bot token for API authentication.</td></tr>
        <tr><td>~/Library/LaunchAgents/com.claude.agent.plist</td><td>Boot auto-start for the hub agent. macOS LaunchAgent that starts the agent on login.</td></tr>
        <tr><td>~/Library/LaunchAgents/com.claude.dashboard.plist</td><td>Boot auto-start for this dashboard. macOS LaunchAgent that starts the Express server on login.</td></tr>
      </tbody>
    </table>
  </div>

  <!-- MCP Servers -->
  <div class="card" id="mcp-servers">
    <h2>9. MCP Servers</h2>
    <p>The Hub Agent has access to several MCP (Model Context Protocol) servers that extend its capabilities beyond code.</p>
    <div class="component-grid">
      <div class="component-card">
        <h4>Home Assistant</h4>
        <p>Smart home control. Lights, climate, locks, cameras, automations. Zack can ask the Hub to control devices via Discord.</p>
      </div>
      <div class="component-card">
        <h4>SSH Manager</h4>
        <p>Remote server access. Execute commands on remote machines, check server status, deploy applications.</p>
      </div>
      <div class="component-card">
        <h4>Playwright</h4>
        <p>Browser automation. Navigate web pages, take screenshots, fill forms, run automated UI tests.</p>
      </div>
      <div class="component-card">
        <h4>Slack</h4>
        <p>Workspace communications. Read channels, send messages, search conversations. Powers the Slack bridge to Discord.</p>
      </div>
    </div>
  </div>

  <!-- Cron Jobs -->
  <div class="card" id="cron-jobs">
    <h2>10. Cron Jobs</h2>
    <table class="file-table">
      <thead>
        <tr><th>Schedule</th><th>Job</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr><td>*/5 * * * *</td><td>health-check.sh</td><td>Checks if the hub agent tmux session is running. Restarts if down and notifies Discord.</td></tr>
        <tr><td>0 21 * * *</td><td>git report</td><td>Scans all project repos for uncommitted or unpushed changes. Posts a summary to Discord #hub.</td></tr>
        <tr><td>0 8 * * *</td><td>disk check</td><td>Checks disk usage. Alerts Discord if usage exceeds 80%.</td></tr>
      </tbody>
    </table>
  </div>

  <!-- Shell Commands -->
  <div class="card" id="commands">
    <h2>11. Shell Commands</h2>
    <p>Convenience commands available on this machine for managing agent sessions.</p>
    <table class="file-table">
      <thead>
        <tr><th>Command</th><th>Description</th></tr>
      </thead>
      <tbody>
        <tr><td>claude-agent</td><td>Start the main persistent hub session (default).</td></tr>
        <tr><td>claude-agent &lt;name&gt;</td><td>Start a named session in a matching project folder.</td></tr>
        <tr><td>claude-agent &lt;name&gt; /path</td><td>Start a named session in a specific directory.</td></tr>
        <tr><td>claude-agents</td><td>List all running Claude tmux sessions.</td></tr>
        <tr><td>claude-attach &lt;name&gt;</td><td>Attach to an existing tmux session.</td></tr>
        <tr><td>claude-stop &lt;name&gt;</td><td>Kill a specific session.</td></tr>
        <tr><td>claude-stop --all</td><td>Kill all Claude sessions.</td></tr>
      </tbody>
    </table>
  </div>

<script>
  mermaid.initialize({
    startOnLoad: true,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#161b22',
      primaryColor: '#1c2128',
      primaryTextColor: '#e6edf3',
      primaryBorderColor: '#30363d',
      lineColor: '#58a6ff',
      secondaryColor: '#1c2128',
      tertiaryColor: '#0d1117',
      noteBkgColor: '#1c2128',
      noteTextColor: '#e6edf3',
      noteBorderColor: '#30363d',
      actorBkg: '#161b22',
      actorBorder: '#58a6ff',
      actorTextColor: '#e6edf3',
      signalColor: '#e6edf3',
      signalTextColor: '#e6edf3',
      labelBoxBkgColor: '#161b22',
      labelBoxBorderColor: '#30363d',
      labelTextColor: '#e6edf3',
      loopTextColor: '#8b949e',
      activationBkgColor: '#1c2128',
      activationBorderColor: '#58a6ff',
      sequenceNumberColor: '#0d1117'
    },
    flowchart: {
      htmlLabels: true,
      curve: 'basis'
    },
    sequence: {
      mirrorActors: false,
      bottomMarginAdj: 1,
      messageAlign: 'center'
    }
  });
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Brain HTML
// ---------------------------------------------------------------------------

app.get("/brain", (_req, res) => {
  res.send(buildBrainHTML());
});

function buildBrainHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Workstation -- SecondBrain</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --orange: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
    --blue: #58a6ff;
    --gray: #484f58;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 16px;
    max-width: 960px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0 20px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 8px;
  }
  header h1 { font-size: 1.3rem; font-weight: 600; }
  header .meta { font-size: 0.8rem; color: var(--text-dim); }
  nav {
    display: flex;
    gap: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  nav a {
    flex: 1;
    text-align: center;
    padding: 12px 20px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.9rem;
    font-weight: 500;
    transition: background 0.2s, color 0.2s;
    border-right: 1px solid var(--border);
  }
  nav a:last-child { border-right: none; }
  nav a:hover { background: var(--surface2); color: var(--text); }
  nav a.active { background: var(--surface2); color: var(--accent); border-bottom: 2px solid var(--accent); }

  /* Summary cards */
  .summary-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .summary-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    text-align: center;
  }
  .summary-card .count {
    font-size: 2rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }
  .summary-card .label {
    font-size: 0.8rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 4px;
  }
  .count-active { color: var(--green); }
  .count-planning { color: var(--blue); }
  .count-needs_review { color: var(--orange); }
  .count-inbox { color: var(--purple); }

  /* Search */
  .search-box {
    width: 100%;
    padding: 10px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.9rem;
    font-family: inherit;
    margin-bottom: 16px;
    outline: none;
    transition: border-color 0.2s;
  }
  .search-box:focus { border-color: var(--accent); }
  .search-box::placeholder { color: var(--text-dim); }

  /* Folder tabs */
  .folder-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 20px;
  }
  .folder-tab {
    padding: 10px 16px;
    color: var(--text-dim);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s, color 0.2s;
    border-right: 1px solid var(--border);
    user-select: none;
  }
  .folder-tab:last-child { border-right: none; }
  .folder-tab:hover { background: var(--surface2); color: var(--text); }
  .folder-tab.active { background: var(--surface2); color: var(--accent); border-bottom: 2px solid var(--accent); }
  .folder-tab .tab-count {
    font-size: 0.75rem;
    color: var(--text-dim);
    margin-left: 4px;
  }

  /* Item cards */
  .item-list { display: flex; flex-direction: column; gap: 8px; }
  .item-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    cursor: pointer;
    transition: border-color 0.2s;
  }
  .item-card:hover { border-color: var(--accent); }
  .item-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }
  .item-name {
    font-weight: 600;
    font-size: 0.95rem;
  }
  .item-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .badge-active { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge-planning { background: rgba(88,166,255,0.15); color: var(--blue); }
  .badge-needs_review { background: rgba(210,153,34,0.15); color: var(--orange); }
  .badge-done { background: rgba(72,79,88,0.15); color: var(--gray); }
  .badge-folder {
    background: rgba(188,140,255,0.15);
    color: var(--purple);
    font-size: 0.65rem;
  }
  .item-next-action {
    margin-top: 6px;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .item-next-action strong { color: var(--text); font-weight: 500; }
  .item-tags {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .tag {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.7rem;
    color: var(--text-dim);
  }
  .item-date {
    font-size: 0.75rem;
    color: var(--text-dim);
    margin-top: 4px;
  }
  .item-body {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: 0.85rem;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
    display: none;
  }
  .item-card.expanded .item-body { display: block; }
  .empty { color: var(--text-dim); font-style: italic; font-size: 0.9rem; text-align: center; padding: 40px 0; }
  .refresh-note { text-align: center; color: var(--text-dim); font-size: 0.75rem; padding: 12px 0; }
  @media (max-width: 600px) {
    body { padding: 10px; }
    header h1 { font-size: 1.1rem; }
    nav a { padding: 10px 12px; font-size: 0.8rem; }
    .summary-row { grid-template-columns: repeat(2, 1fr); }
    .folder-tab { padding: 8px 10px; font-size: 0.78rem; }
  }
</style>
</head>
<body>
  <header>
    <h1>Claude Workstation</h1>
    <div class="meta">
      <span id="last-updated">Loading...</span>
    </div>
  </header>
  <nav>
    <a href="/">Dashboard</a>
    <a href="/docs">Documentation</a>
    <a href="/brain" class="active">Brain</a>
  </nav>

  <div id="brain-summary" class="summary-row"></div>
  <input type="text" class="search-box" id="search-input" placeholder="Search by name, tags, or content..." />
  <div id="folder-tabs" class="folder-tabs"></div>
  <div id="brain-items" class="item-list">
    <p class="empty">Loading SecondBrain...</p>
  </div>
  <div class="refresh-note">Auto-refreshes every 30 seconds</div>

<script>
var brainData = null;
var activeFolder = "All";
var searchQuery = "";

function escapeHtml(str) {
  if (!str) return "";
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderSummary(counts) {
  var el = document.getElementById("brain-summary");
  el.innerHTML =
    '<div class="summary-card"><div class="count count-active">' + (counts.active || 0) + '</div><div class="label">Active</div></div>' +
    '<div class="summary-card"><div class="count count-planning">' + (counts.planning || 0) + '</div><div class="label">Planning</div></div>' +
    '<div class="summary-card"><div class="count count-needs_review">' + (counts.needs_review || 0) + '</div><div class="label">Needs Review</div></div>' +
    '<div class="summary-card"><div class="count count-inbox">' + (counts.inbox || 0) + '</div><div class="label">Inbox</div></div>';
}

function folderForTab(item) {
  if (item.folder === "_Inbox") return "Inbox";
  return item.folder || "Other";
}

function renderTabs(items) {
  var folderCounts = {};
  folderCounts["All"] = items.length;
  for (var i = 0; i < items.length; i++) {
    var f = folderForTab(items[i]);
    folderCounts[f] = (folderCounts[f] || 0) + 1;
  }
  var order = ["All", "Projects", "People", "Ideas", "Admin", "Inbox"];
  var el = document.getElementById("folder-tabs");
  el.innerHTML = order.map(function(tab) {
    var cls = tab === activeFolder ? "folder-tab active" : "folder-tab";
    var cnt = folderCounts[tab] || 0;
    return '<div class="' + cls + '" data-folder="' + tab + '">' + escapeHtml(tab) + '<span class="tab-count">(' + cnt + ')</span></div>';
  }).join("");

  var tabs = el.querySelectorAll(".folder-tab");
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener("click", function() {
      activeFolder = this.getAttribute("data-folder");
      renderAll();
    });
  }
}

function matchesSearch(item, q) {
  if (!q) return true;
  var lower = q.toLowerCase();
  if ((item.name || "").toLowerCase().indexOf(lower) !== -1) return true;
  if ((item.body || "").toLowerCase().indexOf(lower) !== -1) return true;
  if (Array.isArray(item.tags)) {
    for (var i = 0; i < item.tags.length; i++) {
      if (item.tags[i].toLowerCase().indexOf(lower) !== -1) return true;
    }
  }
  return false;
}

function filterItems(items) {
  return items.filter(function(item) {
    if (activeFolder !== "All") {
      var f = folderForTab(item);
      if (f !== activeFolder) return false;
    }
    return matchesSearch(item, searchQuery);
  });
}

function renderItems(items) {
  var el = document.getElementById("brain-items");
  var filtered = filterItems(items);
  if (filtered.length === 0) {
    el.innerHTML = '<p class="empty">No items match your search or filter.</p>';
    return;
  }
  // Sort: active first, then planning, needs_review, done; then by last_updated desc
  var statusOrder = { active: 0, planning: 1, needs_review: 2, done: 3 };
  filtered.sort(function(a, b) {
    var sa = statusOrder[a.status] !== undefined ? statusOrder[a.status] : 99;
    var sb = statusOrder[b.status] !== undefined ? statusOrder[b.status] : 99;
    if (sa !== sb) return sa - sb;
    return (b.last_updated || "").localeCompare(a.last_updated || "");
  });

  el.innerHTML = filtered.map(function(item, idx) {
    var badgeClass = "badge badge-" + (item.status || "done");
    var tags = Array.isArray(item.tags) ? item.tags : [];
    var tagsHtml = tags.map(function(t) {
      return '<span class="tag">' + escapeHtml(t) + '</span>';
    }).join("");
    var nextAction = item.next_action && item.next_action !== "none"
      ? '<div class="item-next-action"><strong>Next:</strong> ' + escapeHtml(item.next_action) + '</div>'
      : '';
    var dateHtml = item.last_updated
      ? '<div class="item-date">Updated: ' + escapeHtml(item.last_updated) + '</div>'
      : '';
    var bodyHtml = item.body
      ? '<div class="item-body">' + escapeHtml(item.body) + '</div>'
      : '';

    return '<div class="item-card" data-idx="' + idx + '">' +
      '<div class="item-card-header">' +
        '<span class="item-name">' + escapeHtml(item.name || item.file) + '</span>' +
        '<div class="item-meta">' +
          '<span class="badge badge-folder">' + escapeHtml(folderForTab(item)) + '</span>' +
          '<span class="' + badgeClass + '">' + escapeHtml((item.status || "").replace("_", " ")) + '</span>' +
        '</div>' +
      '</div>' +
      nextAction +
      (tagsHtml ? '<div class="item-tags">' + tagsHtml + '</div>' : '') +
      dateHtml +
      bodyHtml +
    '</div>';
  }).join("");

  // Click to expand
  var cards = el.querySelectorAll(".item-card");
  for (var c = 0; c < cards.length; c++) {
    cards[c].addEventListener("click", function() {
      this.classList.toggle("expanded");
    });
  }
}

function renderAll() {
  if (!brainData) return;
  renderSummary(brainData.counts);
  renderTabs(brainData.items);
  renderItems(brainData.items);
  document.getElementById("last-updated").textContent = "Updated: " + new Date().toLocaleTimeString();
}

function fetchBrain() {
  fetch("/api/brain")
    .then(function(r) { return r.json(); })
    .then(function(data) {
      brainData = data;
      renderAll();
    })
    .catch(function(err) {
      document.getElementById("brain-items").innerHTML =
        '<p class="empty">Error loading data: ' + escapeHtml(err.message) + '</p>';
    });
}

document.getElementById("search-input").addEventListener("input", function() {
  searchQuery = this.value;
  renderAll();
});

fetchBrain();
setInterval(fetchBrain, 30000);
<\/script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`Claude Workstation Dashboard running at http://localhost:${PORT}`);
});
