// Laxorq Automate — lead capture + auto follow-up engine
// Multi-tenant: one owner (you) sees every client; each client logs in and sees only their own leads + conversions.
// Zero npm dependencies: node:http + node:sqlite + node:tls (SMTP) + node:crypto (auth).
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');
const { DatabaseSync } = require('node:sqlite');

const VERSION = (() => { try { return require('./package.json').version; } catch { return '0.0.0'; } })();
const SCHEMA_VERSION = 1; // bump when you add a migration below

// Resilience: a bug in one request or a stray rejection must never take the whole app down.
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';
// Data dir is overridable so the desktop build can store the DB in a writable
// per-user location (Electron sets AUTOMATE_DATA_DIR to app userData).
const DATA_DIR = process.env.AUTOMATE_DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(DATA_DIR, 'automate.db');
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- DATABASE
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Auto-backup the database before we open it, so improving/migrating the app can
// never lose a client's leads. Keeps the last 10 timestamped copies.
function backupDb() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_PATH, path.join(dir, `automate-${stamp}.db`));
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 10))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  } catch (e) { console.error('backupDb:', e.message); }
}
backupDb();

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    niche TEXT DEFAULT '',
    owner_name TEXT DEFAULT '',
    owner_email TEXT DEFAULT '',
    owner_whatsapp TEXT DEFAULT '',
    website TEXT DEFAULT '',
    form_token TEXT UNIQUE NOT NULL,
    settings_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL,
    name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    source TEXT DEFAULT 'form',
    message TEXT DEFAULT '',
    score TEXT DEFAULT '',
    score_reason TEXT DEFAULT '',
    status TEXT DEFAULT 'new',          -- new | replied | booked | dead | archived
    value REAL DEFAULT 0,               -- deal value once booked/converted
    appt_at TEXT,                       -- scheduled appointment datetime once booked
    created_at TEXT NOT NULL,
    replied_at TEXT
  );
  CREATE TABLE IF NOT EXISTS touches (
    id INTEGER PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    touch_no INTEGER NOT NULL,          -- 0 = instant reply, 1..3 = follow-ups
    channel TEXT NOT NULL,              -- whatsapp | email | call
    subject TEXT DEFAULT '',
    body TEXT DEFAULT '',
    due_at TEXT NOT NULL,
    sent_at TEXT,
    status TEXT DEFAULT 'scheduled',    -- scheduled | due | sent | skipped | cancelled
    auto INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL,
    lead_id INTEGER,
    type TEXT NOT NULL,                 -- lead | msg | followup | system
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflows (
    client_id INTEGER NOT NULL,
    key TEXT NOT NULL,                  -- instant_reply | followup | notify_owner
    enabled INTEGER DEFAULT 1,
    PRIMARY KEY (client_id, key)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL,                 -- owner | client
    client_id INTEGER,                  -- role=client → the workspace they can see
    name TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY,
    client_id INTEGER NOT NULL,
    path TEXT DEFAULT '',
    referrer TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    client_id INTEGER,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// ---- Safe schema evolution ----------------------------------------------------
// New TABLES are handled by CREATE TABLE IF NOT EXISTS above. For new COLUMNS on
// existing tables, add an ensureColumn() call inside a migration step below and
// bump SCHEMA_VERSION. Backups already ran, so this is non-destructive.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
const MIGRATIONS = {
  // Example for the future — uncomment + bump SCHEMA_VERSION to 2:
  // 2: () => ensureColumn('leads', 'tags', "TEXT DEFAULT ''"),
};
function runMigrations() {
  // Belt-and-suspenders: guarantee added columns exist on any legacy DB before baselining.
  ensureColumn('leads', 'value', 'REAL DEFAULT 0');
  ensureColumn('leads', 'appt_at', 'TEXT');
  ensureColumn('clients', 'website', "TEXT DEFAULT ''");
  let current = db.prepare('PRAGMA user_version').get().user_version || 0;
  if (current === 0) { current = SCHEMA_VERSION; db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    if (MIGRATIONS[v]) { console.log('Running migration', v); MIGRATIONS[v](); }
    db.exec(`PRAGMA user_version = ${v}`);
  }
}
runMigrations();

const now = () => new Date().toISOString();
// Lead-supplied text gets interpolated into activity-feed HTML — always escape it
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const q = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  clientByToken: db.prepare('SELECT * FROM clients WHERE form_token = ?'),
  clientById: db.prepare('SELECT * FROM clients WHERE id = ?'),
  wf: db.prepare('SELECT enabled FROM workflows WHERE client_id = ? AND key = ?'),
};

function getSetting(key, fallback = '') {
  const row = q.getSetting.get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) { q.setSetting.run(key, String(value ?? '')); }
function wfEnabled(clientId, key) {
  const row = q.wf.get(clientId, key);
  return row ? !!row.enabled : true;
}
function addEvent(clientId, leadId, type, text) {
  db.prepare('INSERT INTO events (client_id, lead_id, type, text, created_at) VALUES (?,?,?,?,?)')
    .run(clientId, leadId, type, text, now());
}

// ---------------------------------------------------------------- AUTH
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, 32);
  return salt.toString('hex') + ':' + dk.toString('hex');
}
function verifyPw(pw, stored) {
  try {
    const [s, h] = String(stored).split(':');
    const dk = crypto.scryptSync(String(pw), Buffer.from(s, 'hex'), 32);
    return crypto.timingSafeEqual(dk, Buffer.from(h, 'hex'));
  } catch { return false; }
}
// Long-lived, self-renewing sessions so you sign in once per device and stay in.
// 400 days = the browser cap for persistent cookies; refreshed on every use below.
const SESSION_DAYS = 400;
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now(), new Date(Date.now() + SESSION_DAYS * DAY).toISOString());
  return token;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(sid);
  if (!s) return null;
  if (s.expires_at < now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(sid); return null; }
  // Sliding expiry: keep active sessions alive so the user never has to log in again.
  if (new Date(s.expires_at).getTime() - Date.now() < (SESSION_DAYS - 1) * DAY) {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(new Date(Date.now() + SESSION_DAYS * DAY).toISOString(), sid);
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
}
function sanitizeUser(u) {
  if (!u) return null;
  const client = u.client_id ? q.clientById.get(u.client_id) : null;
  return { id: u.id, email: u.email, role: u.role, client_id: u.client_id, name: u.name, client_name: client ? client.name : null };
}
function sessionCookie(token, secure) {
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 3600}${secure ? '; Secure' : ''}`;
}
function isSecure(req) { return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function canAccessClient(user, cid) { return user.role === 'owner' || Number(cid) === Number(user.client_id); }
// GET endpoints: clients are pinned to their own workspace, owner may pick any
function resolveCid(user, url) {
  if (user.role === 'client') return Number(user.client_id);
  return Number(url.searchParams.get('client_id'));
}

// Default templates. Placeholders: {{first_name}} {{name}} {{business}} {{snippet}}
const DEFAULT_TEMPLATES = {
  instant_reply: `Hi {{first_name}}, thanks for reaching out to {{business}}. I received your enquiry and will get back to you with details very shortly. If anything is urgent, feel free to reply here directly.`,
  touch1_whatsapp: `Hi {{first_name}}, this is {{business}} following up on your enquiry from yesterday. I wanted to make sure you got my reply. Would you like me to share available slots this week?`,
  touch2_email_subject: `Your enquiry with {{business}}`,
  touch2_email: `Hi {{first_name}},\n\nI reached out earlier about your enquiry with {{business}} and have not heard back, so I wanted to check in once more. Many of our students start with a free trial session, and I would be happy to arrange one for you this week.\n\nJust reply to this email and I will sort everything out.\n\nBest regards,\n{{business}}`,
  touch3_call: `Call {{name}} ({{phone}}). Last touch before archiving. Enquiry was: "{{snippet}}"`,
};

function createClient({ name, niche = '', owner_name = '', owner_email = '', owner_whatsapp = '' }) {
  const token = crypto.randomBytes(8).toString('hex');
  const settings = { templates: { ...DEFAULT_TEMPLATES } };
  const r = db.prepare(
    'INSERT INTO clients (name, niche, owner_name, owner_email, owner_whatsapp, form_token, settings_json, created_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(name, niche, owner_name, owner_email, owner_whatsapp, token, JSON.stringify(settings), now());
  const id = Number(r.lastInsertRowid);
  for (const key of ['instant_reply', 'followup', 'notify_owner']) {
    db.prepare('INSERT INTO workflows (client_id, key, enabled) VALUES (?,?,?)').run(id, key, key === 'notify_owner' ? 0 : 1);
  }
  addEvent(id, null, 'system', `Client workspace created: ${esc(name)}`);
  return q.clientById.get(id);
}

// Ensure a starter client exists on first run
if (!db.prepare('SELECT COUNT(*) AS c FROM clients').get().c) {
  createClient({ name: 'My Business', niche: 'Tuition centre' });
}

// ---------------------------------------------------------------- HELPERS
function firstName(name) { return (name || 'there').trim().split(/\s+/)[0]; }
function snippet(text, n = 60) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '...' : t;
}
function fillTemplate(tpl, lead, client) {
  return (tpl || '')
    .replaceAll('{{first_name}}', firstName(lead.name))
    .replaceAll('{{name}}', lead.name || 'there')
    .replaceAll('{{business}}', client.name)
    .replaceAll('{{phone}}', lead.phone || '')
    .replaceAll('{{snippet}}', snippet(lead.message));
}
function clientTemplates(client) {
  try { return { ...DEFAULT_TEMPLATES, ...(JSON.parse(client.settings_json).templates || {}) }; }
  catch { return { ...DEFAULT_TEMPLATES }; }
}
// Singapore-friendly phone → wa.me digits
function waDigits(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 8 && /^[89]/.test(d)) d = '65' + d;
  return d;
}

// ---------------------------------------------------------------- QUALIFICATION
const HOT_WORDS = ['urgent', 'asap', 'this week', 'today', 'tomorrow', 'trial', 'book', 'sign up', 'enrol', 'enroll', 'start', 'price', 'fees', 'how much', 'available'];
function ruleQualify(lead) {
  let pts = 0;
  const reasons = [];
  const msg = (lead.message || '').toLowerCase();
  if (lead.phone) { pts++; reasons.push('left a phone number'); }
  if ((lead.message || '').length > 80) { pts++; reasons.push('detailed enquiry'); }
  const hits = HOT_WORDS.filter(w => msg.includes(w));
  if (hits.length) { pts += Math.min(hits.length, 2); reasons.push(`intent keywords: ${hits.slice(0, 3).join(', ')}`); }
  const score = pts >= 3 ? 'hot' : pts >= 1 ? 'warm' : 'cold';
  return { score, reason: reasons.join('; ') || 'short enquiry, no contact details or intent signals' };
}

async function aiQualify(lead, client) {
  const apiKey = getSetting('anthropic_api_key');
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `You qualify inbound leads for "${client.name}" (${client.niche || 'local service business'}).\n` +
            `Lead name: ${lead.name || 'unknown'}\nPhone: ${lead.phone || 'none'}\nEmail: ${lead.email || 'none'}\nMessage: "${lead.message || '(empty)'}"\n\n` +
            `Reply with ONLY a JSON object, no other text: {"score":"hot|warm|cold","reason":"one short sentence","reply":"a warm 2-3 sentence first reply to this lead from the business. No dashes. Capital letter at the start of each sentence. Do not invent prices or promises."}`
        }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const text = (data.content || []).map(b => b.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in response');
    const out = JSON.parse(m[0]);
    if (!['hot', 'warm', 'cold'].includes(out.score)) throw new Error('bad score');
    return out;
  } catch (e) {
    console.error('AI qualify failed, using rules:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------- SMTP (port 465, implicit TLS)
function smtpConfig() {
  const cfg = {
    host: getSetting('smtp_host'), port: Number(getSetting('smtp_port', '465')),
    user: getSetting('smtp_user'), pass: getSetting('smtp_pass'),
    from: getSetting('smtp_from') || getSetting('smtp_user'),
  };
  return cfg.host && cfg.user && cfg.pass ? cfg : null;
}

function sendEmail({ to, subject, body }) {
  const cfg = smtpConfig();
  if (!cfg) return Promise.reject(new Error('SMTP not configured'));
  return new Promise((resolve, reject) => {
    const socket = tls.connect(cfg.port, cfg.host, { servername: cfg.host });
    let buf = '';
    let step = 0;
    const fail = (err) => { try { socket.destroy(); } catch {} reject(err); };
    socket.setTimeout(20000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);

    const msg = [
      `From: ${cfg.from}`, `To: ${to}`, `Subject: ${subject}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
      body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..'),
    ].join('\r\n');

    const steps = [
      { expect: 220, send: () => `EHLO laxorq.local\r\n` },
      { expect: 250, send: () => `AUTH LOGIN\r\n` },
      { expect: 334, send: () => Buffer.from(cfg.user).toString('base64') + '\r\n' },
      { expect: 334, send: () => Buffer.from(cfg.pass).toString('base64') + '\r\n' },
      { expect: 235, send: () => `MAIL FROM:<${cfg.from.replace(/.*</, '').replace(/>.*/, '')}>\r\n` },
      { expect: 250, send: () => `RCPT TO:<${to}>\r\n` },
      { expect: 250, send: () => `DATA\r\n` },
      { expect: 354, send: () => msg + '\r\n.\r\n' },
      { expect: 250, send: () => `QUIT\r\n`, done: true },
    ];

    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\r\n');
      const last = lines.filter(Boolean).pop() || '';
      if (!/^\d{3} /.test(last)) return;
      const code = Number(last.slice(0, 3));
      buf = '';
      const s = steps[step];
      if (!s) return;
      if (code !== s.expect) return fail(new Error(`SMTP step ${step}: expected ${s.expect}, got "${last}"`));
      socket.write(s.send());
      if (s.done) { socket.end(); resolve(true); }
      step++;
    });
  });
}

// ---------------------------------------------------------------- WEB PUSH (RFC 8291 + VAPID, zero-dep)
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (str) => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// One VAPID keypair per install, generated on first use and stored in settings.
function getVapid() {
  let pub = getSetting('vapid_public'), priv = getSetting('vapid_private');
  if (!pub || !priv) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    pub = b64url(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)); // uncompressed point
    priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    setSetting('vapid_public', pub); setSetting('vapid_private', priv);
  }
  return { pub, priv };
}
function vapidJwt(audience) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64url(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: 'mailto:' + (getSetting('smtp_from') || getSetting('smtp_user') || 'admin@laxorq.local'),
  }));
  const key = crypto.createPrivateKey({ key: Buffer.from(getVapid().priv, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('SHA256', Buffer.from(header + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${b64url(sig)}`;
}
// RFC 8291 payload encryption (aes128gcm)
function encryptPush(payload, p256dhB64, authB64) {
  const uaPublic = b64urlDecode(p256dhB64);
  const authSecret = b64urlDecode(authB64);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([0x02])]); // single-record delimiter
  const enc = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.concat([salt, Buffer.from([0, 0, 0x10, 0]), Buffer.from([asPublic.length]), asPublic]); // rs=4096
  return Buffer.concat([head, enc]);
}
async function sendPush(sub, payloadObj) {
  const body = encryptPush(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      'Authorization': `vapid t=${vapidJwt(new URL(sub.endpoint).origin)}, k=${getVapid().pub}`,
    },
    body,
  });
  if (res.status === 404 || res.status === 410) db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(sub.endpoint);
  return res.status;
}
// Notify everyone who should hear about this client: the client's own logins + all owners.
async function notifyClient(clientId, payloadObj) {
  const subs = db.prepare(
    "SELECT ps.* FROM push_subs ps JOIN users u ON u.id = ps.user_id WHERE u.role = 'owner' OR u.client_id = ?"
  ).all(clientId);
  for (const s of subs) { try { await sendPush(s, payloadObj); } catch (e) { console.error('push send:', e.message); } }
}

// ---------------------------------------------------------------- LEAD PIPELINE
function isoPlus(ms) { return new Date(Date.now() + ms).toISOString(); }

async function processNewLead(leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  const client = q.clientById.get(lead.client_id);
  const tpl = clientTemplates(client);

  let qual = await aiQualify(lead, client);
  const aiReply = qual?.reply;
  if (!qual) qual = ruleQualify(lead);
  db.prepare('UPDATE leads SET score = ?, score_reason = ? WHERE id = ?').run(qual.score, qual.reason, lead.id);
  const flame = qual.score === 'hot' ? ' 🔥' : '';
  addEvent(client.id, lead.id, 'lead', `<strong>New lead:</strong> ${esc(lead.name) || 'Unknown'} submitted an enquiry — qualified as ${qual.score[0].toUpperCase() + qual.score.slice(1)}${flame}`);
  if (qual.score === 'hot') notifyClient(client.id, { title: '🔥 Hot lead — take over', body: `${lead.name || 'A new lead'} needs a personal reply now`, url: '/' }).catch(() => {});

  if (wfEnabled(client.id, 'instant_reply')) {
    const body = aiReply || fillTemplate(tpl.instant_reply, lead, client);
    const channel = lead.phone ? 'whatsapp' : 'email';
    const tr = db.prepare('INSERT INTO touches (lead_id, touch_no, channel, subject, body, due_at, status) VALUES (?,?,?,?,?,?,?)')
      .run(lead.id, 0, channel, `Re: your enquiry with ${client.name}`, body, now(), 'due');
    await trySendTouch(Number(tr.lastInsertRowid));
  }

  if (wfEnabled(client.id, 'followup')) {
    const seq = [
      [1, 'whatsapp', '', fillTemplate(tpl.touch1_whatsapp, lead, client), 1 * DAY],
      [2, 'email', fillTemplate(tpl.touch2_email_subject, lead, client), fillTemplate(tpl.touch2_email, lead, client), 3 * DAY],
      [3, 'call', '', fillTemplate(tpl.touch3_call, lead, client), 7 * DAY],
    ];
    for (const [no, channel, subject, body, delay] of seq) {
      db.prepare('INSERT INTO touches (lead_id, touch_no, channel, subject, body, due_at, status) VALUES (?,?,?,?,?,?,?)')
        .run(lead.id, no, channel, subject, body, isoPlus(delay), 'scheduled');
    }
  }

  if (qual.score === 'hot' && wfEnabled(client.id, 'notify_owner') && client.owner_email && smtpConfig()) {
    try {
      await sendEmail({
        to: client.owner_email,
        subject: `Hot lead: ${lead.name || 'New enquiry'} — ${client.name}`,
        body: `New hot lead captured by Laxorq Automate.\n\nName: ${lead.name}\nPhone: ${lead.phone}\nEmail: ${lead.email}\nMessage: ${lead.message}\n\nWhy hot: ${qual.reason}`,
      });
      addEvent(client.id, lead.id, 'msg', `<strong>Owner notified</strong> about hot lead ${esc(lead.name)} by email`);
    } catch (e) { console.error('Owner notify failed:', e.message); }
  }
}

async function trySendTouch(touchId) {
  const t = db.prepare('SELECT * FROM touches WHERE id = ?').get(touchId);
  if (!t || t.status === 'sent' || t.status === 'cancelled') return;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(t.lead_id);
  const client = q.clientById.get(lead.client_id);
  if (t.channel === 'email' && lead.email && smtpConfig()) {
    try {
      await sendEmail({ to: lead.email, subject: t.subject || `Message from ${client.name}`, body: t.body });
      db.prepare("UPDATE touches SET status = 'sent', sent_at = ?, auto = 1 WHERE id = ?").run(now(), t.id);
      const label = t.touch_no === 0 ? '<strong>AI replied</strong> to' : `<strong>Follow-up sent</strong> (Touch ${t.touch_no} email) to`;
      addEvent(client.id, lead.id, t.touch_no === 0 ? 'msg' : 'followup', `${label} ${esc(lead.name || lead.email)} automatically`);
      return;
    } catch (e) { console.error(`Auto-send touch ${t.id} failed:`, e.message); }
  }
  db.prepare("UPDATE touches SET status = 'due' WHERE id = ? AND status = 'scheduled'").run(t.id);
}

function cancelPendingTouches(leadId) {
  db.prepare("UPDATE touches SET status = 'cancelled' WHERE lead_id = ? AND status IN ('scheduled','due')").run(leadId);
}

async function tick() {
  const due = db.prepare(
    "SELECT t.id FROM touches t JOIN leads l ON l.id = t.lead_id WHERE t.status = 'scheduled' AND t.due_at <= ? AND l.status = 'new'"
  ).all(now());
  for (const row of due) await trySendTouch(row.id);

  const doneLeads = db.prepare(
    "SELECT DISTINCT l.id, l.client_id, l.name FROM leads l JOIN touches t ON t.lead_id = l.id WHERE l.status = 'new' AND t.touch_no = 3 AND t.status IN ('sent','skipped')"
  ).all();
  for (const l of doneLeads) {
    db.prepare("UPDATE leads SET status = 'archived' WHERE id = ?").run(l.id);
    cancelPendingTouches(l.id);
    addEvent(l.client_id, l.id, 'system', `<strong>Sequence complete:</strong> ${esc(l.name) || 'Lead'} archived after 3 touches with no reply`);
  }
}
setInterval(() => tick().catch(e => console.error('tick error:', e)), 30000);

// ---------------------------------------------------------------- ANALYTICS
function analyticsFor(cid) {
  const leads = db.prepare('SELECT * FROM leads WHERE client_id = ?').all(cid);
  const sentTouches = db.prepare(
    "SELECT t.*, l.created_at AS lead_created FROM touches t JOIN leads l ON l.id = t.lead_id WHERE l.client_id = ? AND t.status = 'sent'"
  ).all(cid);
  const total = leads.length;
  const count = (fn) => leads.filter(fn).length;

  const contactedIds = new Set(sentTouches.map(t => t.lead_id));
  const responded = count(l => l.status === 'replied' || l.status === 'booked');
  const booked = count(l => l.status === 'booked');
  const revenue = leads.filter(l => l.status === 'booked').reduce((s, l) => s + (l.value || 0), 0);

  // avg first-response time from instant reply
  const instant = sentTouches.filter(t => t.touch_no === 0);
  const respMs = instant.map(t => new Date(t.sent_at) - new Date(t.lead_created)).filter(x => x >= 0);
  const avgRespSec = respMs.length ? Math.round(respMs.reduce((a, b) => a + b, 0) / respMs.length / 1000) : null;

  const bucket = (arr, key) => {
    const m = {};
    for (const x of arr) { const k = x[key] || 'unknown'; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: k, count: v }));
  };

  // 30-day trend of leads + conversions
  const trend = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - i);
    const next = new Date(day); next.setDate(next.getDate() + 1);
    const inDay = (iso) => { const t = new Date(iso); return t >= day && t < next; };
    trend.push({
      date: day.toISOString().slice(0, 10),
      label: day.toLocaleDateString('en-SG', { day: 'numeric', month: 'short' }),
      leads: leads.filter(l => inDay(l.created_at)).length,
      conversions: leads.filter(l => l.status === 'booked' && l.replied_at && inDay(l.replied_at)).length,
    });
  }

  // Monthly booking rate (bookings vs leads) — last 6 months, so clients can see
  // whether their marketing is turning into actual bookings month over month.
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - i);
    const next = new Date(d); next.setMonth(next.getMonth() + 1);
    const inM = (iso) => { if (!iso) return false; const t = new Date(iso); return t >= d && t < next; };
    const leadsM = leads.filter(l => inM(l.created_at)).length;
    const booksM = leads.filter(l => l.status === 'booked' && inM(l.replied_at)).length;
    months.push({
      label: d.toLocaleDateString('en-SG', { month: 'short' }),
      key: d.toISOString().slice(0, 7),
      leads: leadsM, bookings: booksM,
      rate: leadsM ? Math.round(1000 * booksM / leadsM) / 10 : 0,
    });
  }
  const upcomingBookings = leads.filter(l => l.status === 'booked' && l.appt_at && new Date(l.appt_at) >= new Date()).length;

  // Website tracking: visits (from the pixel snippet) → leads that came from the site
  const monthStart = (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.toISOString(); })();
  const visitsTotal = db.prepare('SELECT COUNT(*) AS c FROM visits WHERE client_id = ?').get(cid).c;
  const visitsMonth = db.prepare('SELECT COUNT(*) AS c FROM visits WHERE client_id = ? AND created_at >= ?').get(cid, monthStart).c;
  const siteLeads = leads.filter(l => l.source === 'form' || (l.source && l.source.includes('.'))).length;
  const website = (q.clientById.get(cid) || {}).website || '';

  const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
  const monthAgo = new Date(Date.now() - 30 * DAY).toISOString();
  return {
    total,
    leads_week: count(l => l.created_at >= weekAgo),
    leads_month: count(l => l.created_at >= monthAgo),
    funnel: {
      captured: total,
      contacted: contactedIds.size,
      responded,
      booked,
    },
    conversion_rate: total ? Math.round(1000 * booked / total) / 10 : 0,
    reply_rate: total ? Math.round(1000 * responded / total) / 10 : 0,
    avg_response_sec: avgRespSec,
    revenue,
    by_source: bucket(leads, 'source'),
    by_score: ['hot', 'warm', 'cold'].map(s => ({ label: s, count: count(l => l.score === s) })),
    by_status: ['new', 'replied', 'booked', 'dead', 'archived'].map(s => ({ label: s, count: count(l => l.status === s) })),
    trend,
    by_month: months,
    this_month: months[5],
    last_month: months[4],
    upcoming_bookings: upcomingBookings,
    website,
    visits_total: visitsTotal,
    visits_month: visitsMonth,
    site_leads: siteLeads,
    visit_to_lead: visitsTotal ? Math.round(1000 * siteLeads / visitsTotal) / 10 : null,
  };
}

// ---------------------------------------------------------------- HTTP SERVER
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, { 'content-type': typeof data === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function sendFile(res, filePath, extra = {}) {
  if (!fs.existsSync(filePath)) return send(res, 404, { error: 'not found' });
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', ...extra });
  res.end(fs.readFileSync(filePath));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    // ---- static pages + PWA assets
    if (req.method === 'GET' && (p === '/' || p === '/index.html'))
      return sendFile(res, path.join(PUBLIC_DIR, 'app.html'));
    if (req.method === 'GET' && p === '/form')
      return sendFile(res, path.join(PUBLIC_DIR, 'form.html'));
    if (req.method === 'GET' && p === '/manifest.webmanifest')
      return sendFile(res, path.join(PUBLIC_DIR, 'manifest.webmanifest'));
    if (req.method === 'GET' && p === '/sw.js')
      return sendFile(res, path.join(PUBLIC_DIR, 'sw.js'), { 'service-worker-allowed': '/', 'cache-control': 'no-cache' });
    if (req.method === 'GET' && p.startsWith('/icons/')) {
      const name = path.basename(p);
      return sendFile(res, path.join(PUBLIC_DIR, 'icons', name), { 'cache-control': 'public, max-age=86400' });
    }
    if (req.method === 'GET' && p === '/favicon.ico')
      return sendFile(res, path.join(PUBLIC_DIR, 'icons', 'icon-32.png'));

    // ---- tracking pixel: clients paste <script src="/px.js?t=TOKEN"> on their site
    if (req.method === 'GET' && p === '/px.js') {
      const js = `(function(){try{var s=document.currentScript;var t=new URL(s.src).searchParams.get('t');if(!t)return;var base=s.src.split('/px.js')[0];fetch(base+'/api/public/track',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:JSON.stringify({token:t,path:location.pathname,ref:document.referrer})}).catch(function(){});}catch(e){}})();`;
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*' });
      return res.end(js);
    }

    // ---- health / version (public, used by the desktop app + update checks)
    if (req.method === 'GET' && p === '/api/health') {
      return send(res, 200, {
        ok: true, version: VERSION, schema_version: db.prepare('PRAGMA user_version').get().user_version,
        ai_ready: !!getSetting('anthropic_api_key'), smtp_ready: !!smtpConfig(),
        clients: db.prepare('SELECT COUNT(*) AS c FROM clients').get().c,
        users: db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
      });
    }

    // ---- public API (CORS open: the form may be embedded on client sites)
    if (p.startsWith('/api/public/')) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (req.method === 'GET' && p === '/api/public/forminfo') {
        const c = q.clientByToken.get(url.searchParams.get('t') || '');
        return c ? send(res, 200, { business: c.name }) : send(res, 404, { error: 'unknown form' });
      }
      if (req.method === 'POST' && p === '/api/public/lead') {
        const b = await readBody(req);
        const c = q.clientByToken.get(b.token || '');
        if (!c) return send(res, 404, { error: 'unknown form token' });
        if (!b.name && !b.email && !b.phone) return send(res, 400, { error: 'need at least a name, email or phone' });
        const r = db.prepare('INSERT INTO leads (client_id, name, email, phone, source, message, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(c.id, String(b.name || '').slice(0, 200), String(b.email || '').slice(0, 200), String(b.phone || '').slice(0, 50), String(b.source || 'form').slice(0, 50), String(b.message || '').slice(0, 4000), now());
        processNewLead(Number(r.lastInsertRowid)).catch(e => console.error('processNewLead:', e));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/public/track') {
        const b = await readBody(req);
        const c = q.clientByToken.get(b.token || '');
        if (!c) return send(res, 404, { error: 'unknown token' });
        db.prepare('INSERT INTO visits (client_id, path, referrer, created_at) VALUES (?,?,?,?)')
          .run(c.id, String(b.path || '').slice(0, 300), String(b.ref || '').slice(0, 300), now());
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }

    // ---- auth API (no session required)
    if (p.startsWith('/api/auth/')) {
      if (req.method === 'GET' && p === '/api/auth/state') {
        const setupNeeded = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
        return send(res, 200, { setup_needed: setupNeeded, user: sanitizeUser(currentUser(req)) });
      }
      if (req.method === 'POST' && p === '/api/auth/setup') {
        if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) return send(res, 403, { error: 'already set up' });
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase();
        if (!email || !b.password || String(b.password).length < 6) return send(res, 400, { error: 'email and a password of 6+ characters required' });
        const r = db.prepare('INSERT INTO users (email, pass_hash, role, client_id, name, created_at) VALUES (?,?,?,?,?,?)')
          .run(email, hashPw(b.password), 'owner', null, String(b.name || '').slice(0, 100), now());
        const token = createSession(Number(r.lastInsertRowid));
        return send(res, 200, { ok: true, user: sanitizeUser(currentUser({ headers: { cookie: 'sid=' + token } })) }, { 'set-cookie': sessionCookie(token, isSecure(req)) });
      }
      if (req.method === 'POST' && p === '/api/auth/login') {
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase();
        const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!u || !verifyPw(b.password, u.pass_hash)) return send(res, 401, { error: 'wrong email or password' });
        const token = createSession(u.id);
        return send(res, 200, { ok: true, user: sanitizeUser(u) }, { 'set-cookie': sessionCookie(token, isSecure(req)) });
      }
      if (req.method === 'POST' && p === '/api/auth/logout') {
        const sid = parseCookies(req).sid;
        if (sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(sid);
        return send(res, 200, { ok: true }, { 'set-cookie': `sid=; HttpOnly; Path=/; Max-Age=0` });
      }
      return send(res, 404, { error: 'not found' });
    }

    // ---- everything else under /api requires a logged-in user
    if (p.startsWith('/api/')) {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not logged in' });
      const ownerOnly = () => { if (user.role !== 'owner') { send(res, 403, { error: 'owner only' }); return true; } return false; };

      // -------- push notifications (owner + client, per device)
      if (req.method === 'GET' && p === '/api/push/vapid') {
        return send(res, 200, { publicKey: getVapid().pub });
      }
      if (req.method === 'POST' && p === '/api/push/subscribe') {
        const b = await readBody(req);
        const k = b.keys || {};
        if (!b.endpoint || !k.p256dh || !k.auth) return send(res, 400, { error: 'invalid subscription' });
        db.prepare('INSERT INTO push_subs (user_id, client_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, client_id=excluded.client_id, p256dh=excluded.p256dh, auth=excluded.auth')
          .run(user.id, user.client_id ?? null, String(b.endpoint), String(k.p256dh), String(k.auth), now());
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/push/test') {
        const subs = db.prepare('SELECT * FROM push_subs WHERE user_id = ?').all(user.id);
        if (!subs.length) return send(res, 400, { error: 'no device subscribed yet' });
        let ok = 0;
        for (const s of subs) { try { const st = await sendPush(s, { title: 'Laxorq Automate', body: 'Notifications are working on this device 🎉', url: '/' }); if (st < 300) ok++; } catch {} }
        return send(res, 200, { ok: true, sent: ok, devices: subs.length });
      }

      // -------- clients
      if (req.method === 'GET' && p === '/api/clients') {
        if (user.role === 'owner') return send(res, 200, db.prepare('SELECT * FROM clients ORDER BY id').all());
        const c = q.clientById.get(user.client_id);
        return send(res, 200, c ? [c] : []);
      }
      if (req.method === 'POST' && p === '/api/clients') {
        if (ownerOnly()) return;
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        return send(res, 200, createClient(b));
      }
      if (req.method === 'PATCH' && p.match(/^\/api\/clients\/\d+$/)) {
        if (ownerOnly()) return;
        const id = Number(p.split('/').pop());
        const b = await readBody(req);
        const c = q.clientById.get(id);
        if (!c) return send(res, 404, { error: 'no such client' });
        const s = JSON.parse(c.settings_json || '{}');
        if (b.templates) s.templates = { ...clientTemplates(c), ...b.templates };
        db.prepare('UPDATE clients SET name=?, niche=?, owner_name=?, owner_email=?, owner_whatsapp=?, website=?, settings_json=? WHERE id=?')
          .run(b.name ?? c.name, b.niche ?? c.niche, b.owner_name ?? c.owner_name, b.owner_email ?? c.owner_email, b.owner_whatsapp ?? c.owner_whatsapp, b.website ?? c.website, JSON.stringify(s), id);
        return send(res, 200, q.clientById.get(id));
      }

      // -------- client login accounts (owner only)
      if (req.method === 'GET' && p === '/api/users') {
        if (ownerOnly()) return;
        const rows = db.prepare("SELECT id, email, name, role, client_id, created_at FROM users WHERE role = 'client' ORDER BY id").all();
        return send(res, 200, rows);
      }
      if (req.method === 'POST' && p === '/api/users') {
        if (ownerOnly()) return;
        const b = await readBody(req);
        const email = String(b.email || '').trim().toLowerCase();
        const cid = Number(b.client_id);
        if (!email || !b.password || String(b.password).length < 6) return send(res, 400, { error: 'email and 6+ char password required' });
        if (!q.clientById.get(cid)) return send(res, 400, { error: 'valid client_id required' });
        if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return send(res, 400, { error: 'that email already has a login' });
        db.prepare('INSERT INTO users (email, pass_hash, role, client_id, name, created_at) VALUES (?,?,?,?,?,?)')
          .run(email, hashPw(b.password), 'client', cid, String(b.name || '').slice(0, 100), now());
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p.match(/^\/api\/users\/\d+\/password$/)) {
        if (ownerOnly()) return;
        const id = Number(p.split('/')[3]);
        const b = await readBody(req);
        if (!b.password || String(b.password).length < 6) return send(res, 400, { error: '6+ char password required' });
        const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'client'").get(id);
        if (!u) return send(res, 404, { error: 'no such client login' });
        db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPw(b.password), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && p.match(/^\/api\/users\/\d+$/)) {
        if (ownerOnly()) return;
        const id = Number(p.split('/').pop());
        db.prepare("DELETE FROM users WHERE id = ? AND role = 'client'").run(id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        return send(res, 200, { ok: true });
      }

      // -------- overview / analytics (owner: any client; client: own)
      if (req.method === 'GET' && p === '/api/overview') {
        const cid = resolveCid(user, url);
        if (!canAccessClient(user, cid)) return send(res, 403, { error: 'forbidden' });
        const leads = db.prepare('SELECT * FROM leads WHERE client_id = ?').all(cid);
        const touches = db.prepare('SELECT t.* FROM touches t JOIN leads l ON l.id = t.lead_id WHERE l.client_id = ?').all(cid);
        const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
        const sent = touches.filter(t => t.status === 'sent');
        const instant = sent.filter(t => t.touch_no === 0);
        const fastReplies = instant.filter(t => {
          const lead = leads.find(l => l.id === t.lead_id);
          return lead && (new Date(t.sent_at) - new Date(lead.created_at)) < 60000;
        });
        const afterHours = leads.filter(l => { const d = new Date(l.created_at); const h = d.getHours(); return h < 9 || h >= 18 || d.getDay() === 0; });
        const chart = [];
        for (let i = 6; i >= 0; i--) {
          const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - i);
          const next = new Date(day); next.setDate(next.getDate() + 1);
          chart.push({ label: i === 0 ? 'Today' : day.toLocaleDateString('en-SG', { weekday: 'short' }), count: leads.filter(l => { const t = new Date(l.created_at); return t >= day && t < next; }).length });
        }
        const workflows = db.prepare('SELECT key, enabled FROM workflows WHERE client_id = ?').all(cid);
        const feed = db.prepare('SELECT * FROM events WHERE client_id = ? ORDER BY id DESC LIMIT 20').all(cid);
        const dueCount = db.prepare("SELECT COUNT(*) AS c FROM touches t JOIN leads l ON l.id = t.lead_id WHERE l.client_id = ? AND t.status = 'due'").get(cid).c;
        return send(res, 200, {
          stats: {
            leads_total: leads.length,
            leads_week: leads.filter(l => l.created_at >= weekAgo).length,
            fast_reply_pct: instant.length ? Math.round(100 * fastReplies.length / instant.length) : null,
            followups_sent: sent.filter(t => t.touch_no > 0).length,
            after_hours: afterHours.length,
            re_engaged: leads.filter(l => l.status === 'replied' || l.status === 'booked').length,
          },
          chart, workflows, feed, dueCount,
          smtp_ready: !!smtpConfig(), ai_ready: !!getSetting('anthropic_api_key'),
        });
      }

      if (req.method === 'GET' && p === '/api/analytics') {
        const cid = resolveCid(user, url);
        if (!canAccessClient(user, cid)) return send(res, 403, { error: 'forbidden' });
        return send(res, 200, analyticsFor(cid));
      }

      if (req.method === 'GET' && p === '/api/bookings') {
        const cid = resolveCid(user, url);
        if (!canAccessClient(user, cid)) return send(res, 403, { error: 'forbidden' });
        const rows = db.prepare(
          "SELECT id, name, email, phone, value, appt_at, created_at, replied_at FROM leads WHERE client_id = ? AND status = 'booked' ORDER BY COALESCE(appt_at, replied_at) DESC"
        ).all(cid);
        return send(res, 200, rows.map(r => ({ ...r, wa: waDigits(r.phone) })));
      }

      // -------- leads
      if (req.method === 'GET' && p === '/api/leads') {
        const cid = resolveCid(user, url);
        if (!canAccessClient(user, cid)) return send(res, 403, { error: 'forbidden' });
        return send(res, 200, db.prepare('SELECT * FROM leads WHERE client_id = ? ORDER BY id DESC LIMIT 500').all(cid));
      }
      if (req.method === 'POST' && p === '/api/leads') {
        const b = await readBody(req);
        const cid = user.role === 'client' ? Number(user.client_id) : Number(b.client_id);
        if (!q.clientById.get(cid)) return send(res, 400, { error: 'client_id required' });
        if (!canAccessClient(user, cid)) return send(res, 403, { error: 'forbidden' });
        const r = db.prepare('INSERT INTO leads (client_id, name, email, phone, source, message, created_at) VALUES (?,?,?,?,?,?,?)')
          .run(cid, b.name || '', b.email || '', b.phone || '', b.source || 'manual', b.message || '', now());
        processNewLead(Number(r.lastInsertRowid)).catch(e => console.error('processNewLead:', e));
        return send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
      }
      if (req.method === 'GET' && p.match(/^\/api\/leads\/\d+$/)) {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(p.split('/').pop()));
        if (!lead) return send(res, 404, { error: 'no such lead' });
        if (!canAccessClient(user, lead.client_id)) return send(res, 403, { error: 'forbidden' });
        const touches = db.prepare('SELECT * FROM touches WHERE lead_id = ? ORDER BY touch_no').all(lead.id);
        return send(res, 200, { lead, touches, wa: waDigits(lead.phone) });
      }
      if (req.method === 'PATCH' && p.match(/^\/api\/leads\/\d+$/)) {
        const id = Number(p.split('/').pop());
        const b = await readBody(req);
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
        if (!lead) return send(res, 404, { error: 'no such lead' });
        if (!canAccessClient(user, lead.client_id)) return send(res, 403, { error: 'forbidden' });
        if (b.status && ['new', 'replied', 'booked', 'dead', 'archived'].includes(b.status)) {
          const val = b.value !== undefined ? Number(b.value) || 0 : lead.value;
          const appt = b.appt_at !== undefined ? (b.appt_at || null) : lead.appt_at;
          db.prepare('UPDATE leads SET status = ?, value = ?, appt_at = ?, replied_at = COALESCE(replied_at, ?) WHERE id = ?')
            .run(b.status, val, appt, ['replied', 'booked'].includes(b.status) ? now() : null, id);
          if (b.status !== 'new') cancelPendingTouches(id);
          if (b.status === 'replied') addEvent(lead.client_id, id, 'lead', `<strong>Re-engaged:</strong> ${esc(lead.name) || 'Lead'} replied — follow-ups cancelled`);
          if (b.status === 'booked') {
            const when = appt ? ' for ' + new Date(appt).toLocaleString('en-SG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
            addEvent(lead.client_id, id, 'lead', `<strong>Booked:</strong> ${esc(lead.name) || 'Lead'} converted${val ? ' ($' + val + ')' : ''}${when} 🎉`);
            notifyClient(lead.client_id, { title: '📅 New booking', body: `${lead.name || 'A lead'} is booked${when}`, url: '/' }).catch(() => {});
          }
          if (b.status === 'dead') addEvent(lead.client_id, id, 'system', `${esc(lead.name) || 'Lead'} marked dead — sequence stopped`);
        } else if (b.appt_at !== undefined) {
          // reschedule an existing booking without changing status
          db.prepare('UPDATE leads SET appt_at = ? WHERE id = ?').run(b.appt_at || null, id);
        }
        return send(res, 200, { ok: true });
      }

      // -------- follow-up queue
      if (req.method === 'GET' && p === '/api/queue') {
        const cid = resolveCid(user, url);
        if (!canAccessClient(user, cid)) return send(res, 403, { error: 'forbidden' });
        const rows = db.prepare(
          `SELECT t.*, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email, l.score AS lead_score
           FROM touches t JOIN leads l ON l.id = t.lead_id
           WHERE l.client_id = ? AND t.status = 'due' ORDER BY t.due_at`
        ).all(cid);
        return send(res, 200, rows.map(r => ({ ...r, wa: waDigits(r.lead_phone) })));
      }
      if (req.method === 'PATCH' && p.match(/^\/api\/touches\/\d+$/)) {
        const id = Number(p.split('/').pop());
        const b = await readBody(req);
        const t = db.prepare('SELECT * FROM touches WHERE id = ?').get(id);
        if (!t) return send(res, 404, { error: 'no such touch' });
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(t.lead_id);
        if (!canAccessClient(user, lead.client_id)) return send(res, 403, { error: 'forbidden' });
        if (b.action === 'sent') {
          db.prepare("UPDATE touches SET status = 'sent', sent_at = ? WHERE id = ?").run(now(), id);
          const what = t.touch_no === 0 ? 'Instant reply' : `Follow-up Touch ${t.touch_no} (${t.channel})`;
          addEvent(lead.client_id, lead.id, t.touch_no === 0 ? 'msg' : 'followup', `<strong>${what} sent</strong> to ${esc(lead.name) || 'lead'}`);
        } else if (b.action === 'skip') {
          db.prepare("UPDATE touches SET status = 'skipped' WHERE id = ?").run(id);
        } else if (b.action === 'send_now' && t.channel === 'email') {
          if (!smtpConfig()) return send(res, 400, { error: 'SMTP not configured (Settings page)' });
          await sendEmail({ to: lead.email, subject: t.subject || 'Following up', body: t.body });
          db.prepare("UPDATE touches SET status = 'sent', sent_at = ?, auto = 1 WHERE id = ?").run(now(), id);
          addEvent(lead.client_id, lead.id, 'followup', `<strong>Email sent</strong> to ${esc(lead.name || lead.email)} (Touch ${t.touch_no})`);
        } else if (b.body !== undefined) {
          db.prepare('UPDATE touches SET body = ? WHERE id = ?').run(String(b.body), id);
        }
        return send(res, 200, { ok: true });
      }

      // -------- workflow toggles (owner only)
      if (req.method === 'POST' && p === '/api/workflows/toggle') {
        if (ownerOnly()) return;
        const b = await readBody(req);
        db.prepare('INSERT INTO workflows (client_id, key, enabled) VALUES (?,?,?) ON CONFLICT(client_id, key) DO UPDATE SET enabled = excluded.enabled')
          .run(Number(b.client_id), String(b.key), b.enabled ? 1 : 0);
        return send(res, 200, { ok: true });
      }

      // -------- settings (owner only — this is your infrastructure)
      if (req.method === 'GET' && p === '/api/settings') {
        if (ownerOnly()) return;
        return send(res, 200, {
          smtp_host: getSetting('smtp_host'), smtp_port: getSetting('smtp_port', '465'),
          smtp_user: getSetting('smtp_user'), smtp_pass: getSetting('smtp_pass') ? '••••••••' : '',
          smtp_from: getSetting('smtp_from'),
          anthropic_api_key: getSetting('anthropic_api_key') ? '••••••••' : '',
        });
      }
      if (req.method === 'POST' && p === '/api/settings') {
        if (ownerOnly()) return;
        const b = await readBody(req);
        for (const k of ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_from']) if (b[k] !== undefined) setSetting(k, b[k]);
        for (const k of ['smtp_pass', 'anthropic_api_key']) if (b[k] && !b[k].startsWith('•')) setSetting(k, b[k]);
        if (b.smtp_pass === '') setSetting('smtp_pass', '');
        if (b.anthropic_api_key === '') setSetting('anthropic_api_key', '');
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/test-email') {
        if (ownerOnly()) return;
        const b = await readBody(req);
        try { await sendEmail({ to: b.to, subject: 'Laxorq Automate test email', body: 'If you are reading this, SMTP is working.' }); return send(res, 200, { ok: true }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }

      return send(res, 404, { error: 'not found' });
    }

    return send(res, 404, '<h1>Not found</h1>');
  } catch (e) {
    console.error(req.method, p, e);
    return send(res, 500, { error: e.message });
  }
});

// Start the server. Exported so the desktop (Electron) build can boot it in-process
// and know when it is ready; still auto-starts when run directly via `node server.js`.
function start() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      console.log(`Laxorq Automate v${VERSION} running -> http://localhost:${PORT}`);
      console.log(`Lead forms served at        -> http://localhost:${PORT}/form?t=<client form token>`);
      tick().catch(() => {});
      resolve({ port: PORT, version: VERSION });
    });
  });
}

if (require.main === module) start().catch(e => { console.error('Failed to start:', e.message); process.exit(1); });

module.exports = { start, PORT, VERSION };
