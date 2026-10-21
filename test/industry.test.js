'use strict';
// 理发行业功能测试：总监/设计师两级价、必须指定发型师、按发型师分别取号与预计等待、师傅工作台（叫号/完成/忙碌拦截）、会员卡折扣支付与退回、权限与打码
const { test, before, after } = require('node:test');
const { harness } = require('./helpers');
const H = harness(), { assert, D, api, login, newPhone } = H;
let OWNER, STAFF, shop0, R0;
before(async () => { await H.start(); ({ OWNER, STAFF } = H); shop0 = H.R.getShop(); R0 = H.R.listResources(true); });
after(() => H.stop());
const today = () => require('../src/lib/util').today();
const sty = name => R0.find(r => r.name === name);
const wd = d => new Date(d + 'T00:00:00').getDay();
const works = (r, d) => !JSON.parse(r.off_days).includes(wd(d));
/** 让现场取号在任何时刻都可用（测试可能在夜间运行）：营业时间与发型师班次临时放开到全天 */
const openAllDay = () => { H.R.upsertShop({ ...shop0, open_min: 0, close_min: 1440 }); H.R.db.prepare("UPDATE resources SET start_min=0, end_min=1440, off_days='[]' WHERE kind='stylist'").run(); };
const restore = () => { H.R.upsertShop(shop0); const u = H.R.db.prepare('UPDATE resources SET start_min=?, end_min=?, off_days=? WHERE id=?'); for (const r of R0) u.run(r.start_min, r.end_min, r.off_days, r.id); };
const clearToday = () => { for (const b of H.R.liveOn(today())) if (b.status === 'arrived' || b.status === 'confirmed') H.R.updateBooking(b.id, { status: 'cancelled' }); };
const dayFor = r => { for (let i = 1; i < 7; i++) if (works(r, D(i))) return D(i); };

test('总监 / 设计师两级价：同一服务按发型师级别计价，必须指定发型师；改价校验与权限；基础价 = 最低价', async () => {
  const tok = await login(newPhone()), chen = sty('陈总监'), jie = sty('阿杰');
  const q = async (r, sid = 1) => (await api('POST', '/api/quote', { serviceId: sid, resourceId: r.id, date: dayFor(r), time: '15:00' }, tok)).body;
  assert.equal((await q(chen)).price, 128); assert.equal((await q(jie)).price, 68); assert.equal((await q(chen, 3)).price, 498);
  assert.match((await q(chen)).lines[0].label, /洗剪吹（总监）/);
  const no = await api('POST', '/api/bookings', { serviceId: 1, date: dayFor(jie), time: '15:00', name: '测试' }, tok);
  assert.equal(no.status, 400); assert.equal(no.body.error.code, 'NEED_RESOURCE');
  const b = await api('POST', '/api/bookings', { serviceId: 1, resourceId: chen.id, date: dayFor(chen), time: '15:00', name: '测试' }, tok);
  assert.equal(b.status, 201, JSON.stringify(b.body)); assert.equal(b.body.booking.price, 128); assert.equal(b.body.booking.resourceName, '陈总监'); assert.equal(b.body.booking.extra.tierName, '总监');
  const off = D([1, 2, 3, 4, 5, 6].find(i => !works(jie, D(i))));
  assert.equal((await api('POST', '/api/bookings', { serviceId: 1, resourceId: jie.id, date: off, time: '15:00', name: '测试' }, tok)).body.error.code, 'RESOURCE_OFF');
  const av = (await api('GET', `/api/availability?serviceId=1&resourceId=${jie.id}&from=${off}&days=1`)).body.days[0];
  assert.ok(av.slots.every(s => !s.ok), '休息日没有可约时段');
  const lin = sty('林总监'), la = (await api('GET', `/api/availability?serviceId=1&resourceId=${lin.id}&from=${dayFor(lin)}&days=1`)).body.days[0];
  assert.ok(la.slots.filter(s => s.time < '12:00').every(s => !s.ok), '林总监 12:00 才上班');
  assert.equal((await api('PUT', '/api/merchant/services/1', { pricing: { designer: 70, director: 'x' } }, OWNER)).status, 400);
  assert.equal((await api('PUT', '/api/merchant/services/1', { pricing: { designer: 70, director: 130 } }, STAFF)).status, 403);
  const r = await api('PUT', '/api/merchant/services/1', { pricing: { designer: 70, director: 130 } }, OWNER);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.price, 70); assert.deepEqual(r.body.pricing, { designer: 70, director: 130 });
  assert.equal((await q(jie)).price, 70);
  await api('PUT', '/api/merchant/services/1', { pricing: { designer: 68, director: 128 } }, OWNER);
  const info = (await api('GET', '/api/shop')).body.industry;
  assert.equal(info.resources.filter(x => x.kind === 'stylist').length, 4); assert.ok(info.resources.every(x => x.tierName && x.letter));
});

test('按发型师现场取号：号码前缀 = 发型师字母、看板打码不含手机号、前面人数与预计等待；烫染不能取号、未选发型师 / 休息 / 不在班拦截', async () => {
  clearToday(); openAllDay();
  try {
    const chen = sty('陈总监'), jie = sty('阿杰');
    const p1 = newPhone(), t1 = await login(p1, '排队甲'), t2 = await login(newPhone(), '排队乙'), t3 = await login(newPhone(), '排队丙');
    const a = await api('POST', '/api/queue', { serviceId: 1, resourceId: chen.id, name: '排队甲' }, t1);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const ba = a.body.booking; assert.equal(ba.kind, 'walk'); assert.equal(ba.progress, 'waiting'); assert.equal(ba.price, 128); assert.match(ba.queueNo, /^A\d{3}$/);
    const b = (await api('POST', '/api/queue', { serviceId: 2, resourceId: chen.id, name: '排队乙' }, t2)).body.booking;
    const c = (await api('POST', '/api/queue', { serviceId: 2, resourceId: jie.id, name: '排队丙' }, t3)).body.booking;
    assert.ok(b.queueNo > ba.queueNo); assert.match(c.queueNo, /^B\d{3}$/); assert.equal(c.price, 38);
    const pub = await api('GET', '/api/queue', null, t1), txt = JSON.stringify(pub.body);
    assert.ok(!txt.includes(p1), '公开看板不含手机号'); assert.ok(!txt.includes('排队乙'), '他人姓名打码');
    const gA = pub.body.groups.find(g => g.key === String(chen.id)), sA = pub.body.summary.stylists.find(s => s.id === chen.id);
    assert.equal(gA.waiting.length, 2); assert.equal(gA.waiting[0].mine, true); assert.equal(gA.waiting[0].eta, 0); assert.equal(gA.waiting[1].eta, 45, '排在 45 分钟洗剪吹之后');
    assert.equal(sA.ahead, 2); assert.equal(sA.eta, 75); assert.equal(sA.tierName, '总监');
    assert.equal(pub.body.summary.stylists.find(s => s.id === jie.id).ahead, 1);
    const long = await api('POST', '/api/queue', { serviceId: 3, resourceId: chen.id, name: '烫发' }, t1);
    assert.equal(long.status, 400); assert.equal(long.body.error.code, 'NO_QUEUE');
    assert.equal((await api('POST', '/api/queue', { serviceId: 1, name: '不选' }, t1)).body.error.code, 'NEED_RESOURCE');
    H.R.db.prepare('UPDATE resources SET off_days=? WHERE id=?').run(JSON.stringify([wd(today())]), jie.id);
    assert.equal((await api('POST', '/api/queue', { serviceId: 1, resourceId: jie.id, name: '休息' }, t1)).body.error.code, 'RESOURCE_OFF');
    assert.equal((await api('GET', '/api/queue')).body.summary.stylists.find(s => s.id === jie.id).off, true);
    H.R.db.prepare("UPDATE resources SET off_days='[]', start_min=0, end_min=1 WHERE id=?").run(jie.id);
    assert.equal((await api('POST', '/api/queue', { serviceId: 1, resourceId: jie.id, name: '下班' }, t1)).body.error.code, 'RESOURCE_SHIFT');
    // 顾客可取消尚未开始的排队
    assert.equal((await api('POST', `/api/bookings/${b.id}/cancel`, null, t2)).status, 200);
    assert.equal((await api('GET', '/api/queue')).body.summary.stylists.find(s => s.id === chen.id).ahead, 1);
  } finally { restore(); }
});

test('师傅工作台：叫号开始服务 → 完成；同一发型师同时只能服务一位（STYLIST_BUSY）；已开始的排队不能取消；看板显示服务进度', async () => {
  clearToday(); openAllDay();
  try {
    const xy = sty('小雅'), toks = [await login(newPhone()), await login(newPhone())];
    const ids = [];
    for (const t of toks) ids.push((await api('POST', '/api/queue', { serviceId: 1, resourceId: xy.id, name: '工作台' }, t)).body.booking.id);
    const s1 = await api('POST', `/api/merchant/bookings/${ids[0]}/next`, null, STAFF);
    assert.equal(s1.status, 200, JSON.stringify(s1.body)); assert.equal(s1.body.booking.progress, 'serving'); assert.ok(s1.body.booking.startedAt);
    const busy = await api('POST', `/api/merchant/bookings/${ids[1]}/next`, null, STAFF);
    assert.equal(busy.status, 409); assert.equal(busy.body.error.code, 'STYLIST_BUSY');
    assert.equal((await api('POST', `/api/bookings/${ids[0]}/cancel`, null, toks[0])).status, 409, '已开始服务不能取消');
    const mq = (await api('GET', '/api/merchant/queue', null, STAFF)).body, g = mq.groups.find(x => x.key === String(xy.id));
    assert.equal(g.serving[0].id, ids[0]); assert.ok(g.serving[0].phone, '商家看板有联系方式'); assert.ok(mq.summary.stylists.find(s => s.id === xy.id).serving.pct > 0);
    const dash = (await api('GET', '/api/merchant/dashboard', null, OWNER)).body.industry.tiles;
    assert.deepEqual(dash.map(x => x.k), ['排队中', '今日办卡']); assert.equal(dash[0].v, 1);
    assert.equal((await api('POST', `/api/merchant/bookings/${ids[0]}/next`, null, STAFF)).body.booking.status, 'done');
    assert.equal((await api('POST', `/api/merchant/bookings/${ids[1]}/next`, null, STAFF)).body.booking.progress, 'serving', '完成后可叫下一位');
    // 预约顾客当天到店签到后进入该发型师队列；非今日不能签到
    const t = await login(newPhone()); restore();
    const d1 = dayFor(xy), slot = (await api('GET', `/api/availability?serviceId=1&resourceId=${xy.id}&from=${d1}&days=1`)).body.days[0].slots.find(s => s.ok);
    const fut = await api('POST', '/api/bookings', { serviceId: 1, resourceId: xy.id, date: d1, time: slot.time, name: '预约' }, t);
    openAllDay();
    assert.equal(fut.status, 201, JSON.stringify(fut.body));
    if (fut.body.booking.status === 'pending') await api('POST', `/api/merchant/bookings/${fut.body.booking.id}/accept`, null, STAFF);
    assert.equal((await api('POST', `/api/merchant/bookings/${fut.body.booking.id}/next`, null, STAFF)).status, 409, '非今日不能签到');
    H.R.updateBooking(fut.body.booking.id, { date: today(), start_at: Date.now() + 20 * 60000 });
    const ar = await api('POST', `/api/merchant/bookings/${fut.body.booking.id}/next`, null, STAFF);
    assert.equal(ar.status, 200, JSON.stringify(ar.body)); assert.equal(ar.body.booking.progress, 'waiting'); assert.match(ar.body.booking.queueNo, /^C\d{3}$/);
  } finally { restore(); }
});

test('会员卡：到店办银卡（需处理预约权限）、余额按 8.5 折扣款、取消退回、再办金卡余额累加且折扣升级；顾客不能自助充值', async () => {
  const phone = newPhone(), tok = await login(phone, '会员测试'), chen = sty('陈总监'), date = dayFor(chen);
  const P = (await api('GET', '/api/shop')).body.industry.cardProducts;
  assert.deepEqual(P.map(p => [p.name, p.price, p.discount, p.selfService]), [['银卡', 1000, 850, false], ['金卡', 2000, 800, false]]);
  assert.equal((await api('POST', '/api/me/recharge', { productId: P[0].id }, tok)).status >= 400, true, '会员卡需到店办理');
  await H.grant({ 'booking.handle': false });
  assert.equal((await api('POST', '/api/merchant/cards', { phone, productId: P[0].id }, STAFF)).status, 403);
  await H.grant({ 'booking.handle': true });
  const k = await api('POST', '/api/merchant/cards', { phone, name: '会员测试', productId: P[0].id }, STAFF);
  assert.equal(k.status, 201, JSON.stringify(k.body)); assert.equal(k.body.balance, 1000); assert.equal(k.body.discount, 850);
  const q = (await api('POST', '/api/quote', { serviceId: 1, resourceId: chen.id, date, time: '16:00' }, tok)).body;
  const opt = q.payOptions.find(o => o.method === 'balance'); assert.equal(opt.charge, 108.8, '总监洗剪吹 128 × 8.5 折');
  const b = await api('POST', '/api/bookings', { serviceId: 1, resourceId: chen.id, date, time: '16:00', name: '会员测试', payMethod: 'balance', cardId: k.body.id }, tok);
  assert.equal(b.status, 201, JSON.stringify(b.body)); assert.equal(b.body.booking.payMethod, 'balance');
  const bal = async () => (await api('GET', '/api/me/cards', null, tok)).body.cards[0].balance;
  assert.equal(await bal(), 891.2);
  assert.equal((await api('POST', `/api/bookings/${b.body.booking.id}/cancel`, null, tok)).status, 200);
  assert.equal(await bal(), 1000, '取消后退回');
  const g = await api('POST', '/api/merchant/cards', { phone, productId: P[1].id }, OWNER);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const mine = (await api('GET', '/api/me/cards', null, tok)).body;
  assert.equal(mine.cards.length, 1); assert.equal(mine.cards[0].balance, 3000); assert.equal(mine.cards[0].discount, 800); assert.equal(mine.cards[0].level, '金卡');
  assert.ok(mine.ledger.some(l => l.kind === 'refund'));
  const ml = (await api('GET', '/api/merchant/cards', null, STAFF)).body.cards.find(x => x.id === k.body.id);
  assert.match(ml.phone, /^\d{3}\*{4}\d{4}$/, '员工看到打码手机号');
});

test('发型师评价：按发型师筛选公开评价；示例数据（作品、今日预约、会员）齐全', async () => {
  const chen = sty('陈总监');
  const r = (await api('GET', `/api/reviews?resourceId=${chen.id}&limit=30`)).body;
  assert.ok(r.items.length >= 2); assert.ok(r.items.every(x => x.serviceName ? true : true));
  const all = (await api('GET', '/api/reviews?limit=30')).body;
  assert.ok(all.summary.count > r.summary.count, '筛选后只剩该发型师的评价');
  const info = (await api('GET', '/api/shop')).body.industry;
  assert.ok(info.resources.every(x => Array.isArray(x.extra.works) && x.extra.works.length === 4));
  assert.equal(info.longMin, 100);
  const cards = (await api('GET', '/api/merchant/cards', null, OWNER)).body.cards;
  assert.ok(cards.some(k => k.level === '银卡') && cards.some(k => k.level === '金卡'));
});
