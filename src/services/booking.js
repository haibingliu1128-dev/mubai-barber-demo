'use strict';
const Perm = require('./perms');
// 预约业务规则（全部在服务端执行）：时段可用性、并发防超卖、个人限额、防刷、取消时限、爽约限制、定金、审核
const U = require('../lib/util');
const Rules = require('./rules');
const { AppError, toHm, toMin, startAt, today, addDays, parseYmd, ymd, weekRange, monthRange, yuan } = U;
const IND = require('../industry');
const STATUS_TEXT = { awaiting_payment: '待支付定金', pending: '待门店确认', confirmed: '待服务', arrived: '已到店', done: '已完成', cancelled: '已取消', rejected: '门店未接受', expired: '已失效', no_show: '爽约' };

function createBookingService(ctx) {
  const { repo, cfg, pay, bus } = ctx;
  const X = () => ctx.ext;   // 行业扩展服务（资源/会员卡/团课/排队/进度），见 services/ext.js
  const settings = () => Rules.merged(repo.getSettings());
  const now = () => Date.now();

  // ---------- 规则辅助 ----------
  function restriction(C, cust) {
    if (!cust || !C.noshow.on) return { count: 0, restricted: false };
    const since = Math.max(now() - C.noshow.days * 864e5, cust.restrict_cleared_at || 0);
    const list = repo.noShowsSince(cust.id, since);
    if (list.length < C.noshow.n) return { count: list.length, restricted: false };
    const until = list[0].start_at + C.noshow.release * 864e5;
    if (now() >= until) return { count: list.length, restricted: false, released: true };
    return { count: list.length, restricted: true, act: C.noshow.act, until };
  }
  function rateGuard(C, cust) {
    if (C.rate.on && cust.rate_lock_until && cust.rate_lock_until > now()) {
      const mins = Math.ceil((cust.rate_lock_until - now()) / 60000);
      throw new AppError(429, 'RATE_LOCKED', `操作太频繁，线上预约/取消已暂停，约 ${mins} 分钟后恢复（门店设置：${C.rate.m} 分钟内预约+取消达 ${C.rate.n} 次，暂停 ${C.rate.lock} 分钟）`);
    }
  }
  function rateAfter(C, cust) {
    if (!C.rate.on) return;
    const n = repo.countEvents(cust.id, ['book', 'cancel'], now() - C.rate.m * 60000);
    if (n >= C.rate.n) repo.updateCustomer(cust.id, { rate_lock_until: now() + C.rate.lock * 60000 });
  }
  function cancelBlock(C, b, cust) {
    if (b.kind === 'walk') return b.status === 'arrived' && !b.started_at ? null : '当前状态不可取消';
    if (!['awaiting_payment', 'pending', 'confirmed'].includes(b.status) || (b.progress && IND.lockAfterProgress !== false && b.status !== 'confirmed')) return '当前状态不可取消';
    if (b.progress && b.progress !== 'booked' && IND.lockAfterProgress !== false && b.assignee_id) return '已派单，请联系门店取消';
    if (b.status === 'awaiting_payment') return null;
    if (C.cancelH.on && b.start_at - now() < C.cancelH.v * 3600e3) return `距开始不足 ${C.cancelH.v} 小时，不能线上取消，请联系门店（门店设置：开始前 ${C.cancelH.v} 小时内不可线上取消）`;
    if (C.cancelMonth.on && cust) {
      const d = new Date(), m0 = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      const n = repo.countEvents(cust.id, ['cancel'], m0);
      if (n >= C.cancelMonth.v) return `本月已自助取消 ${n} 次，达到上限，请联系门店（门店设置：每月最多自助取消 ${C.cancelMonth.v} 次）`;
    }
    return null;
  }
  function depositFor(C, svc, rst, P) {
    if (P && (P.pay_method !== 'store' || P.kind === 'walk' || P.noDeposit)) return 0;   // 会员卡/储值支付、现场排队不收定金
    let amt = C.deposit.on && svc.deposit_on ? svc.deposit_cents : 0;
    if (rst.restricted && rst.act === 'deposit') amt = Math.max(amt, C.deposit.force * 100);
    return amt;
  }

  // ---------- DTO ----------
  const pj = v => { try { return JSON.parse(v || '{}') || {}; } catch { return {}; } };
  function dto(b, opt = {}) {
    const ex = pj(b.extra), steps = IND.steps || null;
    const step = steps && b.progress ? steps.find(x => x.key === b.progress) : null;
    const o = {
      id: b.id, code: b.code, serviceId: b.service_id, serviceName: b.service_name, price: b.price_cents / 100, duration: b.duration_min,
      date: b.date, time: toHm(b.start_min), endTime: toHm(b.end_min), startAt: b.start_at, name: b.name, note: b.note || '',
      status: b.status, statusText: (['arrived', 'confirmed'].includes(b.status) && step ? step.label : null) || (b.kind === 'walk' && b.status === 'arrived' ? (b.started_at ? '服务中' : '排队中') : STATUS_TEXT[b.status]),
      deposit: b.deposit_cents / 100, depositStatus: b.deposit_status || null,
      holdUntil: b.status === 'awaiting_payment' ? b.hold_until : null, noshowBy: b.noshow_by || null, cancelledBy: b.cancelled_by || null,
      seed: !!b.seed, createdAt: b.created_at,
      kind: b.kind || 'book', progress: b.progress || null, resourceId: b.resource_id || null, assigneeId: b.assignee_id || null, classId: b.class_id || null, seats: b.seats || 1,
      profileId: b.profile_id || null, extra: ex, lines: ex.lines || null, payMethod: b.pay_method || 'store', cardId: b.card_id || null, paid: (b.paid_cents || 0) / 100,
      queueNo: b.queue_no || null, startedAt: b.started_at || null, arrivedAt: b.arrived_at || null, address: b.address || null,
    };
    const X0 = X();
    if (X0) X0.decorate(b, o, opt);
    if (opt.merchant) { const ph = opt.user ? Perm.phoneFor(opt.user, b.phone) : b.phone; Object.assign(o, { phone: ph, phoneMasked: ph !== b.phone, customerId: b.customer_id, custNoshow: b.cust_noshow || 0, custBlack: !!b.cust_black }); }
    else o.phone = U.maskPhone(b.phone);
    if (opt.C) { const r = cancelBlock(opt.C, b, opt.cust); o.canCancel = !r; o.cancelBlock = r; }
    if (IND.dto) IND.dto(b, o, opt, ctx);
    return o;
  }

  // ---------- 查询 ----------
  function publicInfo() {
    const C = settings(), shop = repo.getShop();
    return {
      shop: { name: shop.name, phone: shop.phone, address: shop.address, open: toHm(shop.open_min), close: toHm(shop.close_min), step: shop.step_min, bookDays: shop.book_days },
      services: repo.listServices().map(s => svcDto(s, C)),
      rules: Rules.customerRules(C),
      policy: { verify: C.verify.on, cancelH: C.cancelH.on ? C.cancelH.v : 0, depositOn: C.deposit.on, graceMin: C.grace.on ? C.grace.v : 0 },
      industry: X().publicInfo(),
    };
  }
  const imgs = s => { try { const a = JSON.parse(s.images || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  function svcDto(s, C) {
    return { id: s.id, name: s.name, desc: s.descr, price: s.price_cents / 100, duration: s.duration_min, icon: s.icon, color: s.color, hot: !!s.hot,
      deposit: C.deposit.on && s.deposit_on ? s.deposit_cents / 100 : 0, depositOn: !!s.deposit_on, depositAmount: s.deposit_cents / 100, active: !!s.active,
      images: imgs(s).map(id => ({ id, url: '/api/images/' + id })), cover: imgs(s).length ? '/api/images/' + imgs(s)[0] : null,
      kind: s.kind || 'book', pricing: pj(s.pricing), sort: s.sort };
  }
  /** 某天的可约开始时间：默认按营业时间 + 步长；行业可改（如家政只有上午/下午两个时间窗） */
  function startsFor(shop, svc, date) {
    if (IND.slotStarts) return IND.slotStarts(shop, svc, date);
    const a = []; for (let m = shop.open_min; m < shop.close_min; m += shop.step_min) a.push(m); return a;
  }
  const durClamp = (v, d) => { const n = Math.round(+v); return n >= 15 && n <= 720 ? n : d; };
  function availability(serviceId, from, days, opt = {}) {
    const shop = repo.getShop(), svc = repo.getService(+serviceId);
    if (!svc || !svc.active) throw new AppError(404, 'SERVICE_NOT_FOUND', '服务不存在或已下架');
    const dur = IND.fixedDuration ? IND.fixedDuration(svc) : durClamp(opt.duration, svc.duration_min);
    const mode = X().capacityMode(svc);   // pool 门店容量 / resource 按人员排班
    const rid = opt.resourceId && opt.resourceId !== 'any' ? +opt.resourceId : null;
    if (mode === 'resource' && rid) X().resourceFor(svc, rid);
    const t0 = today(), start = from && U.isDate(from) && from >= t0 ? from : t0;
    const lastDay = ymd(addDays(parseYmd(t0), shop.book_days - 1));
    const out = [], n = Math.min(days || shop.book_days, shop.book_days);
    const dates = []; for (let i = 0; i < n; i++) { const d = ymd(addDays(parseYmd(start), i)); if (d <= lastDay) dates.push(d); }
    if (!dates.length) return { serviceId: svc.id, duration: dur, days: [] };
    const act = repo.activeOnDates(dates[0], dates[dates.length - 1]);
    const nowD = new Date(), nowMin = nowD.getHours() * 60 + nowD.getMinutes();
    const cands = mode === 'resource' ? X().candidates(svc, rid) : [];
    for (const d of dates) {
      const slots = []; let free = 0;
      const working = mode === 'resource' ? cands.filter(r => X().worksOn(r, d)) : [];
      for (const m of startsFor(shop, svc, d)) {
        const e = m + (IND.windowEnd ? IND.windowEnd(m) - m : dur); let why = null;
        const cutoff = IND.cutoffMin != null ? IND.cutoffMin : shop.lead_min;
        if (e > shop.close_min && !IND.windowEnd) why = '近打烊';
        else if (d === t0 && m <= nowMin + cutoff) why = IND.windowEnd ? '已截止' : '已过';
        else if (mode === 'pool') { if (act.filter(b => b.date === d && b.kind !== 'walk' && !b.class_id && !b.resource_id && b.start_min < e && b.end_min > m).length >= shop.capacity) why = '已约'; }
        else {
          if (!working.length) why = '休息';
          else {
            const inShift = working.filter(r => m >= r.start_min && e <= r.end_min);
            if (!inShift.length) why = '非排班';
            else if (!inShift.some(r => !act.some(b => b.date === d && b.resource_id === r.id && b.kind !== 'walk' && !b.class_id && b.start_min < e && b.end_min > m) && !X().resourceConflict(r, d, m, e))) why = '已约';
          }
        }
        if (!why) free++;
        slots.push({ time: toHm(m), ok: !why, why, ...(IND.windowEnd ? { end: toHm(e), label: IND.windowLabel ? IND.windowLabel(m) : null } : {}) });
      }
      out.push({ date: d, free, slots, off: mode === 'resource' && rid ? !working.length : false });
    }
    return { serviceId: svc.id, duration: dur, days: out, mode };
  }
  function me(cust) {
    const C = settings(), r = restriction(C, cust);
    return {
      phone: cust.phone, name: cust.name, blacklisted: !!cust.blacklisted,
      rateLockedUntil: C.rate.on && cust.rate_lock_until > now() ? cust.rate_lock_until : null,
      noshowCount: r.count, restricted: r.restricted ? { act: r.act, until: r.until, deposit: r.act === 'deposit' ? C.deposit.force : 0 } : null,
      openCount: repo.countOpen(cust.id), isNew: repo.isNewCustomer(cust.id),
    };
  }
  function myBookings(cust) {
    const C = settings();
    return repo.listCustomerBookings(cust.id).map(b => dto(b, { C, cust }));
  }
  /** 下单前预检（不落库）：价格、时长、定金、可用支付方式、会不会被拦 */
  function quote(cust, serviceId, input) {
    const C = settings(), svc = repo.getService(+serviceId);
    if (!svc || !svc.active) throw new AppError(404, 'SERVICE_NOT_FOUND', '服务不存在或已下架');
    const r = restriction(C, cust);
    const P = X().plan(svc, cust, input || {}, { mode: 'quote', C });
    const payOptions = X().payOptions(cust, svc, P);
    return { deposit: depositFor(C, svc, r, { ...P, pay_method: 'store' }) / 100, needConfirm: C.confirmNew.on && repo.isNewCustomer(cust.id) && !P.noConfirm, restricted: r.restricted ? r.act : null,
      price: P.price_cents / 100, duration: P.duration_min, lines: P.lines || [], payOptions, requireCard: !!P.requireCard, extra: P.extra || {} };
  }

  // ---------- 下单 ----------
  async function create(cust0, input, meta = {}) {
    input = input || {};
    const { serviceId } = input;
    let { date, time } = input;
    const walk = input.kind === 'walk', isClass = input.classId != null;
    const name = String(input.name || '').trim().slice(0, 12), note = String(input.note || '').trim().slice(0, 60);
    if (!name) throw new AppError(400, 'BAD_INPUT', '请填写称呼');
    if (!walk && !isClass && (!U.isDate(date) || !/^\d{2}:\d{2}$/.test(time || ''))) throw new AppError(400, 'BAD_INPUT', '日期或时间格式不正确');
    const result = repo.tx(() => {
      const C = settings(), shop = repo.getShop(), cust = repo.getCustomer(cust0.id);
      let svc = serviceId != null ? repo.getService(+serviceId) : null;
      if (isClass) { const k = repo.getClass(+input.classId); if (!k || !k.active) throw new AppError(404, 'CLASS_NOT_FOUND', '课程不存在或已取消'); svc = repo.getService(k.service_id); }
      if (!svc || !svc.active) throw new AppError(404, 'SERVICE_NOT_FOUND', '该服务已下架，请重新选择');
      if (cust.blacklisted) throw new AppError(403, 'BLACKLISTED', '该手机号暂不能线上预约，如有疑问请联系门店');
      rateGuard(C, cust);
      const rst = restriction(C, cust);
      if (rst.restricted && rst.act === 'block') {
        throw new AppError(403, 'NOSHOW_BLOCKED', `近 ${C.noshow.days} 天内爽约 ${rst.count} 次，暂不能线上预约，${new Date(rst.until).getMonth() + 1}月${new Date(rst.until).getDate()}日后自动恢复，或联系门店（门店设置：爽约 ${C.noshow.n} 次限制预约）`);
      }
      // 行业计价与校验（价格、时长、档案、加购、地址、指定人员、团课…）
      const P = X().plan(svc, cust, input, { mode: 'create', C });
      const t0 = today(), nowD = new Date(), nowMin = nowD.getHours() * 60 + nowD.getMinutes();
      let sMin, eMin;
      if (walk) {
        if (!X().queueEnabled(svc)) throw new AppError(400, 'NO_QUEUE', '该服务不支持现场排队');
        date = t0; sMin = Math.max(nowMin, shop.open_min); eMin = sMin + P.duration_min;
        if (nowMin < shop.open_min - 60 || nowMin >= shop.close_min - 15) throw new AppError(409, 'QUEUE_CLOSED', `现场取号时间为 ${toHm(shop.open_min - 60)}–${toHm(shop.close_min - 15)}`);
      } else if (isClass) {
        date = P.date; sMin = P.start_min; eMin = P.end_min;
        if (startAt(date, sMin) <= now()) throw new AppError(409, 'CLASS_STARTED', '课程已开始，无法预约');
      } else {
        sMin = toMin(time); eMin = IND.windowEnd ? IND.windowEnd(sMin) : sMin + P.duration_min;
        const lastDay = ymd(addDays(parseYmd(t0), shop.book_days - 1));
        if (date < t0 || date > lastDay) throw new AppError(400, 'OUT_OF_RANGE', `只能预约未来 ${shop.book_days} 天内的时段`);
        if (!startsFor(shop, svc, date).includes(sMin) || (!IND.windowEnd && eMin > shop.close_min)) throw new AppError(400, 'BAD_SLOT', IND.windowEnd ? '请选择可预约的时间窗' : '该时段不在营业时间内');
        const cutoff = IND.cutoffMin != null ? IND.cutoffMin : shop.lead_min;
        if (startAt(date, sMin) <= now() + cutoff * 60000) throw new AppError(400, 'TOO_LATE', IND.windowEnd ? `当天时间窗需提前 ${cutoff / 60} 小时预约` : `该时段已过或距开始不足 ${shop.lead_min} 分钟`);
      }
      const st = startAt(date, sMin);
      // 个人限额（现场排队不计入「未完成」上限）
      if (C.maxOpen.on && !walk) { const n = repo.countOpen(cust.id); if (n >= C.maxOpen.v) throw new AppError(409, 'LIMIT_OPEN', `每人最多同时保留 ${C.maxOpen.v} 个未完成的预约（门店设置），你已有 ${n} 个。到店完成或取消后可再约。`, { limit: C.maxOpen.v, have: n }); }
      if (C.perDay.on) { const n = repo.countLiveBetween(cust.id, date, date); if (n >= C.perDay.v) throw new AppError(409, 'LIMIT_DAY', `同一天每人最多预约 ${C.perDay.v} 个（门店设置），${date.slice(5)} 你已有 ${n} 个。`, { limit: C.perDay.v, have: n }); }
      if (C.perWeek.on) { const [a, b] = weekRange(date), n = repo.countLiveBetween(cust.id, a, b); if (n >= C.perWeek.v) throw new AppError(409, 'LIMIT_WEEK', `每人每周最多预约 ${C.perWeek.v} 个（门店设置），该周你已有 ${n} 个。`, { limit: C.perWeek.v, have: n }); }
      if (C.perMonth.on) { const [a, b] = monthRange(date), n = repo.countLiveBetween(cust.id, a, b); if (n >= C.perMonth.v) throw new AppError(409, 'LIMIT_MONTH', `每人每月最多预约 ${C.perMonth.v} 个（门店设置），该月你已有 ${n} 个。`, { limit: C.perMonth.v, have: n }); }
      // 可用性：团课名额 / 指定人员排班 / 门店容量（触发器兜底）
      let resourceId = null;
      if (isClass) {
        if (repo.myClassBooking(P.class_id, cust.id)) throw new AppError(409, 'ALREADY_BOOKED', '你已预约这节课');
        const k = repo.getClass(P.class_id);
        if (k.booked + (P.seats || 1) > k.cap) throw new AppError(409, 'CLASS_FULL', `名额不足（剩 ${Math.max(0, k.cap - k.booked)} 位），可加入候补`, { left: Math.max(0, k.cap - k.booked) });
      } else if (walk) {
        resourceId = P.resource_id && P.resource_id !== 'any' ? +P.resource_id : null;
      } else if (X().capacityMode(svc) === 'resource') {
        resourceId = X().pickResource(svc, P.resource_id, date, sMin, eMin);
      } else if (repo.overlapCount(date, sMin, eMin) >= shop.capacity) throw new AppError(409, 'SLOT_TAKEN', '该时段刚被约走，请重新选择');
      const payInfo = X().preparePay(cust, svc, P, input, { date });
      const Pp = { ...P, pay_method: payInfo.method };
      const dep = depositFor(C, svc, rst, Pp);
      const pending = !walk && C.confirmNew.on && repo.isNewCustomer(cust.id) && !P.noConfirm;
      const status = walk ? 'arrived' : dep > 0 ? 'awaiting_payment' : pending ? 'pending' : 'confirmed';
      const code = (IND.codePrefix || 'QY') + date.replace(/-/g, '').slice(2) + U.randCode(4);
      let id;
      try {
        id = repo.insertBooking({ code, customer_id: cust.id, service_id: svc.id, service_name: P.service_name || svc.name, price_cents: P.price_cents, duration_min: eMin - sMin,
          date, start_min: sMin, end_min: eMin, start_at: st, end_at: startAt(date, eMin), name, note, status,
          deposit_cents: dep, deposit_status: dep ? 'unpaid' : null, hold_until: dep ? now() + cfg.payHoldMin * 60000 : null,
          kind: walk ? 'walk' : isClass ? 'class' : 'book', resource_id: resourceId, class_id: isClass ? P.class_id : null, seats: P.seats || 1, profile_id: P.profile_id || null,
          extra: { ...(P.extra || {}), lines: P.lines || [] }, progress: walk ? (IND.walkProgress || null) : (P.progress || null), pay_method: payInfo.method, card_id: payInfo.cardId || null,
          address: P.address || null, queue_no: walk ? repo.nextQueueNo(date, X().queuePrefix(svc, resourceId)) : null, arrived_at: walk ? now() : null });
      } catch (e) {
        if (String(e.message).includes('SLOT_TAKEN')) throw new AppError(409, isClass ? 'CLASS_FULL' : 'SLOT_TAKEN', isClass ? '名额刚被约满，可加入候补' : '该时段刚被约走，请重新选择');
        throw e;
      }
      X().afterInsertPay(id, cust, payInfo, { actor: cust.phone });
      if (isClass) repo.removeWait(P.class_id, cust.id);
      if (name && name !== cust.name) repo.updateCustomer(cust.id, { name });
      repo.addEvent(cust.id, 'book', id);
      rateAfter(C, cust);
      let outTradeNo = null;
      if (dep) { outTradeNo = 'DP' + id + 'T' + now().toString(36); repo.insertPayment({ out_trade_no: outTradeNo, booking_id: id, amount_cents: dep, provider: pay.name }); }
      repo.audit({ actor_type: 'customer', actor_id: cust.id, actor_name: cust.phone, action: walk ? 'queue.take' : 'booking.create', target: 'booking:' + id, detail: { code, status, deposit: dep / 100, forced: rst.restricted && rst.act === 'deposit', pay: payInfo.method, price: P.price_cents / 100 }, ip: meta.ip });
      return { id, outTradeNo, dep, pending };
    });
    let payment = null;
    if (result.outTradeNo) {
      try {
        const p = await pay.create({ outTradeNo: result.outTradeNo, amountCents: result.dep, description: '预约定金', openid: meta.openid });
        payment = { outTradeNo: result.outTradeNo, amount: result.dep / 100, provider: p.provider, payParams: p.payParams, holdMin: cfg.payHoldMin };
      } catch (e) {
        repo.tx(() => { repo.updateBooking(result.id, { status: 'expired', cancel_reason: 'pay_create_failed' }); X().releasePay(result.id, 'pay_create_failed'); });
        throw new AppError(e.status || 502, 'PAY_UNAVAILABLE', '支付暂不可用：' + e.message);
      }
    }
    bus.emit('change', { type: input.kind === 'walk' ? 'queue' : 'booking.create', id: result.id });
    return { booking: dto(repo.getBooking(result.id)), payment, needConfirm: result.pending };
  }

  /** 支付成功（模拟回调或微信回调），幂等 */
  async function markPaid(outTradeNo, txnId, raw) {
    let refundLate = false;
    const r = repo.tx(() => {
      const p = repo.getPayment(outTradeNo); if (!p) throw new AppError(404, 'PAY_NOT_FOUND', '支付单不存在');
      if (p.status === 'paid' || p.status === 'refunded') return { bookingId: p.booking_id, already: true };
      repo.updatePayment(outTradeNo, { status: 'paid', provider_txn: txnId || null, paid_at: now(), raw: raw ? JSON.stringify(raw) : null });
      const b = repo.getBooking(p.booking_id), C = settings();
      if (b.status !== 'awaiting_payment' || (b.hold_until && b.hold_until < now() - 5000)) {
        // 超时后才付款：时段可能已释放，自动退款
        if (b.status === 'awaiting_payment') { repo.updateBooking(b.id, { status: 'expired', cancel_reason: 'pay_timeout' }); X().releasePay(b.id, 'pay_timeout'); }
        refundLate = true; return { bookingId: b.id };
      }
      const pending = C.confirmNew.on && repo.isNewCustomer(b.customer_id);
      repo.updateBooking(b.id, { status: pending ? 'pending' : 'confirmed', deposit_status: 'paid', hold_until: null });
      repo.audit({ actor_type: 'customer', actor_id: b.customer_id, actor_name: b.phone, action: 'deposit.paid', target: 'booking:' + b.id, detail: { amount: p.amount_cents / 100, outTradeNo } });
      return { bookingId: b.id };
    });
    if (refundLate) await refund(r.bookingId, 'pay_after_timeout');
    bus.emit('change', { type: 'booking.paid', id: r.bookingId });
    return dto(repo.getBooking(r.bookingId));
  }
  async function refund(bookingId, reason) {
    const p = repo.paymentForBooking(bookingId);
    if (!p || p.status !== 'paid') return false;
    await pay.refund({ outTradeNo: p.out_trade_no, amountCents: p.amount_cents, reason });
    repo.updatePayment(p.out_trade_no, { status: 'refunded', refunded_at: now() });
    repo.updateBooking(bookingId, { deposit_status: 'refunded' });
    repo.audit({ actor_type: 'system', action: 'deposit.refund', target: 'booking:' + bookingId, detail: { amount: p.amount_cents / 100, reason } });
    return true;
  }
  function closePayment(bookingId) {
    const p = repo.paymentForBooking(bookingId);
    if (p && p.status === 'created') repo.updatePayment(p.out_trade_no, { status: 'closed' });
  }

  /** 待支付订单的支付信息（顾客关闭支付面板后继续支付） */
  async function paymentInfo(cust, id) {
    const b = repo.getBooking(+id);
    if (!b || b.customer_id !== cust.id) throw new AppError(404, 'NOT_FOUND', '预约不存在');
    const p = repo.paymentForBooking(b.id);
    if (b.status !== 'awaiting_payment' || !p || p.status !== 'created') throw new AppError(409, 'NO_PAYMENT', '该预约无需支付或已超时');
    const r = await pay.create({ outTradeNo: p.out_trade_no, amountCents: p.amount_cents, description: '预约定金' });
    return { outTradeNo: p.out_trade_no, amount: p.amount_cents / 100, provider: r.provider, payParams: r.payParams, holdUntil: b.hold_until };
  }

  // ---------- 顾客取消 ----------
  async function customerCancel(cust0, id, meta = {}) {
    const r = repo.tx(() => {
      const C = settings(), cust = repo.getCustomer(cust0.id), b = repo.getBooking(+id);
      if (!b || b.customer_id !== cust.id) throw new AppError(404, 'NOT_FOUND', '预约不存在');
      rateGuard(C, cust);
      const why = cancelBlock(C, b, cust);
      if (why) throw new AppError(409, 'CANCEL_BLOCKED', why);
      repo.updateBooking(b.id, { status: 'cancelled', cancelled_by: 'customer', hold_until: null });
      if (b.status !== 'awaiting_payment' && b.kind !== 'walk') { repo.addEvent(cust.id, 'cancel', b.id); rateAfter(C, cust); }
      closePayment(b.id);
      X().releasePay(b.id, 'customer_cancel', cust.phone);
      if (b.class_id) X().promoteWaitlist(b.class_id);
      repo.audit({ actor_type: 'customer', actor_id: cust.id, actor_name: cust.phone, action: 'booking.cancel', target: 'booking:' + b.id, ip: meta.ip });
      return { id: b.id, paid: b.deposit_status === 'paid' };
    });
    const refunded = r.paid ? await refund(r.id, 'customer_cancel') : false;
    bus.emit('change', { type: 'booking.cancel', id: r.id });
    return { booking: dto(repo.getBooking(r.id)), refunded, balanceRefunded: (repo.getBooking(r.id).paid_cents || 0) / 100 };
  }

  // ---------- 商家操作 ----------
  const MOPS = {
    accept: { from: ['pending'], to: 'confirmed' },
    reject: { from: ['pending'], to: 'rejected', refund: true },
    arrive: { from: ['confirmed'], to: 'arrived' },
    done: { from: ['confirmed', 'arrived'], to: 'done' },
    next: { from: ['confirmed', 'arrived'], to: null },   // 行业进度下一步（如 洗护中 → 可接回 → 已接回）
    noshow: { from: ['confirmed'], to: 'no_show', forfeit: true },
    cancel: { from: ['awaiting_payment', 'pending', 'confirmed'], to: 'cancelled', refund: true },
  };
  async function merchantAction(user, id, op, meta = {}) {
    const m = MOPS[op]; if (!m) throw new AppError(400, 'BAD_OP', '未知操作');
    Perm.need(user, 'booking.handle');
    let notify = null;
    const r = repo.tx(() => {
      const b = repo.getBooking(+id); if (!b) throw new AppError(404, 'NOT_FOUND', '预约不存在');
      if (!m.from.includes(b.status)) throw new AppError(409, 'BAD_STATE', `当前状态「${STATUS_TEXT[b.status]}」不能执行该操作`);
      if (op === 'noshow' && b.start_at > now()) throw new AppError(409, 'TOO_EARLY', '预约开始后才能标记爽约');
      if (op === 'noshow' && b.kind === 'walk') throw new AppError(409, 'BAD_STATE', '现场排队请直接取消');
      let f = { status: m.to };
      if (op === 'next') { const n = X().nextStep(b, user); f = n.f; notify = n.notify; }
      else if (IND.beforeOp) IND.beforeOp(ctx, b, op, user);
      if (op === 'arrive') { f.arrived_at = now(); if (IND.steps) f.progress = IND.arriveProgress || IND.steps[0].key; }
      if (op === 'done' && IND.steps && IND.steps.some(x => x.by === 'customer') && b.kind !== 'walk' && !b.class_id) throw new AppError(409, 'NEED_CUSTOMER', '需由顾客确认验收后完成');
      if (op === 'done' && b.kind === 'walk' && !b.started_at) f.started_at = now();
      if (op === 'noshow') { f.noshow_by = 'manual'; if (b.deposit_status === 'paid') f.deposit_status = 'forfeited'; }
      if (op === 'cancel') { f.cancelled_by = 'merchant'; f.hold_until = null; }
      repo.updateBooking(b.id, f);
      if (op === 'cancel' || op === 'reject') { closePayment(b.id); X().releasePay(b.id, 'merchant_' + op, user.username); if (b.class_id) X().promoteWaitlist(b.class_id); }
      if ((f.status || b.status) === 'done' && b.status !== 'done') X().consumeOnDone(b.id, user.username);
      if (op === 'noshow' && b.class_id) X().promoteWaitlist(b.class_id);
      repo.audit({ actor_type: 'merchant', actor_id: user.id, actor_name: user.username, action: 'booking.' + op, target: 'booking:' + b.id, detail: { from: b.status, code: b.code, ...(op === 'next' ? { step: f.progress || f.status } : {}) }, ip: meta.ip });
      return { id: b.id, paid: b.deposit_status === 'paid' };
    });
    const refunded = m.refund && r.paid ? await refund(r.id, 'merchant_' + op) : false;
    if (notify) X().notify(repo.getBooking(r.id), notify);
    bus.emit('change', { type: 'booking.' + op, id: r.id });
    return { booking: dto(repo.getBooking(r.id), { merchant: true, user }), refunded };
  }

  // ---------- 定时任务：过期待支付、过期待确认、超时未到自动爽约 ----------
  async function tick() {
    const C = settings(), t = now(), refunds = [];
    let changed = 0;
    repo.tx(() => {
      for (const { id } of repo.expiredHolds(t)) { repo.updateBooking(id, { status: 'expired', cancel_reason: 'pay_timeout', hold_until: null }); closePayment(id); X().releasePay(id, 'pay_timeout'); changed++; }
      for (const { id } of repo.pendingPastStart(t)) {
        const b = repo.getBooking(id); repo.updateBooking(id, { status: 'expired', cancel_reason: 'not_confirmed' }); X().releasePay(id, 'not_confirmed'); if (b.deposit_status === 'paid') refunds.push(id); changed++;
      }
      if (C.grace.on) for (const { id } of repo.overdueConfirmed(t - C.grace.v * 60000)) {
        const b = repo.getBooking(id);
        if (IND.noAutoNoshow && IND.noAutoNoshow(b)) continue;
        repo.updateBooking(id, { status: 'no_show', noshow_by: 'auto', deposit_status: b.deposit_status === 'paid' ? 'forfeited' : b.deposit_status });
        if (b.class_id) X().promoteWaitlist(b.class_id);
        repo.audit({ actor_type: 'system', action: 'booking.noshow_auto', target: 'booking:' + id, detail: { code: b.code, graceMin: C.grace.v } });
        changed++;
      }
    });
    for (const id of refunds) await refund(id, 'not_confirmed');
    if (changed) bus.emit('change', { type: 'scheduler', n: changed });
    return changed;
  }

  return { settings, restriction, cancelBlock, publicInfo, svcDto, availability, me, myBookings, quote, create, paymentInfo, markPaid, refund, customerCancel, merchantAction, tick, dto, STATUS_TEXT };
}
module.exports = { createBookingService, STATUS_TEXT };
