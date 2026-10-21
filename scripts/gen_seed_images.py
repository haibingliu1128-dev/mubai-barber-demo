"""木白理发工作室 · 示例服务配图（程序绘制）。用法：python scripts/gen_seed_images.py（需要 playwright + Chrome）"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from seedimg import *
OUT = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'seed-images'
SKIN, INK, GOLD = '#F2D2BC', '#1C1C1E', '#E3A72F'
def head(x, y, s, hair, hc='#2B2321'):
    return (f'<g transform="translate({x} {y}) scale({s})"><path d="M-120 260 c10 -90 60 -120 120 -120 s110 30 120 120z" fill="#3A3A3C"/><rect x="-26" y="90" width="52" height="60" fill="{SKIN}"/>'
            f'<ellipse cx="0" cy="20" rx="80" ry="95" fill="{SKIN}"/><path d="{hair}" fill="{hc}"/>'
            '<circle cx="-30" cy="26" r="7" fill="#2B2321"/><circle cx="30" cy="26" r="7" fill="#2B2321"/><path d="M-18 64 q18 12 36 0" stroke="#B5705A" stroke-width="6" fill="none" stroke-linecap="round"/></g>')
SHORT = 'M-82 0 c0 -70 40 -105 82 -105 s82 35 82 105 c-14 -30 -36 -45 -82 -45 s-68 15 -82 45z'
def scissors(x, y, s, r, c=INK):
    return (f'<g transform="translate({x} {y}) rotate({r}) scale({s})"><circle cx="-40" cy="60" r="26" fill="none" stroke="{c}" stroke-width="12"/><circle cx="40" cy="60" r="26" fill="none" stroke="{c}" stroke-width="12"/>'
            f'<path d="M-24 40 L 30 -150 L 40 -146 L -6 46Z" fill="#B8BCC4"/><path d="M24 40 L -30 -150 L -40 -146 L 6 46Z" fill="#D3D6DC"/><circle cx="0" cy="-6" r="8" fill="{GOLD}"/></g>')
def comb(x, y, s, r):
    return f'<g transform="translate({x} {y}) rotate({r}) scale({s})"><rect x="-120" y="-16" width="240" height="32" rx="8" fill="{INK}"/>' + ''.join(f'<rect x="{-112 + i * 16}" y="14" width="8" height="46" rx="3" fill="{INK}"/>' for i in range(15)) + '</g>'
def pole(x, y):
    return (f'<g transform="translate({x} {y})"><rect x="-34" y="-20" width="68" height="24" rx="8" fill="{GOLD}"/><rect x="-26" y="0" width="52" height="300" fill="#fff"/>'
            '<clipPath id="pc"><rect x="-26" y="0" width="52" height="300"/></clipPath><g clip-path="url(#pc)">' + ''.join(f'<path d="M-40 {i * 60} L 40 {i * 60 - 50} L 40 {i * 60 - 30} L -40 {i * 60 + 20}Z" fill="{"#C0392B" if i % 2 else "#2457A5"}"/>' for i in range(0, 7)) + '</g>'
            f'<rect x="-34" y="296" width="68" height="24" rx="8" fill="{GOLD}"/></g>')
IMGS = {}
IMGS['b1_cut'] = bg('#EDE7DD', '#F8F5EF', GOLD) + head(470, 330, 1.5, SHORT) + scissors(780, 400, 1.3, 30) + comb(250, 640, .9, -12) + pole(900, 130) + \
    ''.join(sparkle(x, y, s, GOLD, .6) for x, y, s in [(200, 220, 3), (700, 160, 2.2)]) + label('洗剪吹 · 示例插画')
IMGS['b2_quick'] = bg('#E6E9EE', '#F6F7F9', '#2457A5') + head(420, 330, 1.5, 'M-80 -10 c0 -60 36 -96 80 -96 s80 36 80 96 c-20 -18 -50 -26 -80 -26 s-60 8 -80 26z', '#3B3B4A') + \
    '<g transform="translate(760 360) rotate(-25)"><rect x="-55" y="-170" width="110" height="300" rx="40" fill="#1C1C1E"/><rect x="-60" y="-200" width="120" height="44" rx="8" fill="#B8BCC4"/>' + ''.join(f'<rect x="{-56 + i * 12}" y="-214" width="6" height="18" fill="#8E939C"/>' for i in range(10)) + f'<circle cx="0" cy="0" r="16" fill="{GOLD}"/></g>' + \
    '<text x="760" y="660" font-size="64" font-weight="800" fill="#2457A5" opacity=".75" font-family="sans-serif" text-anchor="middle">30 min</text>' + label('男士快剪 · 示例插画')
CURL = ''.join(f'<circle cx="{x}" cy="{y}" r="34" />' for x, y in [(-70, -30), (-40, -80), (0, -98), (40, -80), (70, -30), (-88, 30), (88, 30), (-80, 90), (80, 90)])
IMGS['b3_perm'] = bg('#F2E6E6', '#FBF6F6', '#C0392B') + f'<g fill="#5A3A26">' + f'<g transform="translate(500 330) scale(1.5)">{CURL}</g></g>' + head(500, 330, 1.5, 'M-80 -10 c0 -60 36 -96 80 -96 s80 36 80 96 c-20 -24 -50 -34 -80 -34 s-60 10 -80 34z', '#5A3A26') + \
    ''.join(f'<g transform="translate({x} {y}) rotate({r})"><rect x="-16" y="-50" width="32" height="100" rx="14" fill="{c}"/></g>' for x, y, r, c in [(820, 260, 20, '#E7A4A4'), (870, 360, -15, '#A4C2E7'), (800, 470, 35, GOLD)]) + label('烫发 · 示例插画')
IMGS['b4_color'] = bg('#EEE8F3', '#F9F7FB', '#7A2E3A') + head(420, 330, 1.5, 'M-84 40 c-6 -100 30 -146 84 -146 s92 46 84 146 c-10 -40 -20 -70 -30 -90 -30 14 -78 14 -108 0 -12 20 -22 50 -30 90z', '#7A2E3A') + \
    '<ellipse cx="780" cy="560" rx="150" ry="40" fill="#3A3A3C"/><path d="M630 560 Q 640 680 780 680 Q 920 680 930 560Z" fill="#1C1C1E"/><ellipse cx="780" cy="560" rx="130" ry="30" fill="#7A2E3A"/>' + \
    f'<g transform="translate(820 360) rotate(35)"><rect x="-12" y="-150" width="24" height="230" rx="10" fill="{INK}"/><rect x="-30" y="70" width="60" height="50" rx="6" fill="#B8BCC4"/><rect x="-30" y="116" width="60" height="40" fill="#7A2E3A"/></g>' + \
    ''.join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{c}"/>' for x, y, r, c in [(200, 600, 30, '#C68B59'), (260, 640, 24, '#7A2E3A'), (180, 660, 20, '#5A3A26')]) + label('染发 · 示例插画')
IMGS['b5_scalp'] = bg('#E7EDE5', '#F6F9F5', '#2BAE7E') + head(540, 360, 1.5, SHORT, '#3B3B4A') + \
    bubbles([(380, 180, 40), (460, 130, 30), (560, 110, 46), (660, 140, 32), (720, 200, 26), (330, 260, 22)], '#fff', .9) + \
    '<g transform="translate(860 500)"><rect x="-50" y="-120" width="100" height="200" rx="20" fill="#2BAE7E"/><rect x="-30" y="-160" width="60" height="46" rx="8" fill="#1C1C1E"/><rect x="-36" y="-40" width="72" height="70" rx="8" fill="#fff" opacity=".85"/></g>' + \
    ''.join(sparkle(x, y, s, '#2BAE7E', .5) for x, y, s in [(200, 520, 3), (240, 380, 2)]) + label('头皮护理 · 示例插画')
render(OUT, IMGS)
