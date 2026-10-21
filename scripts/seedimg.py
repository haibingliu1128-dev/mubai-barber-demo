"""示例配图公共绘制工具：纯 SVG 程序绘制 → Chrome 截图为 JPEG（1080×810）。不含下载素材或真人照片。"""
import os, pathlib, math
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')

def sparkle(x, y, s, c='#fff', o=.9):
    return f'<path transform="translate({x} {y}) scale({s})" d="M0-10 2.6-2.6 10 0 2.6 2.6 0 10-2.6 2.6-10 0-2.6-2.6z" fill="{c}" opacity="{o}"/>'

def bg(c1, c2, accent):
    return (f'<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient></defs>'
            f'<rect width="1080" height="810" fill="url(#bg)"/><circle cx="930" cy="120" r="210" fill="#fff" opacity=".35"/><circle cx="110" cy="720" r="170" fill="#fff" opacity=".3"/>'
            f'<circle cx="980" cy="700" r="60" fill="{accent}" opacity=".12"/><circle cx="160" cy="140" r="34" fill="{accent}" opacity=".15"/>')

def label(t):
    return f'<g transform="translate(40 742)"><rect width="{len(t)*26+36}" height="44" rx="22" fill="#fff" opacity=".85"/><text x="18" y="30" font-size="24" fill="#5B6270" font-family="Noto Sans CJK SC, sans-serif">{t}</text></g>'

def bubbles(pts, c='#fff', o=.75):
    return ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c}" opacity="{o}"/><circle cx="{x-r*.35:.0f}" cy="{y-r*.35:.0f}" r="{r*.22:.0f}" fill="#fff" opacity=".9"/>' for x, y, r in pts)

def g(inner, x=0, y=0, s=1, rot=0):
    return f'<g transform="translate({x} {y}) rotate({rot}) scale({s})">{inner}</g>'

def render(out_dir, imgs):
    from playwright.sync_api import sync_playwright
    out = pathlib.Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME)
        pg = b.new_page(viewport={'width': 1080, 'height': 810})
        for name, body in imgs.items():
            pg.set_content(f'<html><body style="margin:0"><svg xmlns="http://www.w3.org/2000/svg" width="1080" height="810" viewBox="0 0 1080 810">{body}</svg></body></html>')
            pg.screenshot(path=str(out / f'{name}.jpg'), type='jpeg', quality=82)
            print(name, (out / f'{name}.jpg').stat().st_size)
        b.close()
