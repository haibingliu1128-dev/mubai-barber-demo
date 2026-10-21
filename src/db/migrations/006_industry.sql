-- 006 行业通用扩展（宠物/洗车/养生/理发/瑜伽/家政共用）：
--   resources 服务人员/工位（技师、发型师、保洁师、老师、洗车工位）及排班
--   profiles  顾客档案（宠物、车辆）
--   card_products / cards / card_ledger 次卡、储值卡、年卡、课时包 及流水
--   classes / waitlist  团课（容量、候补）
--   bookings 新增：类型（预约/排队/团课）、指派人员、档案快照、进度、支付方式、排队号
ALTER TABLE bookings ADD COLUMN kind TEXT NOT NULL DEFAULT 'book';     -- book 预约时段 / walk 现场排队 / class 团课
ALTER TABLE bookings ADD COLUMN resource_id INTEGER;                   -- 指派的技师/发型师/保洁师/工位/老师
ALTER TABLE bookings ADD COLUMN class_id INTEGER;                      -- 团课
ALTER TABLE bookings ADD COLUMN assignee_id INTEGER;                   -- 派单/分配（保洁师、洗车工位、美容师），不锁定时段
ALTER TABLE bookings ADD COLUMN seats INTEGER NOT NULL DEFAULT 1;      -- 团课占用名额
ALTER TABLE bookings ADD COLUMN profile_id INTEGER;                    -- 宠物/车辆档案
ALTER TABLE bookings ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';      -- 下单快照：档案、加购、面积、楼层、地址、计价明细…
ALTER TABLE bookings ADD COLUMN progress TEXT;                         -- 行业进度（如 洗护中 / 待验收）
ALTER TABLE bookings ADD COLUMN pay_method TEXT NOT NULL DEFAULT 'store'; -- store 到店付 / balance 储值余额 / card 次卡·课时
ALTER TABLE bookings ADD COLUMN card_id INTEGER;
ALTER TABLE bookings ADD COLUMN paid_cents INTEGER NOT NULL DEFAULT 0; -- 已从储值余额扣除的金额（取消时退回）
ALTER TABLE bookings ADD COLUMN queue_no TEXT;
ALTER TABLE bookings ADD COLUMN started_at INTEGER;
ALTER TABLE bookings ADD COLUMN address TEXT;
CREATE INDEX ix_bookings_res ON bookings(resource_id, date);
CREATE INDEX ix_bookings_class ON bookings(class_id, status);

ALTER TABLE services ADD COLUMN pricing TEXT NOT NULL DEFAULT '{}';   -- 行业计价：按体型/车型/级别/单位
ALTER TABLE services ADD COLUMN kind TEXT NOT NULL DEFAULT 'book';    -- 行业自定义分类

CREATE TABLE resources (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, title TEXT, tier TEXT,
  intro TEXT DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', skills TEXT NOT NULL DEFAULT '[]', -- skills: 可做的服务 ID
  start_min INTEGER NOT NULL DEFAULT 600, end_min INTEGER NOT NULL DEFAULT 1260,
  off_days TEXT NOT NULL DEFAULT '[]',    -- 每周固定休息（0=周日）
  color TEXT, avatar INTEGER NOT NULL DEFAULT 0, letter TEXT, extra TEXT NOT NULL DEFAULT '{}',
  sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, seed INTEGER NOT NULL DEFAULT 0, created_at INTEGER
);
CREATE TABLE resource_days (resource_id INTEGER NOT NULL, date TEXT NOT NULL, off INTEGER NOT NULL, PRIMARY KEY (resource_id, date));

CREATE TABLE profiles (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}', deleted INTEGER NOT NULL DEFAULT 0, seed INTEGER NOT NULL DEFAULT 0, created_at INTEGER, updated_at INTEGER
);
CREATE INDEX ix_profiles_c ON profiles(customer_id, kind);

CREATE TABLE addons (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL, duration_min INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE card_products (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('count','balance','period')),   -- 次卡/课时包 · 储值卡 · 年卡（期限内不限次）
  scope TEXT NOT NULL DEFAULT 'all',          -- 适用范围（如 group 团课 / private 私教 / 服务 ID）
  service_id INTEGER, price_cents INTEGER NOT NULL DEFAULT 0, times INTEGER NOT NULL DEFAULT 0,
  bonus_cents INTEGER NOT NULL DEFAULT 0, discount INTEGER NOT NULL DEFAULT 1000, -- 折扣（千分比，850=8.5 折）
  days INTEGER NOT NULL DEFAULT 0, self_service INTEGER NOT NULL DEFAULT 0,       -- 顾客可在线（模拟）充值
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE cards (
  id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), product_id INTEGER,
  name TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'all', service_id INTEGER,
  total INTEGER NOT NULL DEFAULT 0, remain INTEGER NOT NULL DEFAULT 0, balance_cents INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 1000, level TEXT, expires TEXT,   -- expires: YYYY-MM-DD（含当天）
  seed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (remain >= 0 AND balance_cents >= 0)
);
CREATE INDEX ix_cards_c ON cards(customer_id);
CREATE TABLE card_ledger (
  id INTEGER PRIMARY KEY, card_id INTEGER NOT NULL, customer_id INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- open 开卡 / recharge 充值 / pay 支付 / use 核销 / refund 退回 / manual 手动核销
  times INTEGER NOT NULL DEFAULT 0, amount_cents INTEGER NOT NULL DEFAULT 0, bonus_cents INTEGER NOT NULL DEFAULT 0,
  booking_id INTEGER, note TEXT, actor TEXT, seed INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
);
CREATE INDEX ix_ledger_card ON card_ledger(card_id, at);
CREATE INDEX ix_ledger_at ON card_ledger(at);

CREATE TABLE classes (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
  service_id INTEGER, title TEXT NOT NULL, level TEXT, resource_id INTEGER, room TEXT, color INTEGER NOT NULL DEFAULT 0,
  cap INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, seed INTEGER NOT NULL DEFAULT 0, created_at INTEGER
);
CREATE INDEX ix_classes_date ON classes(date, start_min);
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL, customer_id INTEGER NOT NULL, name TEXT,
  seed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE (class_id, customer_id)
);

-- 数据库层兜底防超卖（替换 001 的触发器）：
--   团课：名额合计不超过 classes.cap；指定人员/工位：同一人员时段不重叠；其它：同时段不超过 shop.capacity。现场排队（walk）不占时段。
DROP TRIGGER trg_bookings_no_overlap;
CREATE TRIGGER trg_bookings_no_overlap BEFORE INSERT ON bookings
WHEN NEW.status IN ('awaiting_payment','pending','confirmed','arrived') AND NEW.kind != 'walk' AND (
  (NEW.class_id IS NOT NULL AND
    (SELECT COALESCE(SUM(b.seats),0) FROM bookings b WHERE b.class_id = NEW.class_id AND b.status IN ('pending','confirmed','arrived','done')) + NEW.seats
      > (SELECT cap FROM classes WHERE id = NEW.class_id))
  OR (NEW.class_id IS NULL AND NEW.resource_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.resource_id = NEW.resource_id AND b.kind != 'walk' AND b.class_id IS NULL AND b.date = NEW.date
      AND b.start_min < NEW.end_min AND b.end_min > NEW.start_min
      AND (b.status IN ('pending','confirmed','arrived') OR (b.status = 'awaiting_payment' AND b.hold_until > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)))))
  OR (NEW.class_id IS NULL AND NEW.resource_id IS NULL AND
    (SELECT COUNT(*) FROM bookings b WHERE b.date = NEW.date AND b.kind != 'walk' AND b.class_id IS NULL AND b.resource_id IS NULL
      AND b.start_min < NEW.end_min AND b.end_min > NEW.start_min
      AND (b.status IN ('pending','confirmed','arrived') OR (b.status = 'awaiting_payment' AND b.hold_until > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))))
     >= (SELECT capacity FROM shop WHERE id = 1))
)
BEGIN SELECT RAISE(ABORT, 'SLOT_TAKEN'); END;
