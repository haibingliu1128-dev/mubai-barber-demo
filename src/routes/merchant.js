'use strict';
// 商家端 API（商家令牌；店主 owner / 员工 staff）
const { AppError } = require('../lib/util');
const { seed } = require('../seed');
module.exports = async function (app) {
  const { auth, booking, merchant, bus, cfg, repo, ext } = app.ctx;
  const IND = require('../industry');
  const tok = req => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.token || null;
  app.decorateRequest('user', null);
  app.addHook('preHandler', async req => {
    if (req.routeOptions.url === '/api/merchant/login') return;
    const u = auth.resolve(tok(req), 'merchant');
    if (!u) throw new AppError(401, 'NEED_LOGIN', '请先登录商家后台');
    req.user = u;
  });
  app.post('/login', async req => { const b = req.body || {}; return auth.merchantLogin(b.username, b.password, req.ip); });
  app.post('/logout', async req => { auth.logout(tok(req)); return { ok: true }; });
  app.get('/me', async req => ({ id: req.user.id, username: req.user.username, role: req.user.role, name: req.user.display_name, perms: require('../services/perms').effective(req.user) }));
  // 店员权限（仅店主）
  app.get('/staff', async req => app.ctx.perms.list(req.user));
  app.post('/staff', async (req, reply) => { const r = await app.ctx.perms.create(req.user, req.body || {}, req.ip); reply.code(201); return r; });
  app.put('/staff/:id', async req => app.ctx.perms.update(req.user, req.params.id, req.body || {}, req.ip));
  app.get('/dashboard', async req => ({ ...merchant.dashboard(), inbox: app.ctx.reviews.counts(), industry: IND.dashboard ? IND.dashboard(app.ctx, req.user) : null }));
  app.get('/bookings', async req => merchant.bookings(req.query.scope || 'today', req.query.date, req.user));
  for (const op of ['accept', 'reject', 'arrive', 'done', 'noshow', 'cancel', 'next'])
    app.post(`/bookings/:id/${op}`, async req => booking.merchantAction(req.user, req.params.id, op, { ip: req.ip }));
  // ---------- 行业扩展 ----------
  app.post('/bookings/:id/assign', async req => ext.assign(req.user, req.params.id, (req.body || {}).assigneeId, req.ip));
  app.get('/resources', async req => ext.merchantResources(req.user, req.query.date));
  app.put('/resources/:id', async req => ext.updateResource(req.user, req.params.id, req.body || {}, req.ip));
  app.put('/resources/:id/day', async req => ext.setResourceDay(req.user, req.params.id, req.body || {}, req.ip));
  app.get('/queue', async req => { const b = ext.queueBoard(req.user); if (!b) throw new AppError(404, 'NOT_FOUND', '未开启现场排队'); return b; });
  app.get('/cards', async req => ext.merchantCards(req.user, req.query.q));
  app.get('/cards/:id', async req => ext.merchantCard(req.user, req.params.id));
  app.post('/cards', async (req, reply) => { const r = ext.merchantIssue(req.user, req.body || {}, req.ip); reply.code(201); return r; });
  app.post('/cards/:id/use', async req => ext.manualUse(req.user, req.params.id, req.body || {}, req.ip));
  app.get('/ledger', async req => ext.ledger(req.user, req.query.kinds ? String(req.query.kinds).split(',') : null));
  app.get('/classes', async req => ext.merchantClasses(req.user, req.query.date));
  app.get('/classes/:id', async req => ext.roster(req.user, req.params.id));
  app.post('/classes', async (req, reply) => { const r = ext.addClass(req.user, req.body || {}, req.ip); reply.code(201); return r; });
  app.delete('/classes/:id', async req => ext.deleteClass(req.user, req.params.id, req.ip));
  app.post('/addons', async (req, reply) => { const r = ext.saveAddon(req.user, null, req.body || {}, req.ip); reply.code(201); return r; });
  app.put('/addons/:id', async req => ext.saveAddon(req.user, req.params.id, req.body || {}, req.ip));
  app.delete('/addons/:id', async req => ext.deleteAddon(req.user, req.params.id, req.ip));
  app.get('/addons', async () => repo.listAddons().map(a => ({ id: a.id, name: a.name, price: a.price_cents / 100, duration: a.duration_min, meta: JSON.parse(a.meta || '{}') })));
  app.get('/board', async req => { const d = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : require('../lib/util').today(); return repo.liveOn(d).map(b => booking.dto(b, { merchant: true, user: req.user })); });
  if (IND.routes && IND.routes.merchant) IND.routes.merchant(app, app.ctx);
  app.get('/noshows', async req => merchant.noShows(req.user));
  app.get('/customers', async req => merchant.customers(req.query.q, req.user));
  app.post('/customers/blacklist', async req => merchant.setBlacklist(req.user, req.body || {}, req.ip));   // {customerId|phone, on, reason}
  app.post('/customers/:key/clear', async req => merchant.clearRestriction(req.user, req.params.key, req.ip));   // key = 顾客 ID 或手机号
  app.get('/settings', async () => merchant.getSettings());
  app.put('/settings', async req => merchant.updateSettings(req.user, req.body || {}, req.ip));
  app.post('/settings/reset', async req => merchant.resetSettings(req.user, req.ip));
  app.get('/services', async () => repo.listServices().map(s => booking.svcDto(s, booking.settings())));
  app.post('/services', async req => merchant.saveService(req.user, null, req.body || {}, req.ip));
  app.put('/services/:id', async req => merchant.saveService(req.user, req.params.id, req.body || {}, req.ip));
  app.delete('/services/:id', async req => merchant.deleteService(req.user, req.params.id, req.ip));
  // 上传图片（店主）：请求体为压缩后的图片二进制，返回 {id,url}；保存服务时把 id 放进 images 数组
  app.post('/images', async (req, reply) => {
    require('../services/perms').need(req.user, 'service.manage');
    const r = app.ctx.images.save(req.body, { type: 'merchant', id: req.user.id });
    repo.audit({ actor_type: 'merchant', actor_id: req.user.id, actor_name: req.user.username, action: 'image.upload', target: 'image:' + r.id, detail: { bytes: r.bytes, mime: r.mime }, ip: req.ip });
    reply.code(201); return r;
  });
  // 评价管理 / 意见反馈 / 门店信息
  app.get('/reviews', async req => app.ctx.reviews.merchantReviews(req.user, req.query.filter));
  const doReply = async req => app.ctx.reviews.reply(req.user, req.params.id, (req.body || {}).text, req.ip);
  app.post('/reviews/:id/reply', doReply); app.put('/reviews/:id/reply', doReply);
  for (const op of ['hide', 'unhide', 'approve']) app.post(`/reviews/:id/${op}`, async req => app.ctx.reviews.setVisibility(req.user, req.params.id, op, req.ip));
  app.get('/feedback', async req => app.ctx.reviews.merchantFeedback(req.user, req.query.status));
  app.put('/feedback/:id', async req => app.ctx.reviews.updateFeedback(req.user, req.params.id, req.body || {}, req.ip));
  app.get('/inbox', async () => app.ctx.reviews.counts());
  app.put('/shop', async req => app.ctx.reviews.updateShop(req.user, req.body || {}, req.ip));
  app.get('/audit', async req => merchant.auditLog(req.user));
  app.post('/demo-reset', async req => {
    if (!cfg.demoMode) throw new AppError(404, 'NOT_FOUND', 'not found');
    if (req.user.role !== 'owner') throw new AppError(403, 'OWNER_ONLY', '仅店主可重置');
    await seed(repo, auth, { force: true, images: app.ctx.images });
    repo.audit({ actor_type: 'merchant', actor_id: req.user.id, actor_name: req.user.username, action: 'demo.reset', ip: req.ip });
    bus.emit('change', { type: 'reset' });
    return { ok: true };
  });
  // 实时推送（SSE）：有新预约/状态变化时通知商家端刷新。EventSource 无法带 Header，令牌走 ?token=
  app.get('/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const send = e => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
    const hb = setInterval(() => res.write(': ping\n\n'), 20000);
    bus.on('change', send);
    req.raw.on('close', () => { clearInterval(hb); bus.off('change', send); });
  });
};
