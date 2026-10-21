'use strict';
// 内核 API 测试（各行业共用；行业差异由 test/fixture.js 提供）：node --test test/
const { test, before, after } = require('node:test');
const path = require('path');
const { spawn } = require('child_process');
const { harness } = require('./helpers');
const H = harness(), { assert, F, U, D } = H;
const { api, login, newPhone, book, setRule, resetRules } = H;
const T = F.T;   // 当天可用、互不重叠的开始时间（基础服务）
let R, B, OWNER, STAFF;
before(async () => { await H.start(); ({ R, B, OWNER, STAFF } = H); });
after(() => H.stop());

test('公开信息与可约时段', async () => {
  const s = await api('GET', '/api/shop');
  assert.equal(s.status, 200); assert.equal(s.body.services.length, F.serviceCount);
  assert.equal(s.body.shop.name, F.brand); assert.ok(s.body.industry && s.body.industry.slug === F.slug);
  await setRule({ maxOpen: { on: true, v: 2 } });
  assert.ok((await api('GET', '/api/shop')).body.rules.some(x => x.includes('每人最多 2 个未完成预约')));
  const a = await api('GET', `/api/availability?serviceId=${F.svc.basic}&from=${D(1)}`);
  assert.equal(a.status, 200); assert.equal(a.body.days.length, s.body.shop.bookDays - 1);
  if (F.availCheck) await F.availCheck(H, a.body);
  const h = await api('GET', '/api/health');
  assert.ok(h.body.ok && h.body.features.includes('booking-perms') && h.body.industry === F.slug);
  await resetRules();
});

test('短信验证码：错误码拒绝、冷却、正确码登录', async () => {
  const phone = newPhone();
  const s = await api('POST', '/api/auth/sms', { phone });
  assert.equal(s.status, 200);
  const again = await api('POST', '/api/auth/sms', { phone });
  assert.equal(again.status, 429); assert.equal(again.body.error.code, 'SMS_COOLDOWN');
  const bad = await api('POST', '/api/auth/verify', { phone, code: s.body.devCode === '000000' ? '111111' : '000000' });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'CODE_WRONG');
  const ok = await api('POST', '/api/auth/verify', { phone, code: s.body.devCode });
  assert.equal(ok.status, 200); assert.ok(ok.body.token);
  assert.equal((await api('POST', '/api/auth/verify', { phone, code: s.body.devCode })).status, 400, '验证码只能用一次');
  assert.equal((await api('POST', '/api/auth/sms', { phone: '12345' })).status, 400);
  assert.equal((await api('GET', '/api/dev/sms-outbox?phone=' + phone)).body[0].code, s.body.devCode);
  assert.equal((await book(null, 'basic', D(4), T[0])).status, 401, '未登录不能预约');
  assert.equal((await api('POST', '/api/auth/quick', { phone })).status, 403, '开启验证时不能免验证码登录');
});

test('新客需确认 → 商家确认；员工不能改设置', async () => {
  const tok = await login(newPhone());
  const r = await book(tok, 'basic', D(4), T[0]);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.booking.status, 'pending'); assert.equal(r.body.needConfirm, true);
  const acc = await api('POST', `/api/merchant/bookings/${r.body.booking.id}/accept`, null, STAFF);
  assert.equal(acc.status, 200); assert.equal(acc.body.booking.status, 'confirmed');
  assert.equal((await api('POST', `/api/merchant/bookings/${r.body.booking.id}/accept`, null, STAFF)).status, 409);
  assert.equal((await api('PUT', '/api/merchant/settings', { maxOpen: { v: 5 } }, STAFF)).status, 403);
  assert.equal((await api('GET', '/api/merchant/bookings?scope=all')).status, 401);
});

test('定金：待支付占位 → 模拟支付 → 确认；取消退款', async () => {
  const phone = newPhone(), tok = await login(phone); H.makeRegular(phone);
  const r = await book(tok, 'dep', D(4), T[3]);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.booking.status, 'awaiting_payment'); assert.equal(r.body.payment.amount, F.depAmount);
  assert.ok(R.activeOnDates(D(4), D(4)).some(b => b.start_min === U.toMin(T[3])), '待支付期间时段被保留');
  assert.equal((await api('POST', `/api/pay/mock/${r.body.payment.outTradeNo}/confirm`, null, await login(newPhone()))).status, 404, '别人不能替你确认支付');
  const p = await api('POST', `/api/pay/mock/${r.body.payment.outTradeNo}/confirm`, null, tok);
  assert.equal(p.status, 200); assert.equal(p.body.booking.status, 'confirmed'); assert.equal(p.body.booking.depositStatus, 'paid');
  assert.equal((await api('POST', `/api/pay/mock/${r.body.payment.outTradeNo}/confirm`, null, tok)).body.booking.status, 'confirmed', '回调幂等');
  const c = await api('POST', `/api/bookings/${r.body.booking.id}/cancel`, null, tok);
  assert.equal(c.status, 200); assert.equal(c.body.refunded, true); assert.equal(c.body.booking.depositStatus, 'refunded');
});

test('待支付超时 → 定时任务释放时段', async () => {
  const phone = newPhone(), tok = await login(phone); H.makeRegular(phone);
  const r = await book(tok, 'dep', D(5), T[0]);
  assert.equal(r.body.booking.status, 'awaiting_payment', JSON.stringify(r.body));
  R.updateBooking(r.body.booking.id, { hold_until: Date.now() - 1000 });
  await B.tick();
  assert.equal(R.getBooking(r.body.booking.id).status, 'expired');
  assert.equal((await api('POST', `/api/pay/mock/${r.body.payment.outTradeNo}/confirm`, null, tok)).body.booking.status, 'expired');
  assert.equal(R.paymentForBooking(r.body.booking.id).status, 'refunded', '超时后付款自动退款');
});

test('未完成预约上限：消息引用当前值；商家改成 3 立即生效', async () => {
  await setRule({ maxOpen: { on: true, v: 2 }, perDay: { on: false } });
  const phone = newPhone(), tok = await login(phone); H.makeRegular(phone);
  assert.equal((await book(tok, 'basic', D(4), T[4])).status, 201);
  assert.equal((await book(tok, 'basic', D(5), T[4])).status, 201);
  const r3 = await book(tok, 'basic', D(6), T[4]);
  assert.equal(r3.status, 409); assert.equal(r3.body.error.code, 'LIMIT_OPEN'); assert.match(r3.body.error.message, /最多同时保留 2 个/);
  assert.equal((await setRule({ maxOpen: { v: 3 } })).status, 200);
  assert.ok((await api('GET', '/api/shop')).body.rules.includes('每人最多 3 个未完成预约'));
  assert.equal((await book(tok, 'basic', D(6), T[4])).status, 201);
  assert.match((await book(tok, 'basic', D(3), T[4])).body.error.message, /最多同时保留 3 个/);
  await setRule({ maxOpen: { on: false } });
  assert.equal((await book(tok, 'basic', D(3), T[4])).status, 201, '关闭后不再限制');
  await resetRules();
});

test('每天上限 + 每周上限', async () => {
  await setRule({ perDay: { on: true, v: 1 }, maxOpen: { on: true, v: 10 } });
  const phone = newPhone(), tok = await login(phone); H.makeRegular(phone);
  assert.equal((await book(tok, 'basic', D(5), T[1])).status, 201);
  const r = await book(tok, 'basic', D(5), T[2]);
  assert.equal(r.body.error.code, 'LIMIT_DAY'); assert.match(r.body.error.message, /最多预约 1 个/);
  await setRule({ perDay: { v: 2 } });
  assert.equal((await book(tok, 'basic', D(5), T[2])).status, 201);
  await setRule({ perDay: { on: false }, perWeek: { on: true, v: 1 } });
  const w = await book(tok, 'basic', D(5), T[5]);
  assert.equal(w.body.error.code, 'LIMIT_WEEK'); assert.match(w.body.error.message, /每周最多预约 1 个/);
  await resetRules();
});

test('设置校验：范围、步长、未知字段、恢复默认', async () => {
  for (const [patch, re] of [[{ maxOpen: { v: 0 } }, /1–10/], [{ maxOpen: { v: 11 } }, /1–10/], [{ rate: { lock: 7 } }, /5 的倍数/], [{ grace: { v: 2.5 } }, /整数/], [{ foo: { on: true } }, /未知/], [{ noshow: { act: 'x' } }, /block/]]) {
    const r = await setRule(patch); assert.equal(r.status, 400, JSON.stringify(patch)); assert.match(r.body.error.message, re);
  }
  const ok = await setRule({ cancelH: { v: 24 }, noshow: { act: 'deposit' } });
  assert.equal(ok.body.values.cancelH.v, 24); assert.equal(ok.body.values.noshow.act, 'deposit');
  const def = require('../src/services/rules').DEFAULTS;
  const rs = await resetRules();
  assert.equal(rs.body.values.cancelH.v, def.cancelH.v); assert.equal(rs.body.values.noshow.act, 'block');
  assert.equal((await api('PUT', `/api/merchant/services/${F.svc.dep}`, { deposit: 15 }, OWNER)).status, 400);
  assert.equal((await api('PUT', `/api/merchant/services/${F.svc.dep}`, { deposit: 40 }, OWNER)).body.deposit, 40);
  await api('PUT', `/api/merchant/services/${F.svc.dep}`, { deposit: F.depAmount }, OWNER);
});

test('取消时限：引用当前小时数；商家放宽后可取消；每月取消次数', async () => {
  await setRule({ cancelH: { on: true, v: 2 }, perDay: { on: false } });
  const phone = newPhone(), tok = await login(phone); H.makeRegular(phone);
  const r = await book(tok, 'basic', D(6), T[0]); const id = r.body.booking.id;
  const st = Date.now() + 90 * 60000; R.updateBooking(id, { start_at: st, end_at: st + 30 * 60000 });
  const c = await api('POST', `/api/bookings/${id}/cancel`, null, tok);
  assert.equal(c.status, 409); assert.match(c.body.error.message, /不足 2 小时/);
  assert.equal((await api('GET', '/api/me/bookings', null, tok)).body.find(x => x.id === id).canCancel, false);
  await setRule({ cancelH: { v: 1 } });
  assert.equal((await api('POST', `/api/bookings/${id}/cancel`, null, tok)).status, 200);
  await setRule({ cancelMonth: { on: true, v: 1 } });
  const r2 = await book(tok, 'basic', D(6), T[1]);
  const c2 = await api('POST', `/api/bookings/${r2.body.booking.id}/cancel`, null, tok);
  assert.equal(c2.status, 409); assert.match(c2.body.error.message, /每月最多自助取消 1 次/);
  await resetRules();
});

test('防刷：N 次/M 分钟后暂停，提示引用设置', async () => {
  await setRule({ rate: { on: true, n: 3, m: 10, lock: 30 }, maxOpen: { v: 10 }, perDay: { on: false } });
  const phone = newPhone(), tok = await login(phone); H.makeRegular(phone);
  const a = await book(tok, 'basic', D(6), T[2]);
  await api('POST', `/api/bookings/${a.body.booking.id}/cancel`, null, tok);
  assert.equal((await book(tok, 'basic', D(6), T[2])).status, 201);
  const x = await book(tok, 'basic', D(4), T[2]);
  assert.equal(x.status, 429); assert.match(x.body.error.message, /10 分钟内预约\+取消达 3 次，暂停 30 分钟/);
  await api('POST', `/api/merchant/customers/${phone}/clear`, null, OWNER);
  assert.equal((await book(tok, 'basic', D(4), T[2])).status, 201, '商家解除后恢复');
  await resetRules();
});

test('超时未到自动爽约 → 限制预约 → 改为必须付定金 → 解除', async () => {
  await setRule({ grace: { on: true, v: 15 }, noshow: { on: true, n: 2, act: 'block' }, perDay: { on: false }, maxOpen: { v: 10 } });
  const phone = newPhone(), tok = await login(phone); H.makeRegular(phone);
  const ids = [];
  for (const [d, t] of [[4, T[4]], [5, T[5]]]) { const r = await book(tok, 'basic', D(d), t); assert.equal(r.status, 201, JSON.stringify(r.body)); ids.push(r.body.booking.id); }
  let s = Date.now() - 20 * 60000; R.updateBooking(ids[0], { start_at: s, end_at: s + 30 * 60000 });
  s = Date.now() - 10 * 60000; R.updateBooking(ids[1], { start_at: s, end_at: s + 30 * 60000 });
  await B.tick();
  assert.equal(R.getBooking(ids[0]).status, 'no_show'); assert.equal(R.getBooking(ids[0]).noshow_by, 'auto');
  assert.equal(R.getBooking(ids[1]).status, 'confirmed');
  await setRule({ grace: { v: 5 } }); await B.tick();
  assert.equal(R.getBooking(ids[1]).status, 'no_show', '宽限改为 5 分钟后被标记');
  const me = await api('GET', '/api/me', null, tok);
  assert.equal(me.body.noshowCount, 2); assert.equal(me.body.restricted.act, 'block');
  const blocked = await book(tok, 'basic', D(6), T[5]);
  assert.equal(blocked.status, 403); assert.match(blocked.body.error.message, /爽约 2 次/);
  await setRule({ noshow: { act: 'deposit' }, deposit: { force: 60 } });
  const q = await api('POST', '/api/quote', await F.body(H, tok, 'basic', D(6), T[5]), tok);
  assert.equal(q.status, 200, JSON.stringify(q.body)); assert.equal(q.body.deposit, 60);
  const dep = await book(tok, 'basic', D(6), T[5]);
  assert.equal(dep.status, 201, JSON.stringify(dep.body)); assert.equal(dep.body.payment.amount, 60, '受限顾客必须付定金');
  await api('POST', `/api/bookings/${dep.body.booking.id}/cancel`, null, tok);
  await setRule({ noshow: { act: 'block', n: 3 } });
  assert.equal((await api('GET', '/api/me', null, tok)).body.restricted, null, '阈值提高到 3 后不再受限');
  await setRule({ noshow: { n: 2 } });
  await api('POST', `/api/merchant/customers/${phone}/clear`, null, OWNER);
  assert.equal((await api('GET', '/api/me', null, tok)).body.restricted, null, '商家解除限制');
  assert.equal((await api('GET', '/api/merchant/customers?q=' + phone, null, OWNER)).body[0].noshowTotal, 2);
  const fut = await book(tok, 'basic', D(3), T[2]);
  assert.equal((await api('POST', `/api/merchant/bookings/${fut.body.booking.id}/noshow`, null, STAFF)).status, 409, '未开始不能标记爽约');
  await resetRules();
});

test('黑名单：拉黑后不能预约，移出后恢复；种子爽约顾客受限', async () => {
  const phone = newPhone(), tok = await login(phone); H.makeRegular(phone);
  assert.equal((await api('POST', '/api/merchant/customers/blacklist', { phone, on: true, reason: '测试' }, OWNER)).status, 200);
  const r = await book(tok, 'basic', D(3), T[5]);
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'BLACKLISTED');
  await api('POST', '/api/merchant/customers/blacklist', { phone, on: false }, OWNER);
  assert.equal((await book(tok, 'basic', D(3), T[5])).status, 201);
  const zhou = (await api('GET', '/api/merchant/customers', null, OWNER)).body.find(c => c.phone === F.restrictedPhone);
  assert.equal(zhou.noshowInWindow, 2); assert.equal(zhou.restricted.act, 'block');
  assert.ok((await api('GET', '/api/merchant/audit', null, OWNER)).body.some(a => a.action === 'customer.blacklist'));
  assert.equal((await api('GET', '/api/merchant/audit', null, STAFF)).status, 403);
});

test('并发：多个顾客同时抢同一时段，只有容量内的成功；数据库触发器兜底', async () => {
  await setRule({ confirmNew: { on: false } });
  const toks = await Promise.all(Array.from({ length: 20 }, () => login(newPhone())));
  const bodies = await Promise.all(toks.map(t => F.body(H, t, 'conc', D(6), T[3])));
  const res = await Promise.all(toks.map((t, i) => api('POST', '/api/bookings', bodies[i], t)));
  const ok = res.filter(r => r.status === 201), taken = res.filter(r => r.status === 409 && ['SLOT_TAKEN', 'CLASS_FULL'].includes(r.body.error.code));
  assert.equal(ok.length, F.cap, res.map(r => r.status + (r.body.error ? r.body.error.code : '')).join(',')); assert.equal(taken.length, 20 - F.cap);
  if (F.overlap) assert.equal((await api('POST', '/api/bookings', { ...bodies[1], time: F.overlap(T[3]) }, toks[1])).status, 409, '重叠时段也被拒');
  const row = R.getBooking(ok[0].body.booking.id); const { id, code, ...rest } = row; delete rest.phone;
  assert.throws(() => R.insertBooking({ ...rest, code: 'DUP' + Date.now() }), /SLOT_TAKEN/, '触发器：直接插入超出容量的记录被拒');
  await resetRules();
});

test('并发（两个独立进程共享同一数据库）：数据库触发器兜底防超卖', async () => {
  const ports = [3300 + Math.floor(Math.random() * 500), 3900 + Math.floor(Math.random() * 500)];
  const procs = ports.map(p => spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, PORT: String(p), HOST: '127.0.0.1', DB_FILE: H.DB, LOG_LEVEL: 'error', SMS_PER_IP_HOUR: '100000', SCHEDULER_MS: '3600000' }, stdio: 'ignore' }));
  try {
    for (const p of ports) { for (let i = 0; i < 80; i++) { try { await fetch(`http://127.0.0.1:${p}/api/health`); break; } catch { await new Promise(r => setTimeout(r, 100)); } } }
    await setRule({ confirmNew: { on: false } });
    const toks = await Promise.all(Array.from({ length: 16 }, () => login(newPhone())));
    const bodies = await Promise.all(toks.map(t => F.body(H, t, 'conc', D(5), T[0])));
    const res = await Promise.all(toks.map((t, i) => fetch(`http://127.0.0.1:${ports[i % 2]}/api/bookings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify(bodies[i]) })));
    const codes = res.map(r => r.status);
    assert.equal(codes.filter(c => c === 201).length, F.cap, codes.join(','));
    assert.equal(codes.filter(c => c === 409).length, 16 - F.cap);
  } finally { procs.forEach(p => p.kill()); await resetRules(); }
});

test('SSE：商家端实时收到新预约事件', async () => {
  const ac = new AbortController();
  const res = await fetch(H.base + '/api/merchant/stream?token=' + OWNER, { signal: ac.signal });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /event-stream/);
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  const got = (async () => { while (!buf.includes('booking.create')) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } return buf; })();
  const tok = await login(newPhone()); await book(tok, 'basic', D(2), T[5]);
  const txt = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no SSE event')), 3000))]);
  assert.match(txt, /event: change/); ac.abort();
  assert.equal((await fetch(H.base + '/api/merchant/stream?token=bad')).status, 401);
});

test('图片上传：店主上传 JPG/PNG 成功，可读取且带缓存头；非商家/员工被拒；格式与大小校验', async () => {
  const r = await H.up(H.JPG, 'image/jpeg', OWNER);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.mime, 'image/jpeg');
  const g = await fetch(H.base + r.body.url);
  assert.equal(g.status, 200); assert.match(g.headers.get('cache-control'), /max-age=31536000/);
  assert.ok(Buffer.from(await g.arrayBuffer()).equals(H.JPG));
  assert.equal((await fetch(H.base + r.body.url, { headers: { 'if-none-match': g.headers.get('etag') } })).status, 304);
  assert.equal((await H.up(H.PNG1, 'application/octet-stream', OWNER)).body.mime, 'image/png');
  assert.equal((await H.up(H.JPG, 'image/jpeg')).status, 401);
  assert.equal((await H.up(H.JPG, 'image/jpeg', await login(newPhone()))).status, 401);
  const s = await H.up(H.JPG, 'image/jpeg', STAFF);
  assert.equal(s.status, 403); assert.match(s.body.error.message, /管理服务与图片/);
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64)]);
  assert.equal((await H.up(gif, 'image/jpeg', OWNER)).body.error.code, 'IMAGE_BAD_TYPE');
  assert.equal((await H.up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', OWNER)).status, 415);
  const big = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(2 * 1024 * 1024)]);
  assert.equal((await H.up(big, 'image/jpeg', OWNER)).status, 413);
});

test('服务图片：种子服务有默认配图；新增/编辑服务带图片；校验 ID 与数量；公开 SSE 推送 service 事件', async () => {
  const shop0 = await api('GET', '/api/shop');
  assert.ok(shop0.body.services.every(s => s.cover && s.images.length >= 1), '种子服务应有默认配图');
  const i1 = (await H.up(H.JPG, 'image/jpeg', OWNER)).body, i2 = (await H.up(H.PNG1, 'image/png', OWNER)).body;
  const c = await api('POST', '/api/merchant/services', { name: '图片测试款', price: 128, duration: 60, images: [i1.id, i2.id] }, OWNER);
  assert.equal(c.status, 200, JSON.stringify(c.body)); assert.equal(c.body.cover, i1.url); assert.equal(c.body.images.length, 2);
  assert.equal((await api('PUT', '/api/merchant/services/' + c.body.id, { images: [i2.id] }, OWNER)).body.cover, i2.url);
  assert.equal((await api('PUT', '/api/merchant/services/' + c.body.id, { images: ['nope12345678'] }, OWNER)).body.error.code, 'IMAGE_NOT_FOUND');
  assert.equal((await api('PUT', '/api/merchant/services/' + c.body.id, { images: [i1.id, i2.id, shop0.body.services[0].images[0].id, shop0.body.services[1].images[0].id] }, OWNER)).body.error.code, 'TOO_MANY_IMAGES');
  assert.equal((await api('PUT', '/api/merchant/services/' + c.body.id, { images: [i1.id] }, STAFF)).status, 403);
  await api('DELETE', '/api/merchant/services/' + c.body.id, null, OWNER);
  const s = H.sseCollect('/api/stream'); await s.ready; await new Promise(r => setTimeout(r, 80));
  await api('PUT', `/api/merchant/services/${F.svc.basic}`, { desc: '实时测试' }, OWNER);
  assert.ok(await H.waitFor(() => /event: change\ndata: {"type":"service"}/.test(s.text()))); s.close();
});

test('评价：只有本人已完成的订单可评价；一单一次；期限内可修改；文本清洗；照片须本人上传', async () => {
  const phone = newPhone(), tok = await login(phone, '评价测试'), C0 = (await api('GET', '/api/shop')).body.features;
  let r = await api('POST', '/api/reviews', { bookingId: H.doneBooking(phone, 'confirmed'), stars: 5 }, tok);
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'NOT_COMPLETED');
  const bid = H.doneBooking(phone), other = await login(newPhone());
  assert.equal((await api('POST', '/api/reviews', { bookingId: bid, stars: 5 }, other)).status, 404);
  assert.equal((await api('POST', '/api/reviews', { bookingId: bid, stars: 5 })).status, 401);
  assert.equal((await api('GET', '/api/me/bookings', null, tok)).body.find(b => b.id === bid).canReview, true);
  assert.equal((await api('POST', '/api/reviews', { bookingId: bid, stars: 5, text: 'x'.repeat(301) }, tok)).body.error.code, 'TEXT_TOO_LONG');
  assert.equal((await api('POST', '/api/reviews', { bookingId: bid, stars: 5, tags: ['不存在的标签'] }, tok)).body.error.code, 'BAD_TAG');
  const mimg = (await H.up(H.JPG, 'image/jpeg', OWNER)).body;
  assert.equal((await api('POST', '/api/reviews', { bookingId: bid, stars: 5, photos: [mimg.id] }, tok)).body.error.code, 'IMAGE_NOT_FOUND');
  const ph = await H.cup(H.JPG, tok); assert.equal(ph.status, 201);
  r = await api('POST', '/api/reviews', { bookingId: bid, stars: 5, tags: C0.tagsPos.slice(0, 2), text: '很好<script>alert(1)</script>', photos: [ph.body.id] }, tok);
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.text, '很好＜script＞alert(1)＜/script＞');
  assert.equal((await api('POST', '/api/reviews', { bookingId: bid, stars: 4 }, tok)).body.error.code, 'ALREADY_REVIEWED');
  const e = await api('PUT', '/api/reviews/' + r.body.id, { stars: 4, tags: [C0.tagsPos[2]], text: '改一下', photos: [] }, tok);
  assert.equal(e.status, 200); assert.equal(e.body.stars, 4);
  R.db.prepare('UPDATE reviews SET created_at=? WHERE id=?').run(Date.now() - 8 * 864e5, r.body.id);
  assert.equal((await api('PUT', '/api/reviews/' + r.body.id, { stars: 3 }, tok)).body.error.code, 'EDIT_EXPIRED');
  const pub = await api('GET', `/api/reviews?serviceId=${F.svc.review}&limit=30`);
  assert.match(pub.body.items.find(x => x.id === r.body.id).who, /^\d{3}\*{4}\d{4}$/); assert.ok(!JSON.stringify(pub.body).includes(phone));
});

test('低分评价提醒 + 商家回复 / 隐藏 / 先审后发', async () => {
  const phone = newPhone(), tok = await login(phone), bid = H.doneBooking(phone), C0 = (await api('GET', '/api/shop')).body.features;
  const s = H.sseCollect('/api/merchant/stream?token=' + OWNER); await s.ready; await new Promise(r => setTimeout(r, 80));
  const low = await api('POST', '/api/reviews', { bookingId: bid, stars: 2, tags: [C0.tagsNeg[0]], text: '不太满意' }, tok);
  assert.equal(low.status, 201);
  assert.ok(await H.waitFor(() => /"type":"review"[^\n]*"low":true/.test(s.text()))); s.close();
  assert.ok((await api('GET', '/api/merchant/dashboard', null, OWNER)).body.inbox.reviews.lowNew >= 1);
  const item = (await api('GET', '/api/merchant/reviews?filter=low', null, STAFF)).body.items.find(x => x.id === low.body.id);
  assert.match(item.phone, /^\d{3}\*{4}\d{4}$/); assert.ok(item.bookingCode);
  await api('GET', '/api/merchant/reviews?filter=low', null, OWNER);
  assert.equal((await api('GET', '/api/merchant/dashboard', null, OWNER)).body.inbox.reviews.lowNew, 0);
  const p2 = newPhone(), t2 = await login(p2);
  const rv = (await api('POST', '/api/reviews', { bookingId: H.doneBooking(p2), stars: 5, text: '回复测试' }, t2)).body;
  assert.equal((await api('PUT', `/api/merchant/reviews/${rv.id}/reply`, { text: '谢谢' }, STAFF)).status, 403);
  assert.equal((await api('PUT', `/api/merchant/reviews/${rv.id}/reply`, { text: '谢谢光临' }, OWNER)).body.reply.text, '谢谢光临');
  const before = (await api('GET', `/api/reviews?serviceId=${F.svc.review}&limit=30`)).body.summary.count;
  await api('POST', `/api/merchant/reviews/${rv.id}/hide`, null, OWNER);
  assert.equal((await api('GET', `/api/reviews?serviceId=${F.svc.review}&limit=30`)).body.summary.count, before - 1);
  await api('POST', `/api/merchant/reviews/${rv.id}/unhide`, null, OWNER);
  await setRule({ review: { moderate: 'low' } });
  const p3 = newPhone(), t3 = await login(p3);
  const pend = (await api('POST', '/api/reviews', { bookingId: H.doneBooking(p3), stars: 1 }, t3)).body;
  assert.equal(pend.status, 'pending');
  await api('POST', `/api/merchant/reviews/${pend.id}/approve`, null, OWNER);
  assert.ok((await api('GET', `/api/reviews?serviceId=${F.svc.review}&limit=30`)).body.items.some(x => x.id === pend.id));
  await resetRules();
});

test('功能开关：关闭后服务端拒绝（403 FEATURE_OFF）且公开接口隐藏', async () => {
  const phone = newPhone(), tok = await login(phone), bid = H.doneBooking(phone);
  await setRule({ review: { on: false } });
  assert.equal((await api('POST', '/api/reviews', { bookingId: bid, stars: 5 }, tok)).body.error.code, 'FEATURE_OFF');
  assert.equal((await api('GET', '/api/shop')).body.features.review, false);
  await setRule({ review: { on: true }, reviewPublic: { on: false } });
  assert.equal((await api('GET', '/api/reviews')).status, 403);
  await setRule({ reviewPublic: { on: true }, feedback: { on: false }, contact: { on: false } });
  assert.equal((await api('POST', '/api/feedback', { type: '其他', text: '测试反馈' }, tok)).body.error.code, 'FEATURE_OFF');
  assert.equal((await api('GET', '/api/shop')).body.shop.phone, null);
  assert.equal((await api('PUT', '/api/merchant/settings', { review: { on: false } }, STAFF)).status, 403);
  await resetRules();
  const f = (await api('GET', '/api/shop')).body.features;
  assert.ok(f.review && f.reply && f.reviewPublic && f.feedback && f.contact, '默认全部开启');
});

test('意见反馈：仅商家可见；状态与内部备注；回访时显示完整号码', async () => {
  const phone = newPhone(), tok = await login(phone, '反馈测试');
  assert.equal((await api('POST', '/api/feedback', { type: '其他', text: '没登录' })).status, 401);
  assert.equal((await api('POST', '/api/feedback', { type: '乱写', text: '类型不对' }, tok)).body.error.code, 'BAD_TYPE');
  const r = await api('POST', '/api/feedback', { type: '服务投诉', text: '希望<b>改进</b>', contact: 'phone' }, tok);
  assert.equal(r.status, 201);
  const it = (await api('GET', '/api/merchant/feedback?status=open', null, OWNER)).body.items.find(x => x.id === r.body.id);
  assert.equal(it.phone, phone); assert.equal(it.text, '希望＜b＞改进＜/b＞');
  assert.equal((await api('PUT', '/api/merchant/feedback/' + it.id, { status: 'doing' }, STAFF)).status, 403);
  assert.equal((await api('PUT', '/api/merchant/feedback/' + it.id, { status: 'done', note: '已电话联系' }, OWNER)).body.status, 'done');
  const mine = await api('GET', '/api/me/feedback', null, tok);
  assert.equal(mine.body[0].statusText, '已处理'); assert.ok(!('note' in mine.body[0]));
});

test('示例数据：评价有内容、标记为示例、手机号打码；示例订单标记 seed', async () => {
  const r = await api('GET', '/api/reviews?limit=30');
  const seeds = r.body.items.filter(x => x.seed);
  assert.ok(seeds.length >= 5); assert.ok(seeds.some(x => x.reply)); assert.ok(seeds.some(x => x.photos.length));
  assert.ok(seeds.every(x => /^\d{3}\*{4}\d{4}$/.test(x.who)));
  const all = (await api('GET', '/api/merchant/bookings?scope=all', null, OWNER)).body;
  assert.ok(all.filter(b => b.code.includes('DEMO')).every(b => b.seed), '示例订单均标记为示例');
});

test('店员权限：默认只开「处理预约」；店员不能改权限；新增/停用店员', async () => {
  const me = (await api('GET', '/api/merchant/me', null, STAFF)).body;
  assert.equal(me.role, 'staff'); assert.ok(Object.entries(me.perms).every(([k, v]) => v === (k === 'booking.handle')), JSON.stringify(me.perms));
  const l = await api('GET', '/api/merchant/staff', null, OWNER);
  assert.ok(l.body.staff.length >= 2); assert.equal(l.body.perms.length, 9);
  assert.equal(l.body.staff.find(s => s.username === 'staff').name, F.staffDisplay);
  assert.equal((await api('GET', '/api/merchant/staff', null, STAFF)).status, 403);
  assert.equal((await api('PUT', '/api/merchant/staff/' + me.id, { perms: { 'review.reply': true } }, STAFF)).status, 403);
  const c = await api('POST', '/api/merchant/staff', { username: 'staff_t1', name: '测试店员', password: 'pass1234' }, OWNER);
  assert.equal(c.status, 201);
  const t = (await api('POST', '/api/merchant/login', { username: 'staff_t1', password: 'pass1234' })).body.token;
  assert.equal((await api('GET', '/api/merchant/dashboard', null, t)).status, 200);
  await api('PUT', '/api/merchant/staff/' + c.body.id, { active: false }, OWNER);
  assert.equal((await api('GET', '/api/merchant/dashboard', null, t)).status, 401, '停用后已登录会话立即失效');
});

test('店员权限：逐项授权/收回立即生效（同一会话）；评价与反馈开关仍仅店主；SSE 推送权限变化', async () => {
  const phone = newPhone(), tok = await login(phone);
  const rv = (await api('POST', '/api/reviews', { bookingId: H.doneBooking(phone), stars: 4, text: '权限测试' }, tok)).body;
  const fb = (await api('POST', '/api/feedback', { type: '其他', text: '请回电', contact: 'phone' }, tok)).body;
  const sid = await H.staffId();
  const cases = [
    ['review.reply', () => api('PUT', `/api/merchant/reviews/${rv.id}/reply`, { text: '店员回复' }, STAFF)],
    ['review.hide', () => api('POST', `/api/merchant/reviews/${rv.id}/hide`, null, STAFF)],
    ['feedback.handle', () => api('PUT', `/api/merchant/feedback/${fb.id}`, { status: 'doing' }, STAFF)],
    ['service.manage', () => api('PUT', `/api/merchant/services/${F.svc.basic}`, { desc: '店员改的简介' }, STAFF)],
    ['rules.edit', () => api('PUT', '/api/merchant/settings', { maxOpen: { v: 3 } }, STAFF)],
  ];
  const s = H.sseCollect('/api/merchant/stream?token=' + STAFF); await s.ready; await new Promise(r => setTimeout(r, 80));
  for (const [perm, call] of cases) {
    const no = await call(); assert.equal(no.status, 403, perm); assert.equal(no.body.error.perm, perm);
    await api('PUT', '/api/merchant/staff/' + sid, { perms: { [perm]: true } }, OWNER);
    assert.equal((await call()).status, 200, perm + ' 授权后应允许');
    await api('PUT', '/api/merchant/staff/' + sid, { perms: { [perm]: false } }, OWNER);
    assert.equal((await call()).status, 403, perm + ' 收回后立即拒绝');
  }
  assert.ok(await H.waitFor(() => s.text().includes(`"type":"perms","userId":${sid}`))); s.close();
  await H.grant({ 'rules.edit': true });
  assert.equal((await api('PUT', '/api/merchant/settings', { review: { on: false } }, STAFF)).body.error.code, 'OWNER_ONLY');
  await H.grant({ 'rules.edit': false }); await resetRules();
  assert.ok((await api('GET', '/api/merchant/audit', null, OWNER)).body.some(a => a.actor_name === 'staff' && a.action === 'review.reply' && a.actorDisplay === F.staffDisplay));
});

test('处理预约：收回后所有操作 403（含行业进度/派单），仍可只读；再授权恢复；店主始终允许', async () => {
  const phone = newPhone(); await login(phone, '预约权限');
  assert.equal((await api('GET', '/api/merchant/me', null, STAFF)).body.perms['booking.handle'], true);
  await H.grant({ 'booking.handle': false });
  const ids = { accept: H.insert(phone, 'pending'), reject: H.insert(phone, 'pending'), arrive: H.insert(phone, 'confirmed'), done: H.insert(phone, 'confirmed'), noshow: H.insert(phone, 'confirmed'), cancel: H.insert(phone, 'pending'), next: H.insert(phone, 'confirmed') };
  for (const [op, id] of Object.entries(ids)) {
    const r = await api('POST', `/api/merchant/bookings/${id}/${op}`, null, STAFF);
    assert.equal(r.status, 403, op); assert.equal(r.body.error.perm, 'booking.handle');
  }
  if (F.assignable) { const a = await F.assignable(H, ids.arrive); assert.equal((await api('POST', `/api/merchant/bookings/${ids.arrive}/assign`, { assigneeId: a }, STAFF)).status, 403, 'assign'); }
  for (const u of ['/api/merchant/bookings?scope=all', '/api/merchant/noshows', '/api/merchant/dashboard', '/api/merchant/customers', '/api/merchant/board'])
    assert.equal((await api('GET', u, null, STAFF)).status, 200, '只读查看 ' + u);
  await H.grant({ 'booking.handle': true });
  assert.equal((await api('POST', `/api/merchant/bookings/${ids.accept}/accept`, null, STAFF)).status, 200, '再授权后立即可用');
  for (const op of ['reject', 'noshow', 'cancel']) assert.equal((await api('POST', `/api/merchant/bookings/${ids[op]}/${op}`, null, OWNER)).status, 200, '店主 ' + op);
});

test('拉黑/解除：店员默认关闭；授权后可用；收回立即拒绝', async () => {
  const phone = newPhone(); await login(phone, '拉黑权限'); const cid = R.getCustomerByPhone(phone).id;
  const tries = () => [api('POST', '/api/merchant/customers/blacklist', { phone, on: true }, STAFF), api('POST', '/api/merchant/customers/blacklist', { customerId: cid, on: true }, STAFF), api('POST', `/api/merchant/customers/${cid}/clear`, null, STAFF)];
  for (const r of await Promise.all(tries())) { assert.equal(r.status, 403); assert.equal(r.body.error.perm, 'customer.blacklist'); }
  await H.grant({ 'customer.blacklist': true });
  const on = await api('POST', '/api/merchant/customers/blacklist', { customerId: cid, on: true }, STAFF);
  assert.equal(on.status, 200); assert.match(on.body.phone, H.MASK);
  await api('POST', '/api/merchant/customers/blacklist', { customerId: cid, on: false }, STAFF);
  await H.grant({ 'customer.blacklist': false });
  for (const r of await Promise.all(tries())) assert.equal(r.status, 403);
});

test('手机号打码：店员未授权时所有返回顾客手机号的接口都打码（含会员卡/排队/课程名单）；授权后完整', async () => {
  const phone = newPhone(), tok = await login(phone, '打码测试');
  const bk = H.insert(phone, 'pending'); H.insert(phone, 'no_show');
  await api('POST', '/api/feedback', { type: '其他', text: '打码测试反馈', contact: 'phone' }, tok);
  if (F.extraPhoneData) await F.extraPhoneData(H, phone, tok);
  const urls = ['/api/merchant/bookings?scope=all', '/api/merchant/noshows', '/api/merchant/customers', '/api/merchant/feedback', '/api/merchant/reviews', '/api/merchant/dashboard', '/api/merchant/board?date=' + R.getBooking(bk).date].concat(F.phoneUrls || []);
  for (const u of urls) { const r = await api('GET', u, null, STAFF); assert.equal(r.status, 200, u); assert.ok(!JSON.stringify(r.body).includes(phone), u + ' 不含完整号码'); }
  assert.match((await api('POST', `/api/merchant/bookings/${bk}/accept`, null, STAFF)).body.booking.phone, H.MASK);
  assert.ok(!(await api('GET', '/api/merchant/customers?q=' + phone.slice(3, 7), null, STAFF)).body.some(c => c.name === '打码测试'), '中间位搜索无结果');
  await H.grant({ 'customer.phone': true });
  assert.equal((await api('GET', '/api/merchant/bookings?scope=all', null, STAFF)).body.find(b => b.id === bk).phone, phone);
  for (const u of F.phoneUrls || []) assert.ok(JSON.stringify((await api('GET', u, null, STAFF)).body).includes(phone), '授权后完整 ' + u);
  await H.grant({ 'customer.phone': false });
  assert.match((await api('GET', '/api/merchant/bookings?scope=all', null, STAFF)).body.find(b => b.id === bk).phone, H.MASK);
});

test('演示重置：恢复示例数据；店员不可重置', async () => {
  assert.equal((await api('POST', '/api/merchant/demo-reset', null, STAFF)).status, 403);
  assert.equal((await api('POST', '/api/merchant/demo-reset', null, OWNER)).status, 200);
  const s = (await api('GET', '/api/shop')).body;
  assert.equal(s.services.length, F.serviceCount); assert.ok(s.rating.count >= 5);
});

test('商家登录：错误密码、连续失败锁定', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/api/merchant/login', { username: 'staff2', password: 'nope' })).status, 401);
  assert.equal((await api('POST', '/api/merchant/login', { username: 'staff2', password: 'staff2026' })).status, 429);
});
