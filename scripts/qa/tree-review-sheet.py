"""Lay out rendered QA captures; no generated or retouched tree imagery."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else 'screenshots/tree-instancing/review')
styles = [('faceted', 'A · Цельная гранёная'), ('clustered', 'B · Несколько объёмов'), ('asymmetric', 'C · Асимметричная')]
views = [('specimens', 'Отдельные деревья'), ('avenue', 'Уличный ряд'), ('forest', 'Плотный парк — упрощённый уровень')]
font = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 25)
small = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 22)
for full in [False, True]:
    rows = views if full else views[:1]
    sheet = Image.new('RGB', (2400, 90 + len(rows) * 510), '#1c242b')
    draw = ImageDraw.Draw(sheet)
    draw.text((24, 10), 'Деревья в рендере Isometric Minsk · одинаковые данные, камеры и свет', font=font, fill='#eeeeee')
    draw.text((24, 48), 'Синтетические посадки для визуального сравнения. Это не новые данные OSM.', font=small, fill='#b9c5ce')
    for row, (view, label) in enumerate(rows):
        for col, (style, title) in enumerate(styles):
            x, y = col * 800, 90 + row * 510
            draw.text((x + 16, y + 2), f'{title} · {label}', font=small, fill='#eeeeee')
            image = Image.open(root / f'{style}-{view}.png').convert('RGB')
            image.thumbnail((792, 446), Image.Resampling.NEAREST)
            sheet.paste(image, (x + 4, y + 43))
    sheet.save(root / ('comparison-all.png' if full else 'comparison-specimens.png'))
print(root / 'comparison-all.png')

map_root = root.parent / 'map'
if (map_root / 'legacy-gorky-trees.png').exists() and (map_root / 'asymmetric-gorky-trees.png').exists():
    sheet = Image.new('RGB', (1600, 530), '#1c242b')
    draw = ImageDraw.Draw(sheet)
    for col, (style, label) in enumerate([('legacy', 'До · объединённые пирамидальные деревья'), ('asymmetric', 'После · вариант C, инстансинг')]):
        x = col * 800
        draw.text((x + 16, 12), label, font=small, fill='#eeeeee')
        image = Image.open(map_root / f'{style}-gorky-trees.png').convert('RGB')
        image = image.resize((800, 450), Image.Resampling.NEAREST)
        sheet.paste(image, (x, 58))
    sheet.save(map_root / 'before-after-gorky.png')
    print(map_root / 'before-after-gorky.png')
