"""端到端测试（木白理发工作室）：顾客手机 + 商家后台两个独立浏览器上下文操作同一后端。
用法：先用临时数据库起服务（夜间请用 FAKE_HM=14:00 node -r ./test/clock.js src/server.js），再 BASE=http://localhost:3201 python test/e2e.py ；SHOTS=目录 时顺便保存截图"""
import os, re, random
from playwright.sync_api import sync_playwright, expect
BASE = os.environ.get('BASE', 'http://localhost:3201')
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
SHOTS = os.environ.get('SHOTS')
PHONE = '177' + ''.join(random.choice('0123456789') for _ in range(8))
MPHONE = '176' + ''.join(random.choice('0123456789') for _ in range(8))
ok = lambda m: print('ok  ', m, flush=True)
def shot(pg, name, full=False):
    if SHOTS: os.makedirs(SHOTS, exist_ok=True); pg.wait_for_timeout(400); pg.evaluate("document.querySelectorAll('.toast').forEach(e=>e.remove())"); pg.screenshot(path=os.path.join(SHOTS, name + '.png'), full_page=full)
def confirm(pg):
    pg.wait_for_timeout(150)
    if pg.locator('.dlg [data-d="1"]').count(): pg.click('.dlg [data-d="1"]')

with sync_playwright() as p:
    br = p.chromium.launch(executable_path=CHROME)
    c = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
    m = br.new_context(viewport={'width': 430, 'height': 900}, device_scale_factor=2).new_page()
    errs = []
    for pg in (c, m): pg.on('pageerror', lambda e: errs.append(str(e)))

    m.goto(BASE + '/#merchant'); m.fill('#m-user', 'owner'); m.fill('#m-pass', 'wrong'); m.click('[data-a=mLogin]')
    expect(m.locator('.toast')).to_contain_text('用户名或密码错误')
    m.fill('#m-pass', 'mubai2026'); m.click('[data-a=mLogin]')
    expect(m.locator('.mhead')).to_contain_text('木白理发工作室'); ok('商家登录')
    expect(m.locator('.stats')).to_contain_text('排队中'); expect(m.locator('.stats')).to_contain_text('今日办卡')
    expect(m.locator('.wb')).to_have_count(4); ok('师傅工作台：4 位发型师')
    shot(m, 'merchant_dashboard')

    # 顾客首页：按发型师排队、作品墙
    c.goto(BASE + '/'); c.wait_for_selector('.tabbar')
    expect(c.locator('.hero')).to_contain_text('木白理发工作室')
    expect(c.locator('.qcard .qrow')).to_have_count(4); expect(c.locator('.qcard')).to_contain_text('前面'); ok('首页：按发型师的实时排队')
    expect(c.locator('.svc .thumb.img img').first).to_be_visible(); expect(c.locator('.works > div')).to_have_count(6); ok('首页：服务配图 + 作品集')
    shot(c, 'customer_home')
    c.evaluate("document.querySelector('.svc').scrollIntoView({block:'start'})"); shot(c, 'customer_home_services')

    # 登录
    c.click('.tab:has-text("我的")'); c.locator('[data-a=login]').first.click()
    c.fill('#lg-phone', PHONE); c.click('[data-a=lgNext]'); c.click('[data-a=sms]')
    code = c.locator('#ab-demo-code').inner_text(timeout=5000).strip(); assert re.fullmatch(r'\d{6}', code)
    c.fill('#ab-code', code); c.click('[data-a=smsVerify]'); ok('短信验证码登录（演示显示验证码）')
    expect(c.locator('.vipc')).to_contain_text('未办卡')

    # 现场取号：阿杰 → 只能选短项目 → 前面人数 / 预计等待
    c.click('.tab:has-text("首页")'); c.click('.qrow:has-text("阿杰") [data-a=qTake]')
    expect(c.locator('.svc')).to_have_count(3); expect(c.locator('.notice')).to_contain_text('长时项目'); ok('取号只显示短项目（烫染需预约）')
    c.click('.svc[data-v="2"]'); c.click('.foot .btn')
    expect(c.locator('.sty.on')).to_contain_text('阿杰'); expect(c.locator('.sty.on')).to_contain_text('38'); ok('选发型师：设计师价 ¥38')
    shot(c, 'customer_booking_stylist')
    c.click('.foot .btn'); c.wait_for_selector('.qticket')
    expect(c.locator('.qticket')).to_contain_text('预计等待'); ok('排队页：前面人数 + 预计等待')
    shot(c, 'customer_queue')
    c.click('.foot .btn')
    if c.locator('#f-name').input_value() == '': c.fill('#f-name', 'E2E')
    c.click('.foot .btn'); c.wait_for_selector('.ticket')
    expect(c.locator('.ticket')).to_contain_text('现场排队'); expect(c.locator('.ticket')).to_contain_text('阿杰')
    c.click('.foot .btn[data-a=submit]'); c.wait_for_selector('.succ')
    qno = re.search(r'B\d{3}', c.locator('.succ').inner_text()).group(0); ok('取号成功 ' + qno)
    c.goto(BASE + '/'); expect(c.locator('.qticket.mine')).to_contain_text(qno); ok('首页显示我的号码')
    c.evaluate("document.querySelector('.qticket.mine').scrollIntoView({block:'center'})"); shot(c, 'customer_home_live')

    # 商家：工作台实时出现 → 完成当前 → 叫号
    wb = m.locator('.wb:has-text("阿杰")')
    expect(wb).to_contain_text(qno, timeout=8000); ok('工作台实时出现新取号（SSE）')
    m.evaluate("document.querySelector('.wb').scrollIntoView({block:'start'})"); shot(m, 'merchant_workbench')
    if wb.locator('[data-a=mOp]:has-text("完成")').count():
        wb.locator('[data-a=mOp]:has-text("完成")').click(); confirm(m); expect(m.locator('.toast')).to_be_visible(); m.wait_for_timeout(500)
    wb.locator('[data-a=mOp]:has-text("叫号")').click(); confirm(m)
    expect(wb.locator('.cur')).to_contain_text('服务中', timeout=5000); ok('叫号：开始服务')

    # 办会员卡：给顾客办银卡 + 给新顾客办卡
    m.click('[data-a=mIssue]'); m.fill('#mc-name', 'E2E'); m.fill('#mc-phone', PHONE); m.click('[data-a=mcSave]')
    expect(m.locator('.toast')).to_contain_text('已办卡：银卡，余额 ¥1000'); ok('前台办银卡')
    m.click('[data-a=mIssue]'); m.fill('#mc-name', '测试女士'); m.fill('#mc-phone', MPHONE); m.locator('#mc-prods button').nth(1).click(); m.click('[data-a=mcSave]')
    expect(m.locator('.toast')).to_contain_text('金卡'); ok('前台办金卡')

    # 顾客：发型师详情（作品 / 价目 / 会员价 / 评价）→ 预约陈总监 → 会员卡 8.5 折支付
    c.click('.tab:has-text("我的")'); expect(c.locator('.vipc')).to_contain_text('银卡'); expect(c.locator('.vipc .bal')).to_contain_text('1000')
    c.click('.tab:has-text("发型师")'); expect(c.locator('.sty')).to_have_count(4)
    c.click('.sty:has-text("陈总监")'); expect(c.locator('.works > div')).to_have_count(4); expect(c.locator('.rvitem').first).to_be_visible()
    expect(c.locator('.mp').first).to_contain_text('卡'); ok('发型师详情：作品、两级价目、会员价、评价')
    shot(c, 'customer_stylist_detail')
    c.click('[data-a=bookSty]'); expect(c.locator('.tierbar')).to_contain_text('陈总监')
    expect(c.locator('.svc')).to_have_count(5); shot(c, 'customer_booking_service')
    c.click('.svc[data-v="1"]'); c.click('.foot .btn'); expect(c.locator('.sty.on')).to_contain_text('128')
    c.click('.foot .btn'); c.wait_for_selector('.date')
    c.locator('.date:not(.off)').nth(1).click(); c.locator('.slot:not([disabled])').first.click()
    shot(c, 'customer_booking_time')
    c.click('.foot .btn')
    if c.locator('#f-name').input_value() == '': c.fill('#f-name', 'E2E')
    c.click('.foot .btn'); c.wait_for_selector('.ticket')
    expect(c.locator('.ticket')).to_contain_text('陈总监')
    c.click('[data-a=payPick][data-v^="balance"]'); expect(c.locator('.foot')).to_contain_text('108.8'); ok('确认页：会员卡 8.5 折 ¥108.8')
    shot(c, 'customer_booking_confirm')
    c.click('.foot .btn[data-a=submit]'); c.wait_for_selector('.succ h2'); ok('提交：' + c.locator('.succ h2').inner_text())
    c.goto(BASE + '/?r=2'); c.click('.tab:has-text("我的")'); expect(c.locator('.vipc .bal')).to_contain_text('891.2'); ok('余额按折扣扣款')

    # 商家：会员卡页
    m.click('[data-a=mTab][data-v=cards]'); m.wait_for_selector('.card.mrow')
    expect(m.locator(f'.card.mrow:has-text("{MPHONE[-4:]}")')).to_contain_text('2000'); ok('会员卡列表')
    shot(m, 'merchant_cards')

    # 店员：工作台可操作、会员手机号打码
    s = br.new_context(viewport={'width': 430, 'height': 900}).new_page(); s.on('pageerror', lambda e: errs.append(str(e)))
    s.goto(BASE + '/#merchant'); s.fill('#m-user', 'staff'); s.fill('#m-pass', 'staff2026'); s.click('[data-a=mLogin]')
    expect(s.locator('.mhead')).to_contain_text('前台小木'); expect(s.locator('.wb')).to_have_count(4)
    s.click('[data-a=mTab][data-v=cards]'); s.wait_for_selector('.card.mrow')
    expect(s.locator(f'.card.mrow:has-text("{MPHONE[-4:]}")')).to_contain_text(MPHONE[:3] + '****'); ok('店员：会员手机号打码')
    assert not errs, errs
    ok('无前端报错')
    br.close()
print('E2E PASS')
