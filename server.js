// 爽栖林城 · 问小栖后端（腾讯云 CloudBase 云托管版）
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const https = require('https');

// 数据持久化
const DATA_DIR = process.env.DATA_DIR || '/tmp/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'shuangqi-data.json');

let data = { questions: [], answers: [], reports: [], rooms: [], bookings: [], stats: {} };
function loadData() { try { if (fs.existsSync(DATA_FILE)) { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } } catch(e) {} }
let saveTimer = null;
function saveData() { if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch(e) {} }, 500); }
loadData();

const cfg = { endpoint: process.env.LLM_ENDPOINT || 'https://api.deepseek.com/chat/completions', key: process.env.LLM_KEY || '', model: process.env.LLM_MODEL || 'deepseek-chat' };
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'sq2026xq';
const CORS_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
function send(res, code, obj) { res.writeHead(code, CORS_HEADERS); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch(e) { resolve({}); } }); }); }
function apiName(p) { const m = p.match(/\/api\/([a-z]+)/); return m ? m[1] : ''; }
function callLLM(messages, model) { if (!cfg.key) return Promise.reject(new Error('服务端未配置 LLM key')); const data = JSON.stringify({ model: model || cfg.model, messages: messages, stream: false }); return new Promise((resolve, reject) => { const u = new URL(cfg.endpoint); const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key } }, (r) => { let buf = ''; r.on('data', d => buf += d); r.on('end', () => { try { const j = JSON.parse(buf); const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; resolve(c || ''); } catch(e) { reject(e); } }); }); req.on('error', reject); req.write(data); req.end(); }); }

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return send(res, 204, {});
  const api = apiName(pathname);
  const body = method === 'POST' ? await readBody(req) : {};
  try {
    if (api === 'health') return send(res, 200, { ok: true, model: cfg.model, data: { q: data.questions.length, r: data.reports.length, a: data.answers.length } });

    if (api === 'chat' && method === 'POST') { const content = await callLLM(body.messages || [], body.model); return send(res, 200, { content }); }

    if (api === 'q') {
      if (method === 'POST') { const item = { id: body.t || Date.now(), q: body.q || '', t: body.t || Date.now(), clientId: body.clientId || '', status: 'pending', answer: null }; data.questions.push(item); saveData(); return send(res, 200, { ok: true, id: item.id }); }
      if (method === 'GET') { const since = Number(query.since) || 0; const cid = query.cid; let qs = data.questions.filter(q => q.t > since); if (cid) qs = qs.filter(q => q.clientId === cid); return send(res, 200, { questions: qs }); }
    }

    if (api === 'a') {
      if (method === 'GET' && String(query.write) === '1') { if (!ADMIN_TOKEN || query.token !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); const qid = query.id; if (!qid) return send(res, 400, { error: 'missing id' }); data.answers.push({ qid: qid, a: query.a || '', t: Date.now() }); const q = data.questions.find(x => String(x.id) === String(qid)); if (q) { q.status = 'answered'; q.answer = query.a || ''; } saveData(); return send(res, 200, { ok: true }); }
      if (method === 'POST') { data.answers.push({ qid: body.id, a: body.a || '', t: Date.now() }); const q = data.questions.find(x => String(x.id) === String(body.id)); if (q) { q.status = 'answered'; q.answer = body.a; } saveData(); return send(res, 200, { ok: true }); }
      if (method === 'GET') { const since = Number(query.since) || 0; const cid = query.cid; let answers = data.answers.filter(a => a.t > since); if (cid) { const qids = new Set(data.questions.filter(q => q.clientId === cid).map(x => String(x.id))); answers = answers.filter(a => qids.has(String(a.qid))); } return send(res, 200, { answers }); }
    }

    if (api === 'reports') {
      if (method === 'GET' && String(query.write) === '1') { if (!ADMIN_TOKEN || query.token !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); data.reports.push({ title: query.title || '', category: query.category || '资讯', content: query.content || '', source: query.source || '小栖', time: Date.now() }); saveData(); return send(res, 200, { ok: true }); }
      if (method === 'POST') { if (!ADMIN_TOKEN || (body.token || '') !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); data.reports.push({ title: body.title || '', category: body.category || '资讯', content: body.content || '', source: body.source || '小栖', time: Date.now() }); saveData(); return send(res, 200, { ok: true }); }
      const since = Number(query.since) || 0; const reports = data.reports.filter(r => r.time > since).sort((a, b) => b.time - a.time).slice(0, 100); return send(res, 200, { reports });
    }

    if (api === 'rooms') {
      if (method === 'POST') { if (!ADMIN_TOKEN || (body.token || '') !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); const room = { ...body, id: body.id || Date.now(), updatedAt: Date.now() }; const idx = data.rooms.findIndex(r => String(r.id) === String(room.id)); if (idx >= 0) data.rooms[idx] = room; else data.rooms.push(room); saveData(); return send(res, 200, { ok: true, room }); }
      if (method === 'GET') { const id = query.id; if (id) { const room = data.rooms.find(r => String(r.id) === String(id)); return send(res, 200, { room: room || null }); } return send(res, 200, { rooms: data.rooms }); }
    }

    if (api === 'bookings') {
      if (method === 'POST') { if (!ADMIN_TOKEN || (body.token || '') !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); const booking = { ...body, id: body.id || Date.now(), createdAt: Date.now() }; const idx = data.bookings.findIndex(b => String(b.id) === String(booking.id)); if (idx >= 0) data.bookings[idx] = booking; else data.bookings.push(booking); saveData(); return send(res, 200, { ok: true, booking }); }
      if (method === 'GET') { const roomId = query.roomId; const status = query.status; let bs = data.bookings; if (roomId) bs = bs.filter(b => String(b.roomId) === String(roomId)); if (status) bs = bs.filter(b => b.status === status); return send(res, 200, { bookings: bs }); }
    }

    if (api === 'stats') {
      if (method === 'POST') { if (!ADMIN_TOKEN || (body.token || '') !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); data.stats = { ...data.stats, ...body, updatedAt: Date.now() }; saveData(); return send(res, 200, { ok: true }); }
      return send(res, 200, { stats: data.stats });
    }

    return send(res, 404, { error: 'not found', path: pathname });
  } catch (e) { console.error('API error:', e); return send(res, 500, { error: String((e && e.message) || e) }); }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log('shuangqi-xiaoqi server running on port ' + PORT); });
