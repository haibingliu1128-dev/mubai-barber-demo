'use strict';
// 测试工具（仅 e2e 截图使用）：FAKE_HM=14:00 时把服务端进程时钟平移到「今天 14:00」，保证夜间也能演示现场取号。
// 用法：FAKE_HM=14:00 node -r ./test/clock.js src/server.js
const hm = process.env.FAKE_HM;
if (hm && /^\d{2}:\d{2}$/.test(hm)) {
  const R = Date, [h, m] = hm.split(':').map(Number), d = new R(); d.setHours(h, m, 0, 0);
  const off = d.getTime() - R.now();
  class FakeDate extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); } static now() { return R.now() + off; } }
  global.Date = FakeDate;
}
