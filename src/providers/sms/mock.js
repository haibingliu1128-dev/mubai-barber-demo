'use strict';
// 开发/演示短信通道：不发真短信，只写日志并保存在内存「发件箱」，供开发者/测试查看
exports.create = ({ log }) => {
  const outbox = [];
  return {
    name: 'mock',
    async send({ phone, code, purpose }) {
      const rec = { phone, code, purpose, at: Date.now() };
      outbox.unshift(rec); outbox.length = Math.min(outbox.length, 50);
      (log || console).info({ sms: { phone, code, purpose } }, `[mock-sms] ${phone} 验证码 ${code}`);
      return { ok: true, devCode: code };
    },
    /** 服务通知（如「可接回」「候补成功」），同样只进模拟发件箱 */
    async notify({ phone, text }) {
      outbox.unshift({ phone, code: null, purpose: 'notify', text, at: Date.now() }); outbox.length = Math.min(outbox.length, 50);
      (log || console).info({ sms: { phone, purpose: 'notify' } }, `[mock-sms] ${phone} 通知：${text}`);
      return { ok: true };
    },
    outbox: () => outbox.slice(),
  };
};
