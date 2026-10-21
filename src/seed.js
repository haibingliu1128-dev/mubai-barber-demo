'use strict';
// 演示数据（全部虚构，seed=1，页面显示「示例」标签；顾客姓名为「X 先生/女士」式示例称呼，手机号为虚构号码并打码展示）
// 具体门店、服务、人员、示例订单由行业模块 src/industry/index.js 的 seed(h) 提供
const fs = require('fs'), path = require('path');
const U = require('./lib/util');
const IND = require('./industry');
const IMG_DIR = path.join(__dirname, '..', 'assets', 'seed-images');   // 示例插画（scripts/gen_seed_images.py 生成）
const A = IND.accounts || {};
const ACCOUNTS = [
  { username: 'owner', password: process.env.DEMO_OWNER_PASSWORD || A.owner, role: 'owner', display_name: '店主（演示）' },
  { username: 'staff', password: process.env.DEMO_STAFF_PASSWORD || 'staff2026', role: 'staff', display_name: A.staff || '店员（演示）' },
  { username: 'staff2', password: process.env.DEMO_STAFF2_PASSWORD || 'staff2026', role: 'staff', display_name: A.staff2 || '前台小林（演示）' },
];
async function ensureAccounts(repo, auth) {
  for (const a of ACCOUNTS) if (!repo.getMerchantByUsername(a.username)) {
    repo.insertMerchant({ ...a, password_hash: await auth.hashPassword(a.password) });
    // 新店员显式写入默认权限（处理预约开，其余关）
    if (a.role === 'staff') repo.updateMerchant(repo.getMerchantByUsername(a.username).id, { perms: JSON.stringify(require('./services/perms').DEFAULTS) });
  }
}
function seedImage(images, name) {
  if (!images || !name) return [];
  const f = path.join(IMG_DIR, name + '.jpg');
  if (!fs.existsSync(f)) return [];
  return [images.save(fs.readFileSync(f), null, { seed: true }).id];
}
function helpers(repo, images) {
  const now = new Date();
  let k = 0;
  const h = {
    repo, images, U, now,
    d: n => U.ymd(U.addDays(now, n)),
    today: U.today(),
    nowMin: now.getHours() * 60 + now.getMinutes(),
    img: name => seedImage(images, name),
    cust: (phone, name, verified = true) => { const c = repo.ensureCustomer(phone, name); if (verified) repo.updateCustomer(c.id, { verified_at: Date.now() }); return c.id; },
    /** 示例订单：o = { svc:{id,name,price,dur}, date, hm, phone, name, status, ...其它 bookings 字段 } */
    bk: o => {
      const m = typeof o.hm === 'number' ? o.hm : U.toMin(o.hm), dur = o.dur || o.svc.dur, e = o.end != null ? o.end : m + dur;
      const { svc, hm, phone, dur: _d, end: _e, price, ...rest } = o;
      return repo.insertBooking({ code: (IND.codePrefix || 'QY') + 'DEMO' + String(++k).padStart(2, '0'), customer_id: h.cust(phone, o.name), service_id: svc.id, service_name: svc.name,
        price_cents: Math.round((price != null ? price : svc.price) * 100), duration_min: e - m,
        start_min: m, end_min: e, start_at: U.startAt(o.date, m), end_at: U.startAt(o.date, e), note: '', seed: 1,
        created_at: U.startAt(o.date, m) - 3 * 864e5, ...rest, date: o.date, name: o.name, status: o.status });
    },
    /** 示例评价：list = [[stars, tags, text, img|null, reply|null], ...]，按订单顺序对应 */
    reviews: (bookingIds, list) => bookingIds.forEach((bid, i) => {
      const r = list[i]; if (!r) return;
      const b = repo.getBooking(bid), at = b.end_at + 3 * 3600e3;
      repo.insertReview({ booking_id: bid, customer_id: b.customer_id, service_id: b.service_id, stars: r[0], tags: JSON.stringify(r[1]), text: r[2],
        photos: JSON.stringify(seedImage(images, r[3])), status: 'public', seed: 1, alert_seen: 1, created_at: at,
        reply_text: r[4], reply_at: r[4] ? at + 5 * 3600e3 : null, reply_by: r[4] ? '店主（演示）' : null });
    }),
    feedback: (phone, type, text, daysAgo, done, note) => {
      const c = repo.getCustomerByPhone(phone);
      const id = repo.insertFeedback({ customer_id: c.id, type, text, photos: '[]', contact: done ? 'none' : 'sms', seed: 1, created_at: Date.now() - daysAgo * 864e5 });
      repo.updateFeedback(id, done ? { status: 'done', note: note || '已处理（示例）', seen: 1 } : { seen: 1 });
    },
  };
  return h;
}
async function seed(repo, auth, { force, images } = {}) {
  await ensureAccounts(repo, auth);
  if (repo.getShop() && !force) return false;
  repo.tx(() => { if (force) repo.wipeBusinessData(); IND.seed(helpers(repo, images)); });
  return true;
}
module.exports = { seed, ACCOUNTS };
