'use strict';
// 行业扩展的数据访问：服务人员/工位、排班、顾客档案（宠物/车辆）、加购项、会员卡与流水、团课与候补、现场排队
function createExtRepo(db, R, ACTIVE_SQL) {
  const q = sql => db.prepare(sql);
  const now = () => Date.now();
  const upd = (table, id, f) => { const k = Object.keys(f); if (!k.length) return; q(`UPDATE ${table} SET ${k.map(x => `${x}=@${x}`).join(',')} WHERE id=@_id`).run({ ...f, _id: id }); };
  const ins = (table, o) => { const k = Object.keys(o); return q(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(x => '@' + x).join(',')})`).run(o).lastInsertRowid; };
  const ids = a => a.map(() => '?').join(',');
  return {
    // ---- resources（技师/发型师/保洁师/老师/工位）----
    listResources: all => q(`SELECT * FROM resources ${all ? '' : 'WHERE active=1'} ORDER BY sort, id`).all(),
    getResource: id => q('SELECT * FROM resources WHERE id=?').get(id),
    insertResource: r => ins('resources', { created_at: now(), ...r }),
    updateResource: (id, f) => upd('resources', id, f),
    resourceDays: (from, to) => q('SELECT * FROM resource_days WHERE date BETWEEN ? AND ?').all(from, to),
    setResourceDay: (rid, date, off) => q('INSERT INTO resource_days (resource_id,date,off) VALUES (?,?,?) ON CONFLICT(resource_id,date) DO UPDATE SET off=excluded.off').run(rid, date, off ? 1 : 0),
    resourceBusy: (rid, date, s, e, exceptId) => q(`SELECT COUNT(*) n FROM bookings WHERE resource_id=@rid AND kind!='walk' AND class_id IS NULL AND date=@date AND start_min<@e AND end_min>@s AND id!=@x AND ${ACTIVE_SQL}`)
      .get({ rid, date, s, e, x: exceptId || 0, now: now() }).n,
    assigneeBusy: (aid, date, s, e, exceptId) => q(`SELECT COUNT(*) n FROM bookings WHERE (assignee_id=@aid OR resource_id=@aid) AND date=@date AND start_min<@e AND end_min>@s AND id!=@x AND ${ACTIVE_SQL}`)
      .get({ aid, date, s, e, x: exceptId || 0, now: now() }).n,
    resourceBookingsOn: (rid, date) => q(`SELECT COUNT(*) n FROM bookings WHERE (resource_id=@rid OR assignee_id=@rid) AND date=@date AND ${ACTIVE_SQL}`).get({ rid, date, now: now() }).n,

    // ---- profiles（宠物/车辆）----
    listProfiles: (cid, kind) => q('SELECT * FROM profiles WHERE customer_id=? AND kind=? AND deleted=0 ORDER BY id').all(cid, kind),
    getProfile: id => q('SELECT * FROM profiles WHERE id=?').get(id),
    insertProfile: p => ins('profiles', { created_at: now(), updated_at: now(), seed: 0, ...p }),
    updateProfile: (id, f) => upd('profiles', id, { ...f, updated_at: now() }),

    // ---- addons（加购项）----
    listAddons: all => q(`SELECT * FROM addons ${all ? '' : 'WHERE active=1'} ORDER BY sort, id`).all(),
    getAddon: id => q('SELECT * FROM addons WHERE id=?').get(id),
    insertAddon: a => ins('addons', a),
    updateAddon: (id, f) => upd('addons', id, f),

    // ---- cards（会员卡）----
    listCardProducts: all => q(`SELECT * FROM card_products ${all ? '' : 'WHERE active=1'} ORDER BY sort, id`).all(),
    getCardProduct: id => q('SELECT * FROM card_products WHERE id=?').get(id),
    insertCardProduct: p => ins('card_products', p),
    listCards: cid => q('SELECT * FROM cards WHERE customer_id=? ORDER BY id').all(cid),
    allCards: () => q(`SELECT k.*, c.phone, c.name AS cname FROM cards k JOIN customers c ON c.id=k.customer_id ORDER BY k.updated_at DESC LIMIT 300`).all(),
    getCard: id => q('SELECT k.*, c.phone, c.name AS cname FROM cards k JOIN customers c ON c.id=k.customer_id WHERE k.id=?').get(id),
    insertCard: c => ins('cards', { created_at: now(), updated_at: now(), seed: 0, ...c }),
    updateCard: (id, f) => upd('cards', id, { ...f, updated_at: now() }),
    addLedger: l => ins('card_ledger', { at: now(), seed: 0, times: 0, amount_cents: 0, bonus_cents: 0, booking_id: null, note: null, actor: null, ...l }),
    cardLedger: cardId => q('SELECT * FROM card_ledger WHERE card_id=? ORDER BY at DESC, id DESC LIMIT 100').all(cardId),
    customerLedger: cid => q('SELECT l.*, k.name AS card_name FROM card_ledger l JOIN cards k ON k.id=l.card_id WHERE l.customer_id=? ORDER BY l.at DESC, l.id DESC LIMIT 100').all(cid),
    ledgerByKind: (kinds, limit) => q(`SELECT l.*, k.name AS card_name, c.phone, c.name AS cname FROM card_ledger l JOIN cards k ON k.id=l.card_id JOIN customers c ON c.id=l.customer_id
      WHERE l.kind IN (${kinds.map(k => `'${k}'`).join(',')}) ORDER BY l.at DESC, l.id DESC LIMIT ?`).all(limit || 100),
    ledgerForBooking: (bid, kind) => q('SELECT * FROM card_ledger WHERE booking_id=? AND kind=? ORDER BY id DESC').all(bid, kind),
    /** 已预约但尚未核销、将使用该卡的次数（下单时防止次卡超用） */
    cardPendingUses: cardId => q(`SELECT COALESCE(SUM(seats),0) n FROM bookings WHERE card_id=@cid AND pay_method='card' AND status IN ('pending','confirmed','arrived','awaiting_payment')`).get({ cid: cardId }).n,

    // ---- classes（团课）/ waitlist（候补）----
    listClasses: (from, to) => q(`SELECT k.*, (SELECT COALESCE(SUM(seats),0) FROM bookings b WHERE b.class_id=k.id AND b.status IN ('pending','confirmed','arrived','done')) AS booked,
        (SELECT COUNT(*) FROM waitlist w WHERE w.class_id=k.id) AS waiting
      FROM classes k WHERE k.active=1 AND k.date BETWEEN ? AND ? ORDER BY k.date, k.start_min, k.id`).all(from, to),
    getClass: id => q(`SELECT k.*, (SELECT COALESCE(SUM(seats),0) FROM bookings b WHERE b.class_id=k.id AND b.status IN ('pending','confirmed','arrived','done')) AS booked FROM classes k WHERE k.id=?`).get(id),
    insertClass: c => ins('classes', { created_at: now(), seed: 0, ...c }),
    updateClass: (id, f) => upd('classes', id, f),
    classBookings: cid => q(`SELECT b.*, c.phone FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.class_id=? ORDER BY b.created_at`).all(cid),
    classCount: cid => q(`SELECT COUNT(*) n FROM bookings WHERE class_id=? AND status IN ('pending','confirmed','arrived','done','awaiting_payment')`).get(cid).n,
    teacherClassesOn: (rid, date) => q('SELECT * FROM classes WHERE resource_id=? AND date=? AND active=1').all(rid, date),
    addWait: (classId, cid, name) => q('INSERT INTO waitlist (class_id,customer_id,name,created_at) VALUES (?,?,?,?)').run(classId, cid, name || null, now()).lastInsertRowid,
    removeWait: (classId, cid) => q('DELETE FROM waitlist WHERE class_id=? AND customer_id=?').run(classId, cid).changes,
    listWait: classId => q('SELECT w.*, c.phone FROM waitlist w JOIN customers c ON c.id=w.customer_id WHERE class_id=? ORDER BY w.created_at, w.id').all(classId),
    customerWaits: cid => q('SELECT w.*, k.date, k.start_min, k.end_min, k.title, k.room, k.resource_id FROM waitlist w JOIN classes k ON k.id=w.class_id WHERE w.customer_id=? ORDER BY k.date, k.start_min').all(cid),
    myClassBooking: (classId, cid) => q(`SELECT * FROM bookings WHERE class_id=? AND customer_id=? AND status IN ('pending','confirmed','arrived','done','awaiting_payment')`).get(classId, cid),

    // ---- 现场排队（kind='walk'）----
    queueToday: date => q(`SELECT b.*, c.phone FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.date=? AND b.kind='walk' ORDER BY b.created_at, b.id`).all(date),
    nextQueueNo: (date, prefix) => {
      // 取当天同前缀的最大号 +1（预约到店领号、示例数据也占号，按数量计会撞号）
      const n = q(`SELECT queue_no FROM bookings WHERE date=? AND queue_no LIKE ?`).all(date, prefix + '%')
        .reduce((mx, r) => { const v = parseInt(r.queue_no.slice(prefix.length), 10); return Number.isFinite(v) && v > mx ? v : mx; }, 0);
      return prefix + String(n + 1).padStart(prefix.length > 1 ? 2 : 3, '0');
    },
    /** 指定日期全部仍有效的订单（看板用） */
    liveOn: date => q(`SELECT b.*, c.phone FROM bookings b JOIN customers c ON c.id=b.customer_id WHERE b.date=? AND (b.status IN ('pending','confirmed','arrived','done') OR (b.status='awaiting_payment' AND b.hold_until>@now)) ORDER BY b.start_min, b.created_at`).all(date, { now: now() }),
  };
}
module.exports = { createExtRepo };
