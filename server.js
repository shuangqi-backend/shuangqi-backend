// 爽栖林城 · 问小栖后端（腾讯云 CloudBase 云托管版）
const http = require('http');
const url = require('url');
const tcb = require('@cloudbase/node-sdk');
const https = require('https');

// 云托管容器需要显式凭证：env + CAM密钥
// 环境变量 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY 已在云托管控制台配置
const app = tcb.init({
  env: 'shuangqi-d4gq36kcz9245cc95',
  secretId: process.env.TENCENTCLOUD_SECRETID,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY
});
const db = app.database();
const _ = db.command;

const cfg = {
  endpoint: process.env.LLM_ENDPOINT || 'https://api.deepseek.com/chat/completions',
  key: process.env.LLM_KEY || '',
  model: process.env.LLM_MODEL || 'deepseek-chat'
};
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'sq2026xq';

const CORS_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
function send(res, code, obj) { res.writeHead(code, CORS_HEADERS); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((resolve) => { let data = ''; req.on('data', chunk => data += chunk); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } }); }); }
function apiName(pathname) { const m = pathname.match(/\/api\/([a-z]+)/); return m ? m[1] : ''; }
function callLLM(messages, model) { if (!cfg.key) return Promise.reject(new Error('服务端未配置 LLM key')); const data = JSON.stringify({ model: model || cfg.model, messages: messages, stream: false }); return new Promise((resolve, reject) => { const u = new URL(cfg.endpoint); const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key } }, (r) => { let buf = ''; r.on('data', d => buf += d); r.on('end', () => { try { const j = JSON.parse(buf); const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content; resolve(c || ''); } catch (e) { reject(e); } }); }); req.on('error', reject); req.write(data); req.end(); }); }

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return send(res, 204, {});
  const api = apiName(pathname);
  const body = method === 'POST' ? await readBody(req) : {};
  try {
    if (api === 'health') return send(res, 200, { ok: true, model: cfg.model });

    if (api === 'chat' && method === 'POST') { const content = await callLLM(body.messages || [], body.model); return send(res, 200, { content }); }

    if (api === 'q') {
      if (method === 'POST') { const item = { id: body.t || Date.now(), q: body.q || '', t: body.t || Date.now(), clientId: body.clientId || '', status: 'pending', answer: null }; await db.collection('questions').add({ data: item }); return send(res, 200, { ok: true, id: item.id }); }
      if (method === 'GET') { const since = Number(query.since) || 0; const cid = query.cid; let q = db.collection('questions').where({ t: _.gt(since) }); if (cid) q = q.where({ clientId: cid }); const result = await q.get(); return send(res, 200, { questions: result.data }); }
    }

    if (api === 'a') {
      if (method === 'GET' && String(query.write) === '1') { if (!ADMIN_TOKEN || query.token !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); const qid = query.id; if (!qid) return send(res, 400, { error: 'missing id' }); await db.collection('answers').add({ data: { qid: qid, a: query.a || '', t: Date.now() } }); await db.collection('questions').where({ id: qid }).update({ data: { status: 'answered', answer: query.a || '' } }); return send(res, 200, { ok: true }); }
      if (method === 'POST') { await db.collection('answers').add({ data: { qid: body.id, a: body.a || '', t: Date.now() } }); await db.collection('questions').where({ id: body.id }).update({ data: { status: 'answered', answer: body.a } }); return send(res, 200, { ok: true }); }
      if (method === 'GET') { const since = Number(query.since) || 0; const cid = query.cid; const result = await db.collection('answers').where({ t: _.gt(since) }).get(); let answers = result.data; if (cid) { const qs = await db.collection('questions').where({ clientId: cid }).get(); const ids = new Set(qs.data.map(x => String(x.id))); answers = answers.filter(a => ids.has(String(a.qid))); } return send(res, 200, { answers }); }
    }

    if (api === 'reports') {
      if (method === 'GET' && String(query.write) === '1') { if (!ADMIN_TOKEN || query.token !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); await db.collection('reports').add({ data: { title: query.title || '', category: query.category || '资讯', content: query.content || '', source: query.source || '小栖', time: Date.now() } }); return send(res, 200, { ok: true }); }
      if (method === 'POST') { if (!ADMIN_TOKEN || (body.token || '') !== ADMIN_TOKEN) return send(res, 403, { error: 'forbidden' }); await db.collection('reports').add({ data: { title: body.title || '', category: body.category || '资讯', content: body.content || '', source: body.source || '小栖', time: Date.now() } }); return send(res, 200, { ok: true }); }
      const since = Number(query.since) || 0; const result = await db.collection('reports').where({ time: _.gt(since) }).orderBy('time', 'desc').limit(100).get(); return send(res, 200, { reports: result.data });
    }

    return send(res, 404, { error: 'not found', path: pathname });
  } catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log('shuangqi-xiaoqi server running on port ' + PORT); });
