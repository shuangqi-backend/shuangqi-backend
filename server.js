// 爽栖林城 · 问小栖后端（腾讯云 CloudBase 云托管版）
// 部署：CloudBase 云托管（Docker容器），自带HTTPS域名，不需要HTTP网关。
// 依赖：@cloudbase/node-sdk
// 环境变量：ADMIN_TOKEN / LLM_KEY / LLM_ENDPOINT / LLM_MODEL / TCB_ENV
// 初始化：云托管容器内 tcb.init() 自动读取内置凭证，无需手动配置密钥

const http = require('http');
const url = require('url');
const tcb = require('@cloudbase/node-sdk');
const https = require('https');

// 云托管容器内自动获取当前环境凭证（免签名方式）
const app = tcb.init();
const db = app.database();
const _ = db.command;

const cfg = {
  endpoint: process.env.LLM_ENDPOINT || 'https://api.deepseek.com/chat/completions',
  key: process.env.LLM_KEY || '',
  model: process.env.LLM_MODEL || 'deepseek-chat'
};

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function send(code, obj) {
  return {
    statusCode: code,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify(obj)
  };
}

function parseEvent(event) {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const path = event.path || '/';
  const query = event.queryStringParameters || event.queryString || {};
  let body = {};
  if (event.body) {
    if (typeof event.body === 'string') {
      try { body = JSON.parse(event.body); } catch (e) {}
    } else {
      body = event.body;
    }
  }
  return { method, path, query, body };
}

function callLLM(messages, model) {
  if (!cfg.key) return Promise.reject(new Error('服务端未配置 LLM key'));
  const data = JSON.stringify({ model: model || cfg.model, messages: messages, stream: false });
  return new Promise((resolve, reject) => {
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
          resolve(c || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function apiName(path) {
  const m = path.match(/\/api\/([a-z]+)/);
  return m ? m[1] : '';
}

exports.main = async (event, context) => {
  const { method, path, query, body } = parseEvent(event);

  if (method === 'OPTIONS') return send(204, {});

  const api = apiName(path);

  try {
    if (api === 'health') return send(200, { ok: true, model: cfg.model });

    if (api === 'chat' && method === 'POST') {
      const content = await callLLM(body.messages || [], body.model);
      return send(200, { content });
    }

    if (api === 'q') {
      if (method === 'POST') {
        const item = {
          id: body.t || Date.now(),
          q: body.q || '',
          t: body.t || Date.now(),
          clientId: body.clientId || '',
          status: 'pending',
          answer: null
        };
        await db.collection('questions').add({ data: item });
        return send(200, { ok: true, id: item.id });
      }
      if (method === 'GET') {
        const since = Number(query.since) || 0;
        const cid = query.cid;
        let q = db.collection('questions').where({ t: _.gt(since) });
        if (cid) q = q.where({ clientId: cid });
        const res = await q.get();
        return send(200, { questions: res.data });
      }
    }

    if (api === 'a') {
      if (method === 'POST') {
        await db.collection('answers').add({ data: { qid: body.id, a: body.a || '', t: Date.now() } });
        await db.collection('questions').where({ id: body.id }).update({ data: { status: 'answered', answer: body.a } });
        return send(200, { ok: true });
      }
      if (method === 'GET') {
        // GET 回写模式：兼容 WebFetch
        if (query.write === '1') {
          if (!ADMIN_TOKEN || query.token !== ADMIN_TOKEN) return send(403, { error: 'forbidden' });
          await db.collection('answers').add({ data: { qid: query.id, a: query.a || '', t: Date.now() } });
          await db.collection('questions').where({ id: query.id }).update({ data: { status: 'answered', answer: query.a || '' } });
          return send(200, { ok: true });
        }
        const since = Number(query.since) || 0;
        const cid = query.cid;
        const res = await db.collection('answers').where({ t: _.gt(since) }).get();
        let answers = res.data;
        if (cid) {
          const qs = await db.collection('questions').where({ clientId: cid }).get();
          const ids = new Set(qs.data.map(x => String(x.id)));
          answers = answers.filter(a => ids.has(String(a.qid)));
        }
        return send(200, { answers });
      }
    }

    if (api === 'reports') {
      if (method === 'GET' && String(query.write) === '1') {
        if (!ADMIN_TOKEN || query.token !== ADMIN_TOKEN) return send(403, { error: 'forbidden' });
        await db.collection('reports').add({ data: {
          title: query.title || '', category: query.category || '资讯',
          content: query.content || '', source: query.source || '小栖', time: Date.now()
        } });
        return send(200, { ok: true });
      }
      if (method === 'POST') {
        if (!ADMIN_TOKEN || (body.token || '') !== ADMIN_TOKEN) return send(403, { error: 'forbidden' });
        await db.collection('reports').add({ data: {
          title: body.title || '', category: body.category || '资讯',
          content: body.content || '', source: body.source || '小栖', time: Date.now()
        } });
        return send(200, { ok: true });
      }
      const since = Number(query.since) || 0;
      const res = await db.collection('reports').where({ time: _.gt(since) }).orderBy('time', 'desc').limit(100).get();
      return send(200, { reports: res.data });
    }

    return send(404, { error: 'not found' });
  } catch (e) {
    return send(500, { error: String((e && e.message) || e) });
  }
};

const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
  try {
    const u = url.parse(req.url, true);
    let body = '';
    req.on('data', c => body += c);
    await new Promise(r => req.on('end', r));
    const event = {
      httpMethod: req.method,
      path: u.pathname,
      queryStringParameters: u.query,
      body: body || null
    };
    const result = await exports.main(event, {});
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
