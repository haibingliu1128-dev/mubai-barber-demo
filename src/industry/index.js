'use strict';
// 行业模块：理发（木白理发工作室 · 示例门店）
//   发型师分「总监 / 设计师」两级，同一服务两级不同价；预约必须指定发型师（只显示其上班且空闲的时段）
//   现场取号：按发型师分别排队（陈总监 A01、阿杰 B01…），显示前面人数与预计等待；烫染等长时项目只能预约
//   师傅工作台：叫号开始服务 → 完成；会员卡：银卡 充 1000 享 8.5 折、金卡 充 2000 享 8 折（到店办卡，余额支付按折扣扣款）
const { AppError } = require('../lib/util');
const U = require('../lib/util');
const TIERS = [['designer', '设计师'], ['director', '总监']];
const TIER_NAME = Object.fromEntries(TIERS);
const pj = (v, d = {}) => { try { return JSON.parse(v || 'null') || d; } catch { return d; } };
const now = () => Date.now();
const LONG = 100;   // 时长 ≥100 分钟的项目（烫/染）只能预约
function stylists(repo) { return repo.listResources().filter(r => r.kind === 'stylist' && r.active); }

const IND = {
  slug: 'barber', brand: '木白理发工作室', codePrefix: 'MB', dbName: 'barber.db', defaultIcon: 'scissors',
  features: ['stylists', 'tier-pricing', 'per-stylist-queue', 'workbench', 'member-discount-cards', 'portfolio'],
  accounts: { owner: 'mubai2026', staff: '前台小木（演示）', staff2: '助理小白（演示）' },
  terms: { resource: '发型师', assignee: '发型师', storePay: '到店支付', service: '服务', booking: '预约' },
  resourceMode: 'required', resourceKind: 'stylist',
  durations: [30, 45, 60, 90, 120, 150, 180],
  rules: {
    review: { tagsPos: ['剪得满意', '手艺好', '沟通到位', '准时', '环境干净', '不推销'], tagsNeg: ['等太久', '效果一般', '推销办卡', '价格偏高'] },
    feedback: { types: ['功能建议', '服务投诉', '发型师相关', '排队问题', '其他'] },
  },
  steps: [
    { key: 'waiting', label: '等候中', action: '到店签到', status: 'arrived' },
    { key: 'serving', label: '服务中', action: '叫号 · 开始服务', status: 'arrived', start: true },
    { key: 'done', label: '已完成', action: '完成', status: 'done' },
  ],
  arriveProgress: 'waiting', walkProgress: 'waiting',
  resourceDto(r, o) { o.tierName = TIER_NAME[r.tier] || ''; },
  validatePricing(pr) {
    const out = {};
    for (const [k, n] of TIERS) { const v = pr && pr[k]; if (!Number.isInteger(+v) || +v < 0 || +v > 9999 || v === '' || v == null) throw new AppError(400, 'BAD_INPUT', `${n}价需为 0–9999 的整数`); out[k] = +v; }
    return out;
  },
  pricingBase: pr => ({ price: Math.min(...Object.values(pr)) }),
  publicInfo: () => ({ tiers: TIERS, longMin: LONG }),
  plan(ctx, svc, cust, input, P) {
    const pr = pj(svc.pricing), rid = input.resourceId != null && input.resourceId !== '' && input.resourceId !== 'any' ? +input.resourceId : null;
    if (!rid) { if (input.kind === 'walk') throw new AppError(400, 'NEED_RESOURCE', '请选择要排队的发型师'); return P; }
    const r = ctx.ext.resourceFor(svc, rid);
    const price = pr[r.tier] != null ? pr[r.tier] : svc.price_cents / 100;
    if (input.kind === 'walk') {
      if (svc.duration_min >= LONG) throw new AppError(400, 'NO_QUEUE', `「${svc.name}」时间较长，请提前预约`);
      const d = U.today(), nowD = new Date(), m = nowD.getHours() * 60 + nowD.getMinutes();
      if (!ctx.ext.worksOn(r, d)) throw new AppError(409, 'RESOURCE_OFF', `${r.name}今天休息，可选择其他发型师或改约`);
      if (m < r.start_min - 30 || m > r.end_min - svc.duration_min) throw new AppError(409, 'RESOURCE_SHIFT', `${r.name}的上班时间为 ${U.toHm(r.start_min)}–${U.toHm(r.end_min)}，当前不能取号`);
    }
    return { ...P, resource_id: r.id, price_cents: Math.round(price * 100), lines: [{ label: `${svc.name}（${TIER_NAME[r.tier] || r.title || ''}）`, amount: price }], extra: { tier: r.tier, tierName: TIER_NAME[r.tier] } };
  },
  queue: {
    prefix: (ctx, svc, rid) => { const r = rid && ctx.repo.getResource(+rid); return (r && r.letter) || 'A'; },
    services: svc => svc.duration_min < LONG,
    board(ctx, live, d) {
      const t = now(), S = stylists(ctx.repo), nowD = new Date(), m = nowD.getHours() * 60 + nowD.getMinutes();
      const groups = [], sum = [];
      for (const r of S) {
        const mine = live.filter(b => b.resource_id === r.id && b.status === 'arrived');
        const serving = mine.filter(b => b.progress === 'serving');
        const waiting = mine.filter(b => b.progress !== 'serving').sort((a, b) => (a.arrived_at || 0) - (b.arrived_at || 0));
        let free = serving.length ? Math.max(t + 60000, (serving[0].started_at || t) + serving[0].duration_min * 60000) : t;
        for (const w of waiting) { w.eta = Math.max(0, Math.round((free - t) / 60000)); free = Math.max(free, t) + w.duration_min * 60000; }
        const works = ctx.ext.worksOn(r, d);
        groups.push({ key: String(r.id), name: r.name, serving, waiting });
        const s0 = serving[0];
        sum.push({ id: r.id, name: r.name, letter: r.letter, tier: r.tier, tierName: TIER_NAME[r.tier], off: !works, inShift: works && m >= r.start_min - 30 && m < r.end_min,
          start: U.toHm(r.start_min), end: U.toHm(r.end_min), ahead: waiting.length, eta: Math.max(0, Math.round((free - t) / 60000)),
          serving: s0 ? { serviceName: s0.service_name, queueNo: s0.queue_no, mins: Math.max(0, Math.round((t - (s0.started_at || t)) / 60000)), pct: Math.min(97, Math.max(3, Math.round((t - (s0.started_at || t)) / 60000 / s0.duration_min * 100))) } : null });
      }
      return { groups, summary: { stylists: sum } };
    },
  },
  onStep(ctx, b, nx, f) {
    if (nx.key === 'waiting') {
      if (b.date !== U.today()) throw new AppError(409, 'NOT_TODAY', '非今日预约，到店当天再签到');
      if (!b.queue_no) { const r = b.resource_id && ctx.repo.getResource(b.resource_id); f.queue_no = ctx.repo.nextQueueNo(b.date, (r && r.letter) || 'A'); }   // 预约到店签到也领该发型师的号
    }
    if (nx.key === 'serving') {
      const busy = ctx.repo.liveOn(b.date).find(x => x.id !== b.id && x.resource_id === b.resource_id && x.status === 'arrived' && x.progress === 'serving');
      if (busy) throw new AppError(409, 'STYLIST_BUSY', `该发型师正在服务（${busy.queue_no || busy.service_name}），请先完成`);
    }
  },
  dashboard(ctx) {
    const { repo } = ctx, d = U.today(), live = repo.liveOn(d), t0 = U.startAt(d, 0);
    const cards = repo.db.prepare(`SELECT COUNT(*) n FROM card_ledger WHERE kind='open' AND at>=?`).get(t0).n;
    return { tiles: [{ k: '排队中', v: live.filter(b => b.status === 'arrived' && b.progress === 'waiting').length }, { k: '今日办卡', v: cards }] };
  },
  seed(h) {
    const { repo, d } = h;
    repo.upsertShop({ name: '木白理发工作室', phone: '021-0000-0000', address: 'XX市XX区XX路 18 号（示例地址）', open_min: 600, close_min: 1320, step_min: 30, book_days: 7, lead_min: 30, capacity: 4 });
    const SV = [
      { name: '洗剪吹', img: 'b1_cut', descr: '含洗发、修剪造型、吹风', pr: { designer: 68, director: 128 }, dur: 45, icon: 'scissors', color: 0, hot: 1 },
      { name: '男士快剪', img: 'b2_quick', descr: '不洗，适合补剪', pr: { designer: 38, director: 68 }, dur: 30, icon: 'scissors', color: 1 },
      { name: '烫发', img: 'b3_perm', descr: '含剪发 · 时长较长（仅限预约）', pr: { designer: 298, director: 498 }, dur: 150, icon: 'sparkle', color: 2, dep: 50 },
      { name: '染发', img: 'b4_color', descr: '含洗护 · 时长较长（仅限预约）', pr: { designer: 268, director: 428 }, dur: 120, icon: 'drop', color: 3 },
      { name: '头皮护理', img: 'b5_scalp', descr: '清洁 + 头皮按摩 + 发膜', pr: { designer: 128, director: 198 }, dur: 60, icon: 'leaf', color: 4 },
    ];
    const S = SV.map((s, i) => ({ ...s, id: repo.insertService({ name: s.name, descr: s.descr, price_cents: Math.min(...Object.values(s.pr)) * 100, duration_min: s.dur, icon: s.icon, color: s.color, hot: s.hot || 0, sort: i,
      deposit_on: s.dep ? 1 : 0, deposit_cents: (s.dep || 30) * 100, images: JSON.stringify(h.img(s.img)), pricing: s.pr }) }));
    const wd = n => U.addDays(new Date(), n).getDay();
    const T = [
      { name: '陈总监', tier: 'director', av: 4, s: 600, e: 1260, off: [wd(4)], intro: '12 年经验（示例），擅长男士纹理与油头', tags: ['男士造型', '渐变推剪'], works: [4, 0, 5, 1], L: 'A' },
      { name: '阿杰', tier: 'designer', av: 0, s: 600, e: 1260, off: [wd(2)], intro: '剪发利落，适合日常通勤发型', tags: ['短发', '快剪'], works: [0, 4, 1, 2], L: 'B' },
      { name: '小雅', tier: 'designer', av: 2, s: 660, e: 1320, off: [wd(5)], intro: '擅长烫染与女士中长发', tags: ['烫发', '染发'], works: [3, 1, 2, 5], L: 'C' },
      { name: '林总监', tier: 'director', av: 1, s: 720, e: 1320, off: [wd(6)], intro: '女士长发与色彩设计（示例）', tags: ['长发设计', '色彩'], works: [2, 5, 3, 1], L: 'D' },
    ].map((t, i) => ({ ...t, id: repo.insertResource({ kind: 'stylist', name: t.name, title: TIER_NAME[t.tier], tier: t.tier, tags: JSON.stringify(t.tags), skills: '[]', start_min: t.s, end_min: t.e,
      off_days: JSON.stringify(t.off), avatar: t.av, letter: t.L, intro: t.intro, extra: JSON.stringify({ works: t.works }), sort: i, seed: 1 }) }));
    const P1 = repo.insertCardProduct({ name: '银卡', kind: 'balance', price_cents: 100000, bonus_cents: 0, discount: 850, sort: 1 });
    const P2 = repo.insertCardProduct({ name: '金卡', kind: 'balance', price_cents: 200000, bonus_cents: 0, discount: 800, sort: 2 });
    const cid = p => repo.getCustomerByPhone(p).id, ago = n => Date.now() - n * 864e5, ME = '13812345678';
    const card = (phone, name, prod, lvl, pay, disc, daysAgo) => { h.cust(phone, name);
      const id = repo.insertCard({ customer_id: cid(phone), product_id: prod, name: lvl, kind: 'balance', balance_cents: pay * 100, discount: disc, level: lvl, seed: 1, created_at: ago(daysAgo) });
      repo.addLedger({ card_id: id, customer_id: cid(phone), kind: 'open', amount_cents: pay * 100, note: lvl, actor: 'owner', seed: 1, at: ago(daysAgo) }); return id; };
    const K = { me: card(ME, '演示用户', P1, '银卡', 1000, 850, 30), liu: card('13900001111', '刘女士', P2, '金卡', 2000, 800, 1) };
    const pay = (k, phone, cents, bid, note, at) => { const c = repo.getCard(k); repo.updateCard(k, { balance_cents: c.balance_cents - cents }); if (bid) repo.updateBooking(bid, { paid_cents: cents });
      repo.addLedger({ card_id: k, customer_id: cid(phone), kind: 'pay', amount_cents: -cents, booking_id: bid || null, note, actor: bid ? null : 'staff', seed: 1, at }); };
    const nowMin = h.nowMin;
    const mk = (si, ti, date, hm, phone, name, status, o = {}) => { const s = S[si], r = T[ti], price = s.pr[r.tier], m = typeof hm === 'number' ? hm : U.toMin(hm);
      let f = { status };
      if (date === h.today && status === 'confirmed') { if (m + s.dur <= nowMin) f = { status: 'done', progress: 'done', arrived_at: U.startAt(date, m) - 5 * 60000, started_at: U.startAt(date, m) }; else if (m <= nowMin) f = { status: 'arrived', progress: 'serving', arrived_at: U.startAt(date, m) - 5 * 60000, started_at: U.startAt(date, m) }; }
      return h.bk({ svc: { id: s.id, name: s.name }, price, dur: s.dur, date, hm: m, phone, name, resource_id: r.id, extra: { tier: r.tier, tierName: TIER_NAME[r.tier], lines: [{ label: `${s.name}（${TIER_NAME[r.tier]}）`, amount: price }] }, ...o, ...f }); };
    // 过去：已完成 + 评价
    const done = [
      mk(1, 1, d(-6), '19:00', ME, '演示用户', 'done', { progress: 'done' }),
      mk(0, 0, d(-2), '11:00', '13400005555', '王先生', 'done', { progress: 'done' }),
      mk(2, 2, d(-3), '14:00', '13600003333', '周女士', 'done', { progress: 'done' }),
      mk(3, 3, d(-4), '15:00', '13900001111', '刘女士', 'done', { progress: 'done' }),
      mk(1, 1, d(-5), '12:00', '13300006666', '孙先生', 'done', { progress: 'done' }),
      mk(0, 0, d(-8), '18:00', '13500004444', '何女士', 'done', { progress: 'done' }),
    ];
    h.reviews(done, [
      [5, ['剪得满意', '准时'], '下班顺路补剪，十几分钟搞定。', null, null],
      [5, ['手艺好', '沟通到位'], '陈总监会先问清楚平时怎么打理，渐变很自然。', 'b1_cut', '谢谢认可～下次见！'],
      [5, ['手艺好', '不推销'], '小雅烫的卷很自然，全程没有推销。', 'b3_perm', null],
      [4, ['沟通到位'], '颜色和预期一致，就是染发时间比较长。', null, '染发需要等上色，下次可以带本书～'],
      [3, ['等太久'], '取号排了 40 分钟，剪得还不错。', null, '抱歉久等！高峰期建议提前预约免排队。'],
      [5, ['环境干净'], '', null, null],
    ]);
    // 今天：按当前时间生成；营业中时再放现场排队示例
    mk(4, 0, d(0), Math.min(Math.max(600, Math.floor((nowMin - 120) / 30) * 30), 1200), '13400005555', '王先生', 'confirmed');
    const a = mk(0, 3, d(0), '16:00', '13900001111', '刘女士', 'confirmed', { pay_method: 'balance', card_id: K.liu });
    pay(K.liu, '13900001111', 10240, a, '预约 洗剪吹（林总监）· 金卡 8 折', ago(0.5));
    mk(3, 2, d(0), '18:30', '13500004444', '何女士', 'confirmed');
    if (nowMin >= 660 && nowMin <= 1230) {
      const t = Date.now(), mm = x => t - x * 60000, q = (si, ti, no, prog, arr, st, phone, name) => { const s = S[si], r = T[ti];
        return h.bk({ svc: { id: s.id, name: s.name }, price: s.pr[r.tier], dur: s.dur, date: d(0), hm: Math.max(600, Math.floor(nowMin / 10) * 10), phone, name, status: 'arrived', kind: 'walk', queue_no: no, progress: prog, resource_id: r.id,
          arrived_at: mm(arr), started_at: st != null ? mm(st) : null, extra: { tier: r.tier, tierName: TIER_NAME[r.tier], lines: [{ label: `${s.name}（${TIER_NAME[r.tier]}）`, amount: s.pr[r.tier] }] } }); };
      q(0, 0, 'A001', 'serving', 30, 20, '13700002222', '张先生'); q(1, 0, 'A002', 'waiting', 12, null, '13300006666', '孙先生');
      q(1, 1, 'B001', 'serving', 15, 10, '13600007777', '吴先生'); q(0, 1, 'B002', 'waiting', 8, null, '13200001234', '郑先生'); q(1, 1, 'B003', 'waiting', 3, null, '13200005678', '冯先生');
    }
    // 未来
    const f = mk(0, 0, d(2), '11:00', ME, '演示用户', 'confirmed', { pay_method: 'balance', card_id: K.me });
    pay(K.me, ME, 10880, f, '预约 洗剪吹（陈总监）· 银卡 8.5 折', ago(1));
    pay(K.me, ME, 27120, null, '到店消费 染发（示例）', ago(20));
    mk(2, 2, d(1), '14:00', '13600003333', '周女士', 'confirmed'); mk(0, 1, d(3), '19:00', '13300006666', '孙先生', 'pending');
    // 爽约示例：郑女士 90 天内爽约 2 次
    mk(0, 1, d(-20), '11:00', '13100008888', '郑女士', 'no_show', { noshow_by: 'manual' }); mk(1, 0, d(-9), '15:00', '13100008888', '郑女士', 'no_show', { noshow_by: 'manual' });
    h.feedback('13300006666', '排队问题', '希望取号后能看到大概要等多久。', 4, true, '已上线「前面 N 人 · 预计等待」（示例）');
    h.feedback('13500004444', '发型师相关', '想看到每位发型师的作品。', 1, false);
  },
};
module.exports = IND;
