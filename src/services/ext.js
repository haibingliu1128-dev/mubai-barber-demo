'use strict';
// 行业扩展业务（全部服务端校验）：
//   人员/工位排班与指定、顾客档案（宠物/车辆）、会员卡（次卡/储值/年卡/课时包）与流水、
//   团课名额与候补自动递补、现场排队取号、行业进度（下一步）、派单、到店/完工短信通知（模拟通道）
const U = require('../lib/util');
const Perm = require('./perms');
const IND = require('../industry');
const { AppError, toHm, today, addDays, parseYmd, ymd, maskPhone } = U;
const pj = (v, d) => { try { const x = JSON.parse(v); return x == null ? d : x; } catch { return d; } };

function createExtService(ctx) {
  const { repo, bus, sms, cfg } = ctx;
  const now = () => Date.now();
  const T = IND.terms || {};
  const audit = (user, action, target, detail, ip) => repo.audit({ actor_type: 'merchant', actor_id: user.id, actor_name: user.username, action, target, detail, ip });
  const weekday = d => parseYmd(d).getDay();

  // ================= 人员 / 工位 =================
  const resDto = (r, full) => {
    const o = { id: r.id, kind: r.kind, name: r.name, title: r.title, tier: r.tier, intro: r.intro, tags: pj(r.tags, []), skills: pj(r.skills, []),
      start: toHm(r.start_min), end: toHm(r.end_min), offDays: pj(r.off_days, []), color: r.color, avatar: r.avatar, letter: r.letter, extra: pj(r.extra, {}), active: !!r.active };
    if (IND.resourceDto) IND.resourceDto(r, o, full, ctx);
    return o;
  };
  function ratings() {
    const rows = repo.db.prepare(`SELECT COALESCE(b.resource_id, b.assignee_id) rid, r.stars, r.tags FROM reviews r JOIN bookings b ON b.id=r.booking_id
      WHERE r.status='public' AND COALESCE(b.resource_id, b.assignee_id) IS NOT NULL`).all();
    const m = {};
    for (const x of rows) { const a = m[x.rid] || (m[x.rid] = { n: 0, sum: 0, tags: {} }); a.n++; a.sum += x.stars; for (const t of pj(x.tags, [])) a.tags[t] = (a.tags[t] || 0) + 1; }
    const out = {};
    for (const [k, a] of Object.entries(m)) out[k] = { n: a.n, avg: Math.round(a.sum / a.n * 10) / 10, tags: Object.entries(a.tags).sort((p, q) => q[1] - p[1]).slice(0, 3).map(x => x[0]) };
    return out;
  }
  const dayOverride = (rid, date) => repo.db.prepare('SELECT off FROM resource_days WHERE resource_id=? AND date=?').get(rid, date);
  function worksOn(r, date) {
    const o = dayOverride(r.id, date);
    if (o) return !o.off;
    return !pj(r.off_days, []).includes(weekday(date));
  }
  const skilled = (r, svc) => { const sk = pj(r.skills, []); return !sk.length || sk.includes(svc.id); };
  function capacityMode(svc) { return IND.capacityMode ? IND.capacityMode(svc) : (IND.resourceMode && IND.resourceMode !== 'none' ? 'resource' : 'pool'); }
  function candidates(svc, rid) {
    const all = repo.listResources().filter(r => r.kind === (IND.resourceKind || r.kind) && skilled(r, svc));
    return rid ? all.filter(r => r.id === rid) : all;
  }
  function resourceFor(svc, rid) {
    const r = repo.getResource(+rid);
    if (!r || !r.active || (IND.resourceKind && r.kind !== IND.resourceKind)) throw new AppError(404, 'RESOURCE_NOT_FOUND', `${T.resource || '服务人员'}不存在`);
    if (!skilled(r, svc)) throw new AppError(400, 'RESOURCE_SKILL', `${r.name}暂不提供「${svc.name}」`);
    return r;
  }
  const resourceConflict = (r, d, s, e) => (IND.resourceConflict ? IND.resourceConflict(ctx, r, d, s, e) : false);
  function freeFor(r, date, s, e) { return worksOn(r, date) && s >= r.start_min && e <= r.end_min && !repo.resourceBusy(r.id, date, s, e) && !resourceConflict(r, date, s, e); }
  function pickResource(svc, rid, date, s, e) {
    if (rid == null || rid === '' || rid === 'any') {
      if (IND.resourceMode === 'required') throw new AppError(400, 'NEED_RESOURCE', `请选择${T.resource || '服务人员'}`);
      const c = candidates(svc).filter(r => freeFor(r, date, s, e)).sort((a, b) => repo.resourceBookingsOn(a.id, date) - repo.resourceBookingsOn(b.id, date) || a.sort - b.sort);
      if (!c.length) throw new AppError(409, 'SLOT_TAKEN', '该时段刚被约走，请重新选择');
      return c[0].id;
    }
    const r = resourceFor(svc, rid);
    if (!worksOn(r, date)) throw new AppError(409, 'RESOURCE_OFF', `${r.name}当天休息，请换一天或换人`);
    if (s < r.start_min || e > r.end_min) throw new AppError(409, 'RESOURCE_SHIFT', `${r.name}的排班时间为 ${toHm(r.start_min)}–${toHm(r.end_min)}`);
    if (repo.resourceBusy(r.id, date, s, e) || resourceConflict(r, date, s, e)) throw new AppError(409, 'SLOT_TAKEN', `${r.name}该时段刚被约走，请重新选择`);
    return r.id;
  }

  // ================= 计价（行业 plan） =================
  function plan(svc, cust, input, opt) {
    let P = { price_cents: svc.price_cents, duration_min: svc.duration_min, lines: [], extra: {}, resource_id: input.resourceId != null ? input.resourceId : null, seats: 1 };
    if (input.classId != null) {
      const k = repo.getClass(+input.classId);
      if (!k || !k.active) throw new AppError(404, 'CLASS_NOT_FOUND', '课程不存在或已取消');
      const seats = Math.round(+input.seats || 1), max = IND.maxSeats || 1;
      if (!(seats >= 1 && seats <= max)) throw new AppError(400, 'BAD_SEATS', `每次可预约 1–${max} 位`);
      const t = k.resource_id ? repo.getResource(k.resource_id) : null;
      P = { ...P, class_id: k.id, date: k.date, start_min: k.start_min, end_min: k.end_min, duration_min: k.end_min - k.start_min, seats, service_name: k.title,
        price_cents: svc.price_cents * seats, resource_id: null, extra: { classTitle: k.title, room: k.room, teacher: t ? t.name : null, level: k.level } };
    }
    if (IND.plan) P = IND.plan(ctx, svc, cust, input, P, opt) || P;
    return P;
  }

  // ================= 会员卡 =================
  const cardDto = (k, opt = {}) => {
    const o = { id: k.id, name: k.name, kind: k.kind, scope: k.scope, serviceId: k.service_id, total: k.total, remain: k.remain, balance: k.balance_cents / 100,
      discount: k.discount, level: k.level, expires: k.expires, expired: !!(k.expires && k.expires < today()), seed: !!k.seed, createdAt: k.created_at, productId: k.product_id };
    if (k.kind === 'count') o.pending = repo.cardPendingUses(k.id);
    if (opt.user) { const ph = Perm.phoneFor(opt.user, k.phone); Object.assign(o, { customerId: k.customer_id, phone: ph, phoneMasked: ph !== k.phone, cname: k.cname }); }
    return o;
  };
  const scopeOk = (k, svc, P) => {
    if (IND.cardScopeOk) return IND.cardScopeOk(k, svc, P);
    return k.scope === 'all' || (k.service_id && k.service_id === svc.id) || (P.scope && k.scope === P.scope);
  };
  /** 卡是否可用于这一单：返回 {ok, why, charge} */
  function cardUsable(k, svc, P, date) {
    const seats = P.seats || 1;
    if (k.expires && k.expires < (date || today())) return { ok: false, why: '已过期' };
    if (!scopeOk(k, svc, P)) return { ok: false, why: '不适用该项目' };
    if (k.kind === 'balance') {
      const charge = Math.round(P.price_cents * k.discount / 1000);
      if (k.balance_cents < charge) return { ok: false, why: `余额不足（需 ¥${charge / 100}）`, charge };
      return { ok: true, charge };
    }
    if (k.kind === 'count') { const left = k.remain - repo.cardPendingUses(k.id); if (left < seats) return { ok: false, why: left <= 0 ? '次数已用完（含已预约未核销）' : `剩余 ${left} 次不足` }; return { ok: true, charge: 0, left }; }
    return { ok: true, charge: 0 };   // period 年卡：有效期内不限次
  }
  function payOptions(cust, svc, P) {
    const out = [];
    if (!P.requireCard && !P.noStore) out.push({ method: 'store', label: T.storePay || '到店支付', ok: true });
    if (!cust) return out;
    for (const k of repo.listCards(cust.id)) {
      const u = cardUsable(k, svc, P);
      if (u.why === '不适用该项目') continue;
      out.push({ method: k.kind === 'balance' ? 'balance' : 'card', cardId: k.id, label: k.name, kind: k.kind, ok: u.ok, why: u.why || null, charge: (u.charge || 0) / 100,
        balance: k.balance_cents / 100, remain: k.kind === 'count' ? k.remain : null, left: u.left != null ? u.left : null, discount: k.discount, expires: k.expires });
    }
    return out;
  }
  function preparePay(cust, svc, P, input, { date }) {
    const method = input.payMethod || (P.requireCard ? null : 'store');
    if (!method) throw new AppError(400, 'NEED_CARD', P.requireCardMsg || '请选择会员卡');
    if (method === 'store') {
      if (P.requireCard || P.noStore) throw new AppError(400, 'NEED_CARD', P.requireCardMsg || '该项目需使用会员卡');
      return { method: 'store' };
    }
    if (!['balance', 'card'].includes(method)) throw new AppError(400, 'BAD_PAY', '支付方式不正确');
    const k = repo.getCard(+input.cardId);
    if (!k || k.customer_id !== cust.id) throw new AppError(404, 'CARD_NOT_FOUND', '会员卡不存在');
    if ((method === 'balance') !== (k.kind === 'balance')) throw new AppError(400, 'BAD_PAY', '支付方式与卡类型不符');
    const u = cardUsable(k, svc, P, date);
    if (!u.ok) throw new AppError(409, 'CARD_UNUSABLE', `「${k.name}」${u.why}`);
    return { method, cardId: k.id, charge: u.charge || 0 };
  }
  function afterInsertPay(bookingId, cust, pi, { actor }) {
    if (pi.method !== 'balance' || !pi.charge) return;
    const k = repo.getCard(pi.cardId);
    repo.updateCard(k.id, { balance_cents: k.balance_cents - pi.charge });
    repo.updateBooking(bookingId, { paid_cents: pi.charge });
    repo.addLedger({ card_id: k.id, customer_id: cust.id, kind: 'pay', amount_cents: -pi.charge, booking_id: bookingId, note: '预约扣款', actor });
  }
  /** 取消/拒绝/超时：退回储值扣款（幂等） */
  function releasePay(bookingId, reason, actor) {
    const b = repo.getBooking(bookingId);
    if (!b || b.pay_method !== 'balance' || !b.paid_cents || repo.ledgerForBooking(b.id, 'refund').length) return 0;
    const k = repo.getCard(b.card_id); if (!k) return 0;
    repo.updateCard(k.id, { balance_cents: k.balance_cents + b.paid_cents });
    repo.addLedger({ card_id: k.id, customer_id: b.customer_id, kind: 'refund', amount_cents: b.paid_cents, booking_id: b.id, note: { customer_cancel: '顾客取消退回', merchant_cancel: '门店取消退回', merchant_reject: '门店未接受退回', pay_timeout: '超时退回', not_confirmed: '未确认退回' }[reason] || '退回', actor: actor || 'system' });
    return b.paid_cents;
  }
  /** 完成/签到：核销次卡或年卡（幂等） */
  function consumeOnDone(bookingId, actor) {
    const b = repo.getBooking(bookingId);
    if (!b || b.pay_method !== 'card' || !b.card_id || repo.ledgerForBooking(b.id, 'use').length) return;
    const k = repo.getCard(b.card_id); if (!k) return;
    if (k.kind === 'count') {
      if (k.remain < b.seats) throw new AppError(409, 'CARD_EMPTY', `「${k.name}」剩余次数不足，请改为到店支付`);
      repo.updateCard(k.id, { remain: k.remain - b.seats });
    }
    repo.addLedger({ card_id: k.id, customer_id: b.customer_id, kind: 'use', times: k.kind === 'count' ? -b.seats : 0, booking_id: b.id, note: (b.service_name || '') + (k.kind === 'period' ? '（不限次）' : ''), actor });
  }
  function myCards(cust) {
    return { cards: repo.listCards(cust.id).map(k => cardDto(k)), ledger: repo.customerLedger(cust.id).map(ledgerDto),
      products: repo.listCardProducts().filter(p => p.self_service).map(prodDto) };
  }
  const prodDto = p => ({ id: p.id, name: p.name, kind: p.kind, scope: p.scope, serviceId: p.service_id, price: p.price_cents / 100, times: p.times, bonus: p.bonus_cents / 100, discount: p.discount, days: p.days, selfService: !!p.self_service });
  const ledgerDto = (l, user) => {
    const o = { id: l.id, cardId: l.card_id, cardName: l.card_name, kind: l.kind, times: l.times, amount: l.amount_cents / 100, bonus: l.bonus_cents / 100, bookingId: l.booking_id, note: l.note, at: l.at, seed: !!l.seed };
    if (user && l.phone) { const ph = Perm.phoneFor(user, l.phone); Object.assign(o, { phone: ph, phoneMasked: ph !== l.phone, cname: l.cname }); }
    return o;
  };
  /** 开卡 / 充值（店内收款后由店员登记；或顾客模拟支付自助充值） */
  function issueCard(cust, p, actor) {
    const t = today(), exp = p.days ? ymd(addDays(parseYmd(t), p.days - 1)) : null;
    if (p.kind === 'balance') {
      const cur = repo.listCards(cust.id).find(k => k.kind === 'balance');
      const add = p.price_cents + p.bonus_cents;
      if (cur) {
        const better = p.discount < cur.discount;
        repo.updateCard(cur.id, { balance_cents: cur.balance_cents + add, ...(better ? { discount: p.discount, level: p.name, name: p.name } : {}) });
        repo.addLedger({ card_id: cur.id, customer_id: cust.id, kind: 'recharge', amount_cents: p.price_cents, bonus_cents: p.bonus_cents, note: p.name + (better ? '（升级）' : ''), actor });
        return repo.getCard(cur.id);
      }
      const id = repo.insertCard({ customer_id: cust.id, product_id: p.id, name: p.name, kind: 'balance', scope: p.scope, service_id: p.service_id, balance_cents: add, discount: p.discount, level: p.name, expires: exp });
      repo.addLedger({ card_id: id, customer_id: cust.id, kind: 'open', amount_cents: p.price_cents, bonus_cents: p.bonus_cents, note: p.name, actor });
      return repo.getCard(id);
    }
    const id = repo.insertCard({ customer_id: cust.id, product_id: p.id, name: p.name, kind: p.kind, scope: p.scope, service_id: p.service_id, total: p.times, remain: p.times, expires: exp });
    repo.addLedger({ card_id: id, customer_id: cust.id, kind: 'open', times: p.times, amount_cents: p.price_cents, note: p.name, actor });
    return repo.getCard(id);
  }
  function merchantIssue(user, body, ip) {
    Perm.need(user, 'booking.handle');
    const p = repo.getCardProduct(+body.productId); if (!p || !p.active) throw new AppError(404, 'NOT_FOUND', '卡种不存在');
    let cust;
    if (body.customerId != null) cust = repo.getCustomer(+body.customerId);
    else { const phone = String(body.phone || '').trim(); if (!U.isPhone(phone)) throw new AppError(400, 'BAD_PHONE', '请输入正确的 11 位手机号'); cust = repo.ensureCustomer(phone, String(body.name || '').trim().slice(0, 12) || null); }
    if (!cust) throw new AppError(404, 'NOT_FOUND', '顾客不存在');
    const k = repo.tx(() => issueCard(cust, p, user.username));
    audit(user, p.kind === 'balance' ? 'card.recharge' : 'card.open', 'card:' + k.id, { product: p.name, amount: p.price_cents / 100, customer: maskPhone(cust.phone) }, ip);
    bus.emit('change', { type: 'card' });
    return cardDto(repo.getCard(k.id), { user });
  }
  function selfRecharge(cust, body, ip) {
    if (cfg.payProvider !== 'mock') throw new AppError(501, 'NOT_READY', '在线充值需接入真实支付后开放，请到店办理');
    const p = repo.getCardProduct(+body.productId); if (!p || !p.active || !p.self_service) throw new AppError(404, 'NOT_FOUND', '充值档位不存在');
    const k = repo.tx(() => issueCard(repo.getCustomer(cust.id), p, '顾客（模拟支付）'));
    repo.audit({ actor_type: 'customer', actor_id: cust.id, actor_name: cust.phone, action: 'card.recharge', target: 'card:' + k.id, detail: { product: p.name, amount: p.price_cents / 100, mock: true }, ip });
    bus.emit('change', { type: 'card' });
    return { card: cardDto(repo.getCard(k.id)), paid: p.price_cents / 100, bonus: p.bonus_cents / 100, mock: true };
  }
  function manualUse(user, cardId, body, ip) {
    Perm.need(user, 'booking.handle');
    const times = Math.round(+body.times || 1), note = String(body.note || '').trim().slice(0, 30) || '手动核销';
    const k = repo.getCard(+cardId); if (!k) throw new AppError(404, 'NOT_FOUND', '会员卡不存在');
    if (k.kind !== 'count') throw new AppError(400, 'BAD_CARD', '仅次卡/课时包可手动核销');
    if (!(times >= 1 && times <= 10)) throw new AppError(400, 'BAD_INPUT', '核销次数 1–10');
    if (k.expires && k.expires < today()) throw new AppError(409, 'CARD_EXPIRED', '卡已过期');
    if (k.remain < times) throw new AppError(409, 'CARD_EMPTY', `剩余 ${k.remain} 次，不足 ${times} 次`);
    repo.tx(() => { repo.updateCard(k.id, { remain: k.remain - times }); repo.addLedger({ card_id: k.id, customer_id: k.customer_id, kind: 'manual', times: -times, note, actor: user.username }); });
    audit(user, 'card.use', 'card:' + k.id, { times, note }, ip);
    bus.emit('change', { type: 'card' });
    return cardDto(repo.getCard(k.id), { user });
  }
  function merchantCards(user, q) {
    let rows = repo.allCards();
    q = q && String(q).trim();
    if (q) { const full = Perm.can(user, 'customer.phone'); rows = rows.filter(k => (k.cname && k.cname.includes(q)) || k.name.includes(q) || k.phone === q || (full ? k.phone.includes(q) : maskPhone(k.phone).includes(q))); }
    return { cards: rows.map(k => cardDto(k, { user })), products: repo.listCardProducts().map(prodDto) };
  }
  function merchantCard(user, id) {
    const k = repo.getCard(+id); if (!k) throw new AppError(404, 'NOT_FOUND', '会员卡不存在');
    return { card: cardDto(k, { user }), ledger: repo.cardLedger(k.id).map(l => ledgerDto(l)) };
  }
  function ledger(user, kinds) { return repo.ledgerByKind(kinds && kinds.length ? kinds : ['open', 'recharge'], 150).map(l => ledgerDto(l, user)); }

  // ================= 顾客档案（宠物/车辆） =================
  const PK = IND.profile || null;
  const profDto = p => ({ id: p.id, kind: p.kind, ...pj(p.data, {}), seed: !!p.seed });
  function profiles(cust) { if (!PK) return []; return repo.listProfiles(cust.id, PK.kind).map(profDto); }
  function saveProfile(cust, id, body) {
    if (!PK) throw new AppError(404, 'NOT_FOUND', 'not found');
    const data = PK.validate(body || {}, ctx);
    if (id) {
      const p = repo.getProfile(+id); if (!p || p.customer_id !== cust.id || p.deleted) throw new AppError(404, 'NOT_FOUND', `${PK.label}不存在`);
      repo.updateProfile(p.id, { data: JSON.stringify(data) }); return profDto(repo.getProfile(p.id));
    }
    if (repo.listProfiles(cust.id, PK.kind).length >= (PK.max || 8)) throw new AppError(409, 'TOO_MANY', `最多添加 ${PK.max || 8} 个${PK.label}`);
    if (PK.unique) { const k = PK.unique(data); if (repo.listProfiles(cust.id, PK.kind).some(p => PK.unique(pj(p.data, {})) === k)) throw new AppError(409, 'DUPLICATE', `该${PK.label}已添加`); }
    return profDto(repo.getProfile(repo.insertProfile({ customer_id: cust.id, kind: PK.kind, data: JSON.stringify(data) })));
  }
  function deleteProfile(cust, id) {
    const p = repo.getProfile(+id); if (!p || p.customer_id !== cust.id || p.deleted) throw new AppError(404, 'NOT_FOUND', '档案不存在');
    const busy = repo.db.prepare(`SELECT COUNT(*) n FROM bookings WHERE profile_id=? AND status IN ('awaiting_payment','pending','confirmed','arrived')`).get(p.id).n;
    if (busy) throw new AppError(409, 'IN_USE', `该${PK.label}有未完成的预约，完成或取消后再删除`);
    repo.updateProfile(p.id, { deleted: 1 }); return { ok: true };
  }
  function ownProfile(cust, id) {
    if (!PK) return null;
    const p = id != null ? repo.getProfile(+id) : null;
    if (!p || !cust || p.customer_id !== cust.id || p.deleted) throw new AppError(400, 'NEED_PROFILE', `请选择${PK.label}`);
    return { id: p.id, ...pj(p.data, {}) };
  }

  // ================= 团课 / 候补 =================
  function classDto(k, cust, full) {
    const t = k.resource_id ? repo.getResource(k.resource_id) : null;
    const o = { id: k.id, date: k.date, time: toHm(k.start_min), endTime: toHm(k.end_min), serviceId: k.service_id, title: k.title, level: k.level, room: k.room, color: k.color,
      teacherId: k.resource_id, teacher: t ? t.name : null, cap: k.cap, booked: k.booked, left: Math.max(0, k.cap - k.booked), waiting: k.waiting || 0,
      started: U.startAt(k.date, k.start_min) <= now(), seed: !!k.seed };
    if (cust) {
      const b = repo.myClassBooking(k.id, cust.id); o.myBookingId = b ? b.id : null; o.mySeats = b ? b.seats : 0;
      o.myWait = !!repo.db.prepare('SELECT 1 FROM waitlist WHERE class_id=? AND customer_id=?').get(k.id, cust.id);
      if (o.myWait) o.waitPos = repo.listWait(k.id).findIndex(w => w.customer_id === cust.id) + 1;
    }
    return o;
  }
  function classes(cust, from, days) {
    const t0 = today(), f = from && U.isDate(from) && from >= t0 ? from : t0, shop = repo.getShop();
    const to = ymd(addDays(parseYmd(t0), shop.book_days - 1)), end = ymd(addDays(parseYmd(f), Math.min(+days || shop.book_days, shop.book_days) - 1));
    return repo.listClasses(f, end < to ? end : to).map(k => classDto(k, cust));
  }
  function joinWait(cust, classId, name) {
    const k = repo.getClass(+classId); if (!k || !k.active) throw new AppError(404, 'CLASS_NOT_FOUND', '课程不存在');
    if (U.startAt(k.date, k.start_min) <= now()) throw new AppError(409, 'CLASS_STARTED', '课程已开始');
    if (repo.myClassBooking(k.id, cust.id)) throw new AppError(409, 'ALREADY_BOOKED', '你已预约这节课');
    if (k.booked < k.cap) throw new AppError(409, 'NOT_FULL', '还有名额，可直接预约');
    if (IND.waitCheck) IND.waitCheck(ctx, cust, k);
    try { repo.addWait(k.id, cust.id, name); } catch { throw new AppError(409, 'ALREADY_WAITING', '你已在候补名单中'); }
    repo.audit({ actor_type: 'customer', actor_id: cust.id, actor_name: cust.phone, action: 'class.wait', target: 'class:' + k.id });
    bus.emit('change', { type: 'classes' });
    return { position: repo.listWait(k.id).findIndex(w => w.customer_id === cust.id) + 1 };
  }
  function leaveWait(cust, classId) { const n = repo.removeWait(+classId, cust.id); if (!n) throw new AppError(404, 'NOT_FOUND', '不在候补名单中'); bus.emit('change', { type: 'classes' }); return { ok: true }; }
  /** 有人取消后按候补顺序自动递补（需有可用的卡；没有则跳过并通知） */
  function promoteWaitlist(classId) {
    const k = repo.getClass(classId); if (!k || U.startAt(k.date, k.start_min) <= now()) return [];
    const out = [];
    for (const w of repo.listWait(classId)) {
      const cur = repo.getClass(classId); if (cur.booked >= cur.cap) break;
      const cust = repo.getCustomer(w.customer_id), svc = repo.getService(k.service_id);
      const P = plan(svc, cust, { classId }, { mode: 'promote' });
      const card = repo.listCards(cust.id).find(c => c.kind !== 'balance' && cardUsable(c, svc, P, k.date).ok);
      repo.removeWait(classId, cust.id);
      if (!card && P.requireCard) { repo.audit({ actor_type: 'system', action: 'class.promote_skip', target: 'class:' + classId, detail: { customer: maskPhone(cust.phone), why: '无可用卡' } }); out.push({ skip: cust.id }); continue; }
      const id = repo.insertBooking({ code: (IND.codePrefix || 'QY') + k.date.replace(/-/g, '').slice(2) + U.randCode(4), customer_id: cust.id, service_id: svc.id, service_name: k.title, price_cents: P.price_cents, duration_min: k.end_min - k.start_min,
        date: k.date, start_min: k.start_min, end_min: k.end_min, start_at: U.startAt(k.date, k.start_min), end_at: U.startAt(k.date, k.end_min), name: w.name || cust.name || '顾客', status: 'confirmed',
        kind: 'class', class_id: classId, seats: 1, extra: { ...P.extra, promoted: true }, pay_method: card ? 'card' : 'store', card_id: card ? card.id : null });
      repo.audit({ actor_type: 'system', action: 'class.promote', target: 'booking:' + id, detail: { class: k.title, customer: maskPhone(cust.phone) } });
      notify(repo.getBooking(id), `候补成功：${k.date.slice(5)} ${toHm(k.start_min)}「${k.title}」已为你保留名额${card ? '，签到时扣「' + card.name + '」1 次' : ''}`);
      out.push({ booked: id });
    }
    if (out.length) bus.emit('change', { type: 'classes' });
    return out;
  }
  function merchantClasses(user, date) {
    const d = date && U.isDate(date) ? date : today();
    return repo.listClasses(d, d).map(k => ({ ...classDto(k), roster: roster(user, k.id).bookings.length }));
  }
  function roster(user, id) {
    const k = repo.getClass(+id); if (!k) throw new AppError(404, 'NOT_FOUND', '课程不存在');
    const B = ctx.booking;
    return { cls: classDto({ ...k, waiting: repo.listWait(k.id).length }), bookings: repo.classBookings(k.id).filter(b => ['pending', 'confirmed', 'arrived', 'done', 'no_show'].includes(b.status)).map(b => B.dto(b, { merchant: true, user })),
      waitlist: repo.listWait(k.id).map((w, i) => { const ph = Perm.phoneFor(user, w.phone); return { pos: i + 1, name: w.name, phone: ph, phoneMasked: ph !== w.phone, at: w.created_at }; }) };
  }
  function addClass(user, body, ip) {
    Perm.need(user, 'service.manage');
    const date = String(body.date || ''), m = U.toMin(String(body.time || '')), svc = repo.getService(+body.serviceId);
    if (!U.isDate(date) || date < today()) throw new AppError(400, 'BAD_INPUT', '日期不正确');
    if (!(m >= 0)) throw new AppError(400, 'BAD_INPUT', '时间不正确');
    if (!svc || !svc.active) throw new AppError(404, 'SERVICE_NOT_FOUND', '课程类型不存在');
    const pr = pj(svc.pricing, {}), dur = svc.duration_min, shop = repo.getShop();
    if (m < shop.open_min || m + dur > shop.close_min) throw new AppError(400, 'BAD_SLOT', `需在营业时间 ${toHm(shop.open_min)}–${toHm(shop.close_min)} 内`);
    const t = body.teacherId ? repo.getResource(+body.teacherId) : null;
    if (body.teacherId && !t) throw new AppError(404, 'NOT_FOUND', '老师不存在');
    const room = String(body.room || pr.room || 'A').slice(0, 8);
    const clash = repo.listClasses(date, date).find(k => k.start_min < m + dur && k.end_min > m && (k.room === room || (t && k.resource_id === t.id)));
    if (clash) throw new AppError(409, 'CLASS_CLASH', `与 ${toHm(clash.start_min)}「${clash.title}」${clash.room === room ? '教室' : '老师'}冲突`);
    if (t && repo.resourceBusy(t.id, date, m, m + dur)) throw new AppError(409, 'CLASS_CLASH', `${t.name}该时段有私教预约`);
    const cap = Math.round(+body.cap || pr.cap || 12);
    if (!(cap >= 1 && cap <= 40)) throw new AppError(400, 'BAD_INPUT', '名额 1–40');
    const id = repo.insertClass({ date, start_min: m, end_min: m + dur, service_id: svc.id, title: svc.name, level: pr.level || null, resource_id: t ? t.id : null, room, color: svc.color || 0, cap });
    audit(user, 'class.create', 'class:' + id, { date, time: toHm(m), title: svc.name }, ip);
    bus.emit('change', { type: 'classes' });
    return classDto(repo.getClass(id));
  }
  function deleteClass(user, id, ip) {
    Perm.need(user, 'service.manage');
    const k = repo.getClass(+id); if (!k || !k.active) throw new AppError(404, 'NOT_FOUND', '课程不存在');
    if (repo.classCount(k.id)) throw new AppError(409, 'CLASS_HAS_BOOKINGS', '已有学员预约，请先联系学员取消后再删除');
    repo.tx(() => { repo.updateClass(k.id, { active: 0 }); repo.db.prepare('DELETE FROM waitlist WHERE class_id=?').run(k.id); });
    audit(user, 'class.delete', 'class:' + k.id, { date: k.date, time: toHm(k.start_min), title: k.title }, ip);
    bus.emit('change', { type: 'classes' });
    return { ok: true };
  }

  // ================= 现场排队 =================
  const queueEnabled = svc => !!(IND.queue && (!IND.queue.services || IND.queue.services(svc)));
  const queuePrefix = (svc, rid) => (IND.queue && IND.queue.prefix ? IND.queue.prefix(ctx, svc, rid) : 'A');
  /** 排队看板：每个队列（按发型师 / 全店工位）当前服务中、等待人数与预计等待 */
  function queueBoard(user, cust) {
    if (!IND.queue) return null;
    const d = today(), live = repo.liveOn(d), B = ctx.booking;
    const b = IND.queue.board(ctx, live, d);
    const strip = x => {
      const o = B.dto(x, user ? { merchant: true, user } : {});
      if (x.eta != null) o.eta = x.eta;
      if (!user) { const mine = cust && x.customer_id === cust.id; return { id: o.id, queueNo: o.queueNo, kind: o.kind, serviceName: o.serviceName, time: o.time, status: o.status, progress: o.progress, startedAt: o.startedAt, resourceId: o.resourceId, assigneeId: o.assigneeId, eta: o.eta, mine, label: mine ? o.name : U.maskName ? U.maskName(o.name) : '顾客', plate: o.extra && o.extra.profile && o.extra.profile.plate ? maskPlate(o.extra.profile.plate) : null }; }
      return o;
    };
    return { date: d, groups: b.groups.map(g => ({ ...g, serving: g.serving.map(strip), waiting: g.waiting.map(strip) })), summary: b.summary || null };
  }
  const maskPlate = p => p ? p.slice(0, 2) + '•••' + p.slice(-2) : null;

  // ================= 行业进度 / 派单 / 通知 =================
  function nextStep(b, user) {
    const steps = IND.steps; if (!steps) throw new AppError(400, 'BAD_OP', '该门店没有进度流程');
    const idx = b.progress ? steps.findIndex(x => x.key === b.progress) : -1;
    const nx = steps[idx + 1];
    if (!nx) throw new AppError(409, 'BAD_STATE', '已是最后一步');
    if (nx.by === 'customer') throw new AppError(409, 'NEED_CUSTOMER', nx.waitText || '等待顾客确认');
    if (nx.needAssign && !b.assignee_id) throw new AppError(409, 'NEED_ASSIGN', nx.needAssignText || '请先分配');
    if (nx.status === 'arrived' && b.status === 'confirmed' && b.start_at - now() > 3 * 3600e3 && b.kind !== 'walk') throw new AppError(409, 'TOO_EARLY', '距预约开始超过 3 小时，暂不能开始');
    const f = { progress: nx.key, status: nx.status || b.status };
    if (f.status === 'arrived' && !b.arrived_at) f.arrived_at = now();
    if (nx.start && !b.started_at) f.started_at = now();
    if (IND.onStep) IND.onStep(ctx, b, nx, f, user);
    return { f, notify: nx.notify ? (typeof nx.notify === 'function' ? nx.notify(b) : nx.notify) : null };
  }
  function assign(user, id, aid, ip) {
    Perm.need(user, 'booking.handle');
    const r = repo.tx(() => {
      const b = repo.getBooking(+id); if (!b) throw new AppError(404, 'NOT_FOUND', '预约不存在');
      if (!['confirmed', 'arrived', 'pending'].includes(b.status)) throw new AppError(409, 'BAD_STATE', '当前状态不能分配');
      const a = repo.getResource(+aid);
      if (!a || !a.active || a.kind !== (IND.assignKind || IND.resourceKind)) throw new AppError(404, 'NOT_FOUND', `${T.assignee || T.resource || '人员'}不存在`);
      if (IND.canAssign) { const why = IND.canAssign(ctx, b, a); if (why) throw new AppError(409, 'CANNOT_ASSIGN', why); }
      if (!IND.assignNoOverlap && repo.assigneeBusy(a.id, b.date, b.start_min, b.end_min, b.id)) throw new AppError(409, 'ASSIGNEE_BUSY', `${a.name}该时段已有安排`);
      const f = { assignee_id: a.id };
      if (IND.onAssign) Object.assign(f, IND.onAssign(ctx, b, a) || {});
      repo.updateBooking(b.id, f);
      audit(user, 'booking.assign', 'booking:' + b.id, { code: b.code, to: a.name }, ip);
      return b.id;
    });
    bus.emit('change', { type: 'booking.assign', id: r });
    return ctx.booking.dto(repo.getBooking(r), { merchant: true, user });
  }
  function notify(b, text) {
    if (!b || !text) return;
    Promise.resolve().then(() => sms.notify ? sms.notify({ phone: b.phone, text }) : null).catch(e => ctx.log.warn(e));
    repo.audit({ actor_type: 'system', action: 'notify.sms', target: 'booking:' + b.id, detail: { text, to: maskPhone(b.phone || '') } });
  }

  // ================= DTO 装饰 =================
  const resName = new Map();
  function rname(id) { if (!id) return null; const r = repo.getResource(id); return r ? r.name : null; }
  function decorate(b, o, opt) {
    if (b.resource_id) { const r = repo.getResource(b.resource_id); o.resourceName = r ? r.name : null; o.resourceTitle = r ? r.title : null; }
    if (b.assignee_id) o.assigneeName = rname(b.assignee_id);
    if (b.card_id) { const k = repo.getCard(b.card_id); o.cardName = k ? k.name : null; }
    if (b.pay_method === 'balance' && b.paid_cents) o.balanceRefunded = !!repo.ledgerForBooking(b.id, 'refund').length;
    if (b.pay_method === 'card') o.cardUsed = !!repo.ledgerForBooking(b.id, 'use').length;
    if (IND.steps) { o.steps = IND.steps.map(x => ({ key: x.key, label: x.label, by: x.by || null })); o.stepIndex = b.progress ? IND.steps.findIndex(x => x.key === b.progress) : -1;
      const nx = IND.steps[o.stepIndex + 1]; o.nextStep = ['confirmed', 'arrived'].includes(b.status) && nx ? { key: nx.key, label: nx.action || nx.label, by: nx.by || null, needAssign: !!nx.needAssign } : null; }
  }

  // ================= 公开信息 / 商家资源管理 =================
  function publicInfo() {
    const rt = ratings();
    const res = repo.listResources().map(r => ({ ...resDto(r), rating: rt[r.id] || null }));
    const base = { slug: IND.slug, terms: T, resourceMode: IND.resourceMode || 'none', resources: IND.publicResources === false ? [] : res,
      addons: repo.listAddons().map(a => ({ id: a.id, name: a.name, price: a.price_cents / 100, duration: a.duration_min, meta: pj(a.meta, {}) })),
      cardProducts: repo.listCardProducts().map(prodDto), steps: IND.steps ? IND.steps.map(x => ({ key: x.key, label: x.label, by: x.by || null })) : null,
      profile: PK ? { kind: PK.kind, label: PK.label } : null, queue: IND.queue ? { on: true } : null, classes: !!IND.classes, maxSeats: IND.maxSeats || 1 };
    if (IND.publicInfo) Object.assign(base, IND.publicInfo(ctx));
    return base;
  }
  function merchantResources(user, date) {
    const d = date && U.isDate(date) ? date : today(), rt = ratings(), live = repo.liveOn(d);
    return repo.listResources(true).filter(r => r.active).map(r => ({ ...resDto(r, true), rating: rt[r.id] || null, works: worksOn(r, d), override: dayOverride(r.id, d) || null,
      bookings: live.filter(b => b.resource_id === r.id || b.assignee_id === r.id).map(b => ctx.booking.dto(b, { merchant: true, user })) }));
  }
  function setResourceDay(user, rid, body, ip) {
    Perm.need(user, 'service.manage');
    const r = repo.getResource(+rid); if (!r) throw new AppError(404, 'NOT_FOUND', '人员不存在');
    const date = String(body.date || ''); if (!U.isDate(date) || date < today()) throw new AppError(400, 'BAD_INPUT', '日期不正确');
    const off = !!body.off;
    if (off && repo.resourceBookingsOn(r.id, date)) throw new AppError(409, 'HAS_BOOKINGS', `${r.name} 当天已有预约，请先改约或取消后再设为休息`);
    if (off && IND.classes && repo.teacherClassesOn(r.id, date).length) throw new AppError(409, 'HAS_BOOKINGS', `${r.name} 当天有排课，请先调整课表`);
    repo.setResourceDay(r.id, date, off);
    audit(user, 'resource.day', 'resource:' + r.id, { name: r.name, date, off }, ip);
    bus.emit('change', { type: 'resource' });
    return { ok: true, works: worksOn(r, date) };
  }
  function updateResource(user, rid, body, ip) {
    Perm.need(user, 'service.manage');
    const r = repo.getResource(+rid); if (!r) throw new AppError(404, 'NOT_FOUND', '人员不存在');
    const f = {};
    if (body.start !== undefined || body.end !== undefined) {
      const s = U.toMin(String(body.start || toHm(r.start_min))), e = U.toMin(String(body.end || toHm(r.end_min)));
      const shop = repo.getShop();
      if (!(s >= shop.open_min && e <= shop.close_min && e - s >= 60)) throw new AppError(400, 'BAD_INPUT', `排班需在营业时间 ${toHm(shop.open_min)}–${toHm(shop.close_min)} 内，且至少 1 小时`);
      f.start_min = s; f.end_min = e;
    }
    if (body.offDays !== undefined) { const a = [...new Set((Array.isArray(body.offDays) ? body.offDays : []).map(Number))]; if (a.some(x => !(x >= 0 && x <= 6)) || a.length > 3) throw new AppError(400, 'BAD_INPUT', '每周固定休息最多 3 天'); f.off_days = JSON.stringify(a.sort()); }
    if (body.skills !== undefined) { const ids = new Set(repo.listServices().map(s => s.id)); const a = (Array.isArray(body.skills) ? body.skills : []).map(Number).filter(x => ids.has(x)); f.skills = JSON.stringify([...new Set(a)]); }
    if (body.intro !== undefined) f.intro = String(body.intro || '').slice(0, 60);
    repo.updateResource(r.id, f);
    audit(user, 'resource.update', 'resource:' + r.id, { name: r.name, ...f }, ip);
    bus.emit('change', { type: 'resource' });
    return resDto(repo.getResource(r.id), true);
  }
  // 加购项
  function saveAddon(user, id, body, ip) {
    Perm.need(user, 'service.manage');
    const name = String(body.name || '').trim(), price = Number(body.price), dur = Math.round(+body.duration || 0);
    if (!name || name.length > 10) throw new AppError(400, 'BAD_INPUT', '名称 1–10 字');
    if (!(price >= 0 && price <= 9999)) throw new AppError(400, 'BAD_INPUT', '价格 0–9999 元');
    if (!(dur >= 0 && dur <= 120)) throw new AppError(400, 'BAD_INPUT', '时长 0–120 分钟');
    const meta = IND.addonMeta ? IND.addonMeta(body) : {};
    const f = { name, price_cents: Math.round(price * 100), duration_min: dur, meta: JSON.stringify(meta) };
    if (id) { if (!repo.getAddon(+id)) throw new AppError(404, 'NOT_FOUND', '加购项不存在'); repo.updateAddon(+id, f); } else id = repo.insertAddon({ ...f, sort: 99 });
    audit(user, 'addon.save', 'addon:' + id, f, ip); bus.emit('change', { type: 'service' });
    return { id: +id };
  }
  function deleteAddon(user, id, ip) { Perm.need(user, 'service.manage'); repo.updateAddon(+id, { active: 0 }); audit(user, 'addon.delete', 'addon:' + id, null, ip); bus.emit('change', { type: 'service' }); return { ok: true }; }

  return { resDto, ratings, worksOn, capacityMode, candidates, resourceFor, resourceConflict, pickResource, freeFor, plan,
    cardDto, cardUsable, payOptions, preparePay, afterInsertPay, releasePay, consumeOnDone, myCards, merchantIssue, selfRecharge, manualUse, merchantCards, merchantCard, ledger, issueCard,
    profiles, saveProfile, deleteProfile, ownProfile, classes, classDto, joinWait, leaveWait, promoteWaitlist, merchantClasses, roster, addClass, deleteClass,
    queueEnabled, queuePrefix, queueBoard, maskPlate, nextStep, assign, notify, decorate, publicInfo, merchantResources, setResourceDay, updateResource, saveAddon, deleteAddon };
}
module.exports = { createExtService };
