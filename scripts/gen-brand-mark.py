from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.misc.transform import Transform
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
font = TTFont(ROOT / 'src' / 'app' / 'fonts' / 'QiantuHouHei.ttf')
glyph_set = font.getGlyphSet()
cmap = font.getBestCmap()
glyf = font['glyf']

chars = ['能', '元']
bounds = {}
for ch in chars:
    name = cmap[ord(ch)]
    g = glyf[name]
    bounds[ch] = {
        'name': name,
        'xMin': g.xMin,
        'yMin': g.yMin,
        'xMax': g.xMax,
        'yMax': g.yMax,
        'w': g.xMax - g.xMin,
        'h': g.yMax - g.yMin,
    }

# Normalize both glyphs to the same ink height, top-aligned, packed tightly.
target_h = max(bounds[ch]['h'] for ch in chars)
gap = 40  # optical gap between characters after normalization
pad_y = 20
pad_x = 10
# 元 顶横视觉偏轻，略下移以平衡「能」的视觉重心
optical_dy = {'能': 0, '元': 45}

placements = []
cursor_x = pad_x
for ch in chars:
    b = bounds[ch]
    scale = target_h / b['h']
    scaled_w = b['w'] * scale
    tx = cursor_x - b['xMin'] * scale
    ty = b['yMax'] * scale + pad_y + optical_dy[ch]
    placements.append((ch, b['name'], scale, tx, ty, scaled_w))
    cursor_x += scaled_w + gap

view_w = cursor_x - gap + pad_x
view_h = target_h + pad_y * 2 + max(optical_dy.values())

paths = []
for ch, name, scale, tx, ty, _ in placements:
    pen = SVGPathPen(glyph_set)
    tpen = TransformPen(pen, Transform(scale, 0, 0, -scale, tx, ty))
    glyph_set[name].draw(tpen)
    d = pen.getCommands()
    # Round long floats for cleaner JSX
    import re

    def round_num(m):
        return f'{float(m.group(0)):.2f}'.rstrip('0').rstrip('.')

    d = re.sub(r'-?\d+\.\d+', round_num, d)
    paths.append(d)
    print(ch, 'scale', round(scale, 5))

svg = (
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {view_w:.2f} {view_h:.2f}" '
    f'fill="currentColor" role="img" aria-label="能元">\n'
    f'  <path d="{paths[0]}"/>\n'
    f'  <path d="{paths[1]}"/>\n'
    f'</svg>\n'
)

out_svg = ROOT / 'src' / 'components' / 'brand-mark.svg'
out_svg.write_text(svg, encoding='utf-8')

tsx = f'''import type {{ SVGProps }} from 'react';

/** 千图厚黑「能元」字标：两字归一到等高墨迹框并紧排，避免字体度量错位 */
export function BrandMark({{ className, ...props }}: SVGProps<SVGSVGElement>) {{
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 {view_w:.2f} {view_h:.2f}"
      fill="currentColor"
      role="img"
      aria-label="能元"
      className={{className}}
      {{...props}}
    >
      <path d="{paths[0]}" />
      <path d="{paths[1]}" />
    </svg>
  );
}}
'''

out_tsx = ROOT / 'src' / 'components' / 'brand-mark.tsx'
out_tsx.write_text(tsx, encoding='utf-8')
print('viewBox', f'0 0 {view_w:.2f} {view_h:.2f}')
print('wrote', out_svg)
print('wrote', out_tsx)
