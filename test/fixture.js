'use strict';
// 行业测试夹具：理发（core.test.js 通过它下单）
//   理发必须指定发型师：basic/dep 由夹具查询可约时段，选当天上班且该时段空闲的发型师（模拟顾客换人）；
//   conc：固定一位当天上班的发型师（阿杰，休息日为「今天 +2」时换陈总监），同一时段只有 1 个名额
let RES = null;
async function res(H) { if (RES) return RES; RES = (await H.api('GET', '/api/shop')).body.industry.resources.filter(r => r.kind === 'stylist'); return RES; }
const wd = date => new Date(date + 'T00:00:00').getDay();
async function pick(H, order, sid, date, time) {
  const R = await res(H);
  for (const n of order) {
    const r = R.find(x => x.name === n); if (r.offDays.includes(wd(date))) continue;
    const a = (await H.api('GET', `/api/availability?serviceId=${sid}&resourceId=${r.id}&from=${date}&days=1`)).body;
    const s = a.days && a.days[0] && a.days[0].slots.find(x => x.time === time);
    if (s && s.ok !== false && !s.why) return r.id;
  }
  return R.find(x => x.name === order[0]).id;
}
module.exports = {
  slug: 'barber', brand: '木白理发工作室', ownerPassword: 'mubai2026', staffDisplay: '前台小木（演示）',
  serviceCount: 5, restrictedPhone: '13100008888',
  svc: { basic: 1, dep: 3, review: 1 }, depAmount: 50,
  cap: 1,
  T: ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00'],   // 所有发型师班次内（林总监 12:00 起）
  overlap: t => { const [h, m] = t.split(':').map(Number), x = h * 60 + m + 30; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); },
  async body(H, tok, key, date, time) {
    const sid = key === 'dep' ? 3 : 1, b = { serviceId: sid, date, time, name: '测试' };
    if (key === 'conc') { const R = await res(H), a = R.find(x => x.name === '阿杰'); b.resourceId = a.offDays.includes(wd(date)) ? R.find(x => x.name === '陈总监').id : a.id; }
    else if (date && time) b.resourceId = await pick(H, key === 'dep' ? ['林总监', '小雅', '陈总监', '阿杰'] : ['小雅', '林总监', '陈总监', '阿杰'], sid, date, time);
    else b.resourceId = (await res(H))[0].id;
    return b;
  },
  async availCheck(H, a) {
    const day = a.days[0];
    if (day.slots.length) H.assert.ok(day.slots.every(x => x.time >= '10:00' && x.time < '22:00'));
  },
  async extraPhoneData(H, phone) {
    const r = await H.api('POST', '/api/merchant/cards', { phone, name: '打码测试', productId: 1 }, H.OWNER);
    if (r.status !== 201) throw new Error('办卡失败 ' + JSON.stringify(r.body));
  },
  phoneUrls: ['/api/merchant/cards', '/api/merchant/ledger'],
};
