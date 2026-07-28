// 爽栖林城 · 问小栖后端（零依赖 Node.js）
// 功能：① 静态托管前端  ② 大模型代理 /api/chat（隐藏密钥、绕开浏览器 CORS）
//       ③ 问题同步 /api/q、/api/a（手机发问 → 电脑端小栖跟进）
// 运行：node server.js   （需 Node 18+）
// 配置：复制本文件同目录 server.config.json 填 key，或用环境变量 LLM_KEY 等

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------- 配置 ----------
const CONFIG_PATH = path.join(__dirname, 'server.config.json');
let cfg = {
  endpoint: 'https://api.deepseek.com/chat/completions',
  key: '',
  model: 'deepseek-chat'
};
try {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  Object.assign(cfg, c);
} catch (e) { /* 用默认或环境变量 */ }
if (process.env.LLM_ENDPOINT) cfg.endpoint = process.env.LLM_ENDPOINT;
if (process.env.LLM_KEY) cfg.key = process.env.LLM_KEY;
if (process.env.LLM_MODEL) cfg.model = process.env.LLM_MODEL;

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR); } catch (e) {}
const QFILE = path.join(DATA_DIR, 'questions.json');
const AFILE = path.join(DATA_DIR, 'answers.json');

function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } }
function writeJson(f, o) { try { fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch (e) {} }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJson(res, code, obj) {
  setCORS(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let b = '';
  req.on('data', d => b += d);
  req.on('end', () => { try { cb(null, JSON.parse(b || '{}')); } catch (e) { cb(e); } });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function callLLM(messages, model, cb) {
  if (!cfg.key) { cb(new Error('服务端未配置 LLM key')); return; }
  const body = JSON.stringify({ model: model || cfg.model, messages: messages, stream: false });
  const req = https.request(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key }
  }, (r) => {
    let buf = '';
    r.on('data', d => buf += d);
    r.on('end', () => {
      try {
        const j = JSON.parse(buf);
        const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        cb(null, c || '');
      } catch (e) { cb(e); }
    });
  });
  req.on('error', cb);
  req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (req.method === 'OPTIONS') { setCORS(res); res.writeHead(204); res.end(); return; }

  if (p === '/api/health') return sendJson(res, 200, { ok: true, model: cfg.model });

  if (p === '/api/chat' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'bad body' });
      callLLM(body.messages || [], body.model, (e, content) => {
        if (e) return sendJson(res, 502, { error: String(e) });
        sendJson(res, 200, { content: content });
      });
    });
  }

  if (p === '/api/q' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'bad body' });
      const qs = readJson(QFILE, []);
      const item = { id: body.t || Date.now(), q: body.q || '', t: body.t || Date.now(), clientId: body.clientId || '', status: 'pending', answer: null };
      qs.push(item); writeJson(QFILE, qs);
      sendJson(res, 200, { ok: true, id: item.id });
    });
  }
  if (p === '/api/q' && req.method === 'GET') {
    const since = Number(u.searchParams.get('since')) || 0;
    const cid = u.searchParams.get('cid');
    const qs = readJson(QFILE, []).filter(x => x.t > since && (!cid || x.clientId === cid));
    return sendJson(res, 200, { questions: qs });
  }

  if (p === '/api/a' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'bad body' });
      const as = readJson(AFILE, []);
      as.push({ qid: body.id, a: body.a || '', t: Date.now() }); writeJson(AFILE, as);
      const qs = readJson(QFILE, []);
      const q = qs.find(x => x.id == body.id);
      if (q) { q.status = 'answered'; q.answer = body.a; writeJson(QFILE, qs); }
      sendJson(res, 200, { ok: true });
    });
  }
  if (p === '/api/a' && req.method === 'GET') {
    const since = Number(u.searchParams.get('since')) || 0;
    const cid = u.searchParams.get('cid');
    let as = readJson(AFILE, []).filter(x => x.t > since);
    if (cid) {
      const ids = new Set(readJson(QFILE, []).filter(q => q.clientId === cid).map(q => String(q.id)));
      as = as.filter(a => ids.has(String(a.qid)));
    }
    return sendJson(res, 200, { answers: as });
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log('爽栖林城后端已启动 → http://localhost:' + PORT + '  (model: ' + cfg.model + ')');
});
