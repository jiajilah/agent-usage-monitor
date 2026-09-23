'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const BUCKET_MS = 10 * 60 * 1000; // 10-minute buckets keep the cache small but windows accurate

function homeDir(override, fallbackName) {
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), fallbackName);
}

function walk(dir, out, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, predicate);
    else if (entry.isFile() && predicate(entry.name)) out.push(full);
  }
  return out;
}

function emptyTotals() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0 };
}

function addTotals(target, source) {
  target.input += source.input;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.requests += source.requests;
  return target;
}

// A bucket is [bucketStartMs, model, project, input, cacheRead, cacheWrite, output, reasoning, requests]
function bucketKey(ts, model, project) {
  return `${Math.floor(ts / BUCKET_MS) * BUCKET_MS}|${model}|${project}`;
}

function pushBucket(map, ts, model, project, usage) {
  if (!Number.isFinite(ts)) return;
  const key = bucketKey(ts, model, project);
  let row = map.get(key);
  if (!row) {
    row = [Math.floor(ts / BUCKET_MS) * BUCKET_MS, model, project, 0, 0, 0, 0, 0, 0];
    map.set(key, row);
  }
  row[3] += usage.input || 0;
  row[4] += usage.cacheRead || 0;
  row[5] += usage.cacheWrite || 0;
  row[6] += usage.output || 0;
  row[7] += usage.reasoning || 0;
  row[8] += 1;
}

function parseTs(value) {
  if (!value) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

async function eachLine(file, wanted, handler) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // Cheap substring test first: most lines in these logs are not usage records.
      if (line.length < 2 || (wanted && !wanted(line))) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (err) {
        continue;
      }
      handler(record);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function projectName(cwd) {
  if (!cwd) return 'unknown';
  const base = path.basename(cwd);
  return base || cwd;
}

// ---------------------------------------------------------------- Claude Code

async function parseClaudeFile(file) {
  const buckets = new Map();
  await eachLine(file, (line) => line.indexOf('"usage"') !== -1, (record) => {
    if (!record || record.type !== 'assistant') return;
    const message = record.message;
    const usage = message && message.usage;
    if (!usage) return;
    const ts = parseTs(record.timestamp);
    const model = (message.model || 'unknown').trim();
    if (model === '<synthetic>') return;
    pushBucket(buckets, ts, model, projectName(record.cwd), {
      input: usage.input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheWrite: usage.cache_creation_input_tokens || 0,
      output: usage.output_tokens || 0,
      reasoning:
        (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0
    });
  });
  return Array.from(buckets.values());
}

// --------------------------------------------------------------------- Codex

async function parseCodexFile(file) {
  const preferred = new Map(); // from token_usage_record (per response, most precise)
  const fallback = new Map(); // from token_count events (older sessions)
  let model = 'unknown';
  let project = 'unknown';
  let rateLimits = null;
  let rateLimitsTs = 0;
  let plan = null;

  const wanted = (line) =>
    line.indexOf('token') !== -1 ||
    line.indexOf('"turn_context"') !== -1 ||
    line.indexOf('"session_meta"') !== -1;

  await eachLine(file, wanted, (record) => {
    if (!record) return;
    const type = record.type;
    const payload = record.payload || {};
    const ts = parseTs(record.timestamp || payload.timestamp);

    if (type === 'session_meta') {
      project = projectName(payload.cwd);
      return;
    }
    if (type === 'turn_context') {
      if (payload.model) model = payload.model;
      if (payload.cwd) project = projectName(payload.cwd);
      return;
    }
    if (type === 'token_usage_record') {
      const usage = payload.usage;
      if (!usage) return;
      pushBucket(preferred, ts, model, project, {
        input: Math.max(0, (usage.input_tokens || 0) - (usage.cached_input_tokens || 0)),
        cacheRead: usage.cached_input_tokens || 0,
        cacheWrite: usage.cache_write_input_tokens || 0,
        output: usage.output_tokens || 0,
        reasoning: usage.reasoning_output_tokens || 0
      });
      return;
    }
    const isTokenCount =
      type === 'token_count' || (type === 'event_msg' && payload.type === 'token_count');
    if (!isTokenCount) return;

    const body = type === 'token_count' ? record : payload;
    if (body.rate_limits && ts >= rateLimitsTs) {
      rateLimits = body.rate_limits;
      rateLimitsTs = ts;
      if (body.rate_limits.plan_type) plan = body.rate_limits.plan_type;
    }
    const usage = body.info && body.info.last_token_usage;
    if (!usage) return;
    pushBucket(fallback, ts, model, project, {
      input: Math.max(0, (usage.input_tokens || 0) - (usage.cached_input_tokens || 0)),
      cacheRead: usage.cached_input_tokens || 0,
      cacheWrite: usage.cache_write_input_tokens || 0,
      output: usage.output_tokens || 0,
      reasoning: usage.reasoning_output_tokens || 0
    });
  });

  // token_usage_record and token_count describe the same requests; never count both.
  const buckets = preferred.size ? preferred : fallback;
  return {
    buckets: Array.from(buckets.values()),
    rateLimits,
    rateLimitsTs,
    plan
  };
}

// --------------------------------------------------------------------- cache

function loadCache(cacheFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (parsed && parsed.version === 2 && parsed.files) return parsed;
  } catch (err) {
    /* a missing or corrupt cache just means a full rescan */
  }
  return { version: 2, files: {} };
}

function saveCache(cacheFile, cache) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  } catch (err) {
    /* the cache is an optimisation; failing to write it is not fatal */
  }
}

async function collectSource(files, cache, parseFile, onProgress) {
  const buckets = [];
  const extras = [];
  let parsed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      continue;
    }
    const signature = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    const cached = cache.files[file];
    let entry;
    if (cached && cached.sig === signature) {
      entry = cached;
    } else {
      const result = await parseFile(file);
      entry = Array.isArray(result)
        ? { sig: signature, buckets: result }
        : { sig: signature, buckets: result.buckets, extra: {
            rateLimits: result.rateLimits,
            rateLimitsTs: result.rateLimitsTs,
            plan: result.plan
          } };
      cache.files[file] = entry;
      parsed++;
      if (onProgress && parsed % 5 === 0) onProgress(i + 1, files.length);
    }
    for (const row of entry.buckets) buckets.push(row);
    if (entry.extra) extras.push(entry.extra);
  }
  return { buckets, extras, parsed };
}



// -------------------------------------------------------------- Antigravity

const { execFile } = require('child_process');

// Antigravity's data is SQLite + protobuf, so a helper script does the reading.
function collectAntigravity(script, root, lookbackDays) {
  return new Promise((resolve) => {
    if (!fs.existsSync(root) || !fs.existsSync(script)) {
      resolve({ buckets: [], available: false, reason: 'no Antigravity data directory' });
      return;
    }
    execFile(
      'python3',
      [script, root, String(lookbackDays)],
      { timeout: 60000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ buckets: [], available: false, reason: String((err && err.message) || err) });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve({ buckets: parsed.buckets || [], available: true });
        } catch (parseErr) {
          resolve({ buckets: [], available: false, reason: 'unreadable helper output' });
        }
      }
    );
  });
}

// ---------------------------------------------------------------- live limits

const https = require('https');

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Same endpoint Claude Code's /usage uses, authenticated with the local OAuth login.
async function fetchClaudeLimits(claudeHome) {
  const creds = JSON.parse(fs.readFileSync(path.join(claudeHome, '.credentials.json'), 'utf8'));
  const oauth = creds.claudeAiOauth || {};
  if (!oauth.accessToken) throw new Error('not logged in');
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    throw new Error('login token expired — send any message in Claude Code to refresh it');
  }
  const d = await getJson('https://api.anthropic.com/api/oauth/usage', {
    Authorization: `Bearer ${oauth.accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'ag-usage-dashboard'
  });
  const win = (w, minutes) =>
    w ? { usedPercent: w.utilization || 0, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null, windowMinutes: minutes } : null;
  const extra = d.extra_usage;
  // used_credits and monthly_limit are both minor units (cents); decimal_places gives the scale.
  const scale = extra ? Math.pow(10, Number.isFinite(extra.decimal_places) ? extra.decimal_places : 2) : 100;
  return {
    plan: oauth.subscriptionType || null,
    fiveHour: win(d.five_hour, 300),
    weekly: win(d.seven_day, 10080),
    extra: extra && extra.is_enabled
      ? { used: (extra.used_credits || 0) / scale, limit: (extra.monthly_limit || 0) / scale, currency: extra.currency || 'USD' }
      : null
  };
}

// Same endpoint the Codex extension's Usage page uses, authenticated with ~/.codex/auth.json.
async function fetchCodexLimits(codexHome) {
  const auth = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
  const tokens = auth.tokens || {};
  if (!tokens.access_token) throw new Error('not logged in');
  const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json', 'User-Agent': 'ag-usage-dashboard' };
  if (tokens.account_id) headers['ChatGPT-Account-Id'] = tokens.account_id;
  const d = await getJson('https://chatgpt.com/backend-api/wham/usage', headers);
  const rl = d.rate_limit || {};
  const win = (w) =>
    w ? { usedPercent: w.used_percent || 0, resetsAt: w.reset_at ? w.reset_at * 1000 : null, windowMinutes: Math.round((w.limit_window_seconds || 0) / 60) } : null;
  const credits = d.credits || null;
  return {
    plan: d.plan_type || null,
    fiveHour: win(rl.primary_window),
    weekly: win(rl.secondary_window),
    credits: credits ? { balance: Number(credits.balance || 0), unlimited: !!credits.unlimited } : null,
    resetCredits: d.rate_limit_reset_credits ? d.rate_limit_reset_credits.available_count : null
  };
}


function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = https.request(
      { method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
        headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': payload.length },
        timeout: 15000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
          try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

// Antigravity's own client calls fetchAvailableModels, whose quotaInfo carries the rolling-window
// quota per model. Models sharing a resetTime share one pool, so they are grouped by it.
async function fetchAntigravityLimits(geminiHome, watchModel) {
  const tokenFile = path.join(path.dirname(geminiHome), 'jetski-standalone-oauth-token');
  const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const token = saved.token && saved.token.access_token;
  if (!token) throw new Error('not logged into Antigravity');
  if (saved.token.expiry && Date.parse(saved.token.expiry) < Date.now()) {
    throw new Error('login token expired — open Antigravity to refresh it');
  }
  // The endpoint returns 403 unless the User-Agent identifies the Antigravity client.
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'antigravity' };
  const hosts = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
  let models = null;
  let lastError = null;
  for (const host of hosts) {
    try {
      models = await postJson(`${host}/v1internal:fetchAvailableModels`, headers, {});
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!models) throw lastError || new Error('no response');

  const pools = new Map();
  for (const [name, model] of Object.entries(models.models || {})) {
    const quota = model.quotaInfo;
    if (!quota || !quota.resetTime) continue;
    // The API omits remainingFraction once it reaches zero (protobuf drops default values), so an
    // absent field means the quota is exhausted, not that the model has no quota.
    const remaining = typeof quota.remainingFraction === 'number' ? quota.remainingFraction : 0;
    const key = quota.resetTime;
    const pool = pools.get(key) || { resetsAt: Date.parse(quota.resetTime), remaining: 1, models: [] };
    pool.remaining = Math.min(pool.remaining, remaining);
    pool.models.push(name);
    pools.set(key, pool);
  }

  const label = (names) => {
    const families = new Set(names.map((n) => n.split(/[-.]/)[0]));
    if (families.size === 1) return `${[...families][0]} models`;
    return [...families].sort().join(' / ') + ' models';
  };

  // Every gemini-* model reports the same remainingFraction and resetTime - one shared allowance -
  // so matching the family prefix keeps working as new Gemini versions appear.
  const prefix = (watchModel || 'gemini').toLowerCase();
  const watched = Array.from(pools.values()).filter((pool) =>
    pool.models.some((name) => name.toLowerCase().startsWith(prefix)));
  if (watched.length) {
    const pretty = prefix.charAt(0).toUpperCase() + prefix.slice(1);
    return {
      plan: null,
      pools: watched.map((pool) => {
        const count = pool.models.filter((name) => name.toLowerCase().startsWith(prefix)).length;
        return {
          label: `${pretty} limit · ${count} model${count === 1 ? '' : 's'}`,
          usedPercent: Math.max(0, Math.min(100, (1 - pool.remaining) * 100)),
          resetsAt: pool.resetsAt,
          modelCount: 0
        };
      })
    };
  }

  return {
    plan: null,
    pools: Array.from(pools.values())
      .sort((a, b) => a.remaining - b.remaining)
      .map((pool) => ({
        label: label(pool.models),
        usedPercent: Math.max(0, Math.min(100, (1 - pool.remaining) * 100)),
        resetsAt: pool.resetsAt,
        modelCount: pool.models.length
      }))
  };
}

async function settle(promise) {
  try {
    return { ok: true, value: await promise, at: Date.now() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), at: Date.now() };
  }
}

// ------------------------------------------------------------------ analysis

function summarise(buckets, since, now) {
  const totals = emptyTotals();
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();

  for (const row of buckets) {
    const [ts, model, project, input, cacheRead, cacheWrite, output, reasoning, requests] = row;
    if (ts < since || ts > now + BUCKET_MS) continue;
    const usage = { input, cacheRead, cacheWrite, output, reasoning, requests };
    addTotals(totals, usage);
    addTotals(byModel.get(model) || byModel.set(model, emptyTotals()).get(model), usage);
    addTotals(byProject.get(project) || byProject.set(project, emptyTotals()).get(project), usage);
    const day = new Date(ts);
    const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(
      day.getDate()
    ).padStart(2, '0')}`;
    addTotals(byDay.get(dayKey) || byDay.set(dayKey, emptyTotals()).get(dayKey), usage);
  }

  const rank = (map) =>
    Array.from(map.entries())
      .map(([name, value]) => ({ name, ...value, total: value.input + value.cacheRead + value.cacheWrite + value.output }))
      .sort((a, b) => b.total - a.total);

  return {
    totals: { ...totals, total: totals.input + totals.cacheRead + totals.cacheWrite + totals.output },
    byModel: rank(byModel),
    byProject: rank(byProject),
    byDay: Array.from(byDay.entries())
      .map(([day, value]) => ({ day, ...value, total: value.input + value.cacheRead + value.cacheWrite + value.output }))
      .sort((a, b) => (a.day < b.day ? -1 : 1))
  };
}

async function collectUsage(options) {
  const config = options || {};
  const now = Date.now();
  const lookbackDays = config.lookbackDays > 0 ? config.lookbackDays : 90;
  const cutoff = now - lookbackDays * 86400000;
  const codexHome = homeDir(config.codexHome, '.codex');
  const geminiHome = config.geminiHome && config.geminiHome.trim()
    ? config.geminiHome.trim()
    : path.join(os.homedir(), '.gemini', 'antigravity');
  const claudeHome = homeDir(config.claudeHome, '.claude');
  const cacheFile = config.cacheFile || path.join(os.tmpdir(), 'ag-usage-cache.json');
  const cache = loadCache(cacheFile);

  const recent = (file) => {
    try {
      return fs.statSync(file).mtimeMs >= cutoff;
    } catch (err) {
      return false;
    }
  };

  const codexFiles = walk(path.join(codexHome, 'sessions'), [], (n) => n.endsWith('.jsonl')).filter(recent);
  const claudeFiles = walk(path.join(claudeHome, 'projects'), [], (n) => n.endsWith('.jsonl')).filter(recent);

  const antigravityPromise = collectAntigravity(config.antigravityScript || '', geminiHome, lookbackDays);
  const livePromise = Promise.all([
    settle(fetchCodexLimits(codexHome)),
    settle(fetchClaudeLimits(claudeHome)),
    settle(fetchAntigravityLimits(geminiHome, config.antigravityModel))
  ]);
  const codex = await collectSource(codexFiles, cache, parseCodexFile, config.onProgress);
  const claude = await collectSource(claudeFiles, cache, parseClaudeFile, config.onProgress);

  // Drop cache entries for files that no longer exist so it cannot grow forever.
  const live = new Set([...codexFiles, ...claudeFiles]);
  for (const key of Object.keys(cache.files)) if (!live.has(key)) delete cache.files[key];
  saveCache(cacheFile, cache);

  let rateLimits = null;
  let rateLimitsTs = 0;
  let plan = null;
  for (const extra of codex.extras) {
    if (extra.rateLimits && extra.rateLimitsTs > rateLimitsTs) {
      rateLimits = extra.rateLimits;
      rateLimitsTs = extra.rateLimitsTs;
    }
    if (extra.plan) plan = extra.plan;
  }
  if (rateLimits && rateLimits.plan_type) plan = rateLimits.plan_type;

  const windows = {
    day: now - 86400000,
    week: now - 7 * 86400000,
    month: now - 30 * 86400000,
    all: cutoff
  };

  const build = (buckets, fileCount) => ({
    sessions: fileCount,
    windows: Object.fromEntries(
      Object.entries(windows).map(([name, since]) => [name, summarise(buckets, since, now)])
    ),
    lastActivity: buckets.reduce((max, row) => Math.max(max, row[0]), 0)
  });

  const [codexLive, claudeLive, antigravityLive] = await livePromise;
  const antigravity = await antigravityPromise;

  return {
    generatedAt: now,
    live: { codex: codexLive, claude: claudeLive, antigravity: antigravityLive },
    lookbackDays,
    codexHome,
    claudeHome,
    parsedFiles: codex.parsed + claude.parsed,
    codex: { ...build(codex.buckets, codexFiles.length), rateLimits, rateLimitsTs, plan },
    claude: build(claude.buckets, claudeFiles.length),
    antigravity: {
      ...build(antigravity.buckets, new Set(antigravity.buckets.map((r) => r[2])).size),
      available: antigravity.available,
      reason: antigravity.reason || null,
      home: geminiHome
    }
  };
}

module.exports = { collectUsage };
