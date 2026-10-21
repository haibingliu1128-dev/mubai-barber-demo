'use strict';
// 测试公共工具：每个测试文件启动独立的应用 + 临时数据库
const assert = require('node:assert/strict');
const os = require('os'), fs = require('fs'), path = require('path');
process.env.TZ = 'Asia/Shanghai';
const U = require('../src/lib/util');
const F = require('./fixture');
function harness() {
  const H = { U, F, assert };
  H.TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qy-test-'));
  H.DB = path.join(H.TMP, 'test.db');
  H.D = n => U.ymd(U.addDays(new Date(), n));
  H.api = async (method, url, body, token) => {
    const r = await fetch(H.base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => null);
    return { status: r.status, body: j };
  };
  let phoneN = 0;
  H.newPhone = () => '1390000' + String(1000 + ++phoneN).slice(-4);
  H.login = async (phone, name) => {
    const s = await H.api('POST', '/api/auth/sms', { phone });
    assert.equal(s.status, 200, JSON.stringify(s.body)); assert.match(s.body.devCode, /^\d{6}$/);
    const v = await H.api('POST', '/api/auth/verify', { phone, code: s.body.devCode, name: name || '测试' });
    assert.equal(v.status, 200); return v.body.token;
  };
  H.start = async () => {
    const { build } = require('../src/app');
    H.app = await build({ dbFile: H.DB, logger: false, smsPerIpHour: 100000, schedulerMs: 3600e3 });
    await H.app.listen({ port: 0, host: '127.0.0.1' });
    H.base = 'http://127.0.0.1:' + H.app.server.address().port;
    H.R = H.app.ctx.repo; H.B = H.app.ctx.booking; H.X = H.app.ctx.ext;
    H.OWNER = (await H.api('POST', '/api/merchant/login', { username: 'owner', password: F.ownerPassword })).body.token;
    H.STAFF = (await H.api('POST', '/api/merchant/login', { username: 'staff', password: 'staff2026' })).body.token;
    assert.ok(H.OWNER && H.STAFF, '演示账号可登录');
    if (F.prep) await F.prep(H);
  };
  H.stop = async () => { await H.app.close(); fs.rmSync(H.TMP, { recursive: true, force: true }); };
  H.setRule = patch => H.api('PUT', '/api/merchant/settings', patch, H.OWNER);
  H.resetRules = () => H.api('POST', '/api/merchant/settings/reset', null, H.OWNER);
  /** 下单：行业 fixture 负责拼装请求体（如先建宠物档案、选人员） */
  H.book = async (tok, key, date, time, extra) => tok ? H.api('POST', '/api/bookings', { ...(await F.body(H, tok, key, date, time)), ...(extra || {}) }, tok) : H.api('POST', '/api/bookings', { serviceId: F.svc.basic, date, time, name: '测试' });
  /** 直接写入一条订单（过去日期，每条错开日期，避免时段冲突） */
  let bkN = 0;
  H.insert = (phone, status, o = {}) => {
    const c = H.R.getCustomerByPhone(phone), d = o.date || H.D(-20 - ++bkN), svc = H.R.getService(o.serviceId || F.svc.review);
    const m = o.start != null ? o.start : H.R.getShop().open_min, e = m + svc.duration_min;
    return H.R.insertBooking({ code: 'T' + Math.random().toString(36).slice(2, 9), customer_id: c.id, service_id: svc.id, service_name: svc.name, price_cents: svc.price_cents, duration_min: svc.duration_min,
      date: d, start_min: m, end_min: e, start_at: U.startAt(d, m), end_at: U.startAt(d, e), name: '测试', note: '', status, ...(o.f || {}) });
  };
  H.makeRegular = phone => H.insert(phone, 'done', { date: H.D(-60 - ++bkN) });
  H.doneBooking = (phone, status) => H.insert(phone, status || 'done', { date: H.D(-2), start: H.R.getShop().open_min + 60 * (bkN++ % 4) });
  H.sseCollect = url => {
    const ac = new AbortController(); let buf = '';
    const ready = fetch(H.base + url, { signal: ac.signal }).then(async res => { const rd = res.body.getReader(); (async () => { try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += Buffer.from(value).toString(); } } catch {} })(); });
    return { ready, text: () => buf, close: () => ac.abort() };
  };
  H.waitFor = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 30)); } return false; };
  const imgDir = path.join(__dirname, '..', 'assets', 'seed-images');
  H.JPG = fs.readFileSync(path.join(imgDir, fs.readdirSync(imgDir).filter(f => f.endsWith('.jpg')).sort()[0]));
  H.PNG1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d6c5e50000000049454e44ae426082', 'hex');
  H.up = (buf, type, token) => fetch(H.base + '/api/merchant/images', { method: 'POST', headers: { 'content-type': type, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: buf }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  H.cup = (buf, token) => fetch(H.base + '/api/me/images', { method: 'POST', headers: { 'content-type': 'image/jpeg', authorization: 'Bearer ' + token }, body: buf }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  H.staffId = async () => (await H.api('GET', '/api/merchant/me', null, H.STAFF)).body.id;
  H.grant = async perms => H.api('PUT', '/api/merchant/staff/' + await H.staffId(), { perms }, H.OWNER);
  H.MASK = /^1\d{2}\*{4}\d{4}$/;
  return H;
}
module.exports = { harness };
