# Reverse-engineering: Isometric Warsaw (`warsaw-izo`) vs VoxelMinsk

Дата: 2026-11-19. Источник: собранный сайт `https://bedirhanyildirim.com/warsaw-izo/`
(без исходников; анализ минифицированных модулей, `map.json`, `.pak` и замеров в Chromium).
Цель: перенести только то, что реально работает для Минска и даёт выигрыш.
Системы, которых нет в открытых данных Минска (варшавские ливреи, Wisła, аэропорт,
погода и т.п.), не рассматриваются.

## 0. Вердикт

| Система | Warsaw IZO | VoxelMinsk сейчас | Решение |
| --- | --- | --- | --- |
| Пиксель-арт | integer 2× upscale, snap камеры, posterize только яркости, world-space edge | target 360 px, per-channel 20 levels, камера не привязана к сетке | **взять** |
| Чанки | 1000 м, far/full/over pack, preview, immutable cache | 1024 м JSON, всегда full, `no-cache` | **взять LOD и кэш** |
| Landmarks | 294 объекта, pins, карточки, wiki, fly-to, outline, вырезание far-LOD | 5 curated, picking + OSM-панель | **взять interaction** |
| Транспорт | GTFS-частотость + speed profile + dwell + пробки, instancing | расписание Минска (partial), dwell/фазы, светофоры, instancing | **оставить наше**, взять speed profile и delay-chain |
| Светофоры / авто | нет (только трамваи/поезда) | есть | **наше лучше**, не трогать |
| Детализация зданий | простая, но дешёвая | богаче (recipes, trim, roofs) | **наше лучше**, не упрощать |

Главный вывод: Warsaw быстрее **по времени до первого кадра и по ощущению движения**,
а не по суммарному трафику (см. §1). Визуально «красивее» — за счёт целочисленного
апскейла, стабильной пиксельной сетки и щадящей квантизации, а не за счёт геометрии.

## 1. Замеры (1280×720, DPR 1, cold context, cache disabled, 15 s)

| Метрика | Warsaw | Minsk | Комментарий |
| --- | --- | --- | --- |
| FCP | **124 ms** | 584 ms | у Warsaw сначала дешёвый loader/фон |
| Первый tile/pak | **369 ms** | 689 ms | до первого чанка |
| Запросов всего | 210 | 185 | |
| Байт всего | 7.13 MB | **2.62 MB** | Minsk легче суммарно |
| Данные карты | 163 `.pak` = 5.16 MB | 111 JSON = 0.95 MB | Warsaw тянет far+full+terrain+trees |
| JS | 969 KB | 682 KB | |
| Canvas | 640×360 → CSS 1280×720 (ровно ×2) | 1280×720, target 640×360 | у Minsk апскейл не целочисленный |
| Последний tile | 5.2 s | 6.6 s | |

Важно: default view разный (Warsaw — центр на 2 м/px, Minsk — обзор всего города).
Цифры показывают механику, а не абсолютную скорость: Warsaw отдаёт первый экран
крошечными far-пакетами и дорисовывает, Minsk ждёт полноценные JSON-тайлы.
Наш суммарный трафик меньше — это не проблема; проблема в TTFP и в отсутствии
прогрессивной детализации.

## 2. Пиксель-арт и рендер (что именно даёт «красивее»)

### 2.1 Разрешение и камера

* Внутренний canvas = `floor(viewport / 2)` по обеим осям; CSS-размер = ровно `×2`,
  `image-rendering: pixelated`. Никаких дробных коэффициентов.
* Ортокамера 2:1: азимут 45°, elevation `atan(0.5) ≈ 26.565°`;
  `mpp = 8 / 2^zoom`, zoom ∈ [-2, 4] (8 м/px … 0.5 м/px).
* **Ключевое:** цель камеры квантуется к мировой сетке пикселя:
  ```js
  right = (cos(az), 0, -sin(az));
  up    = cross(back, right);
  x = round(target·right / mpp) * mpp;
  y = round(target·up    / mpp) * mpp;
  // позиция камеры строится от (x, y); исходный dot(target, back) не квантуется
  ```
  Поэтому при панораме пиксели не «плывут» и не мерцают. У нас этого нет —
  добавить в `src/engine/camera/isometricCamera.ts`.
* Frustum: `left/right = ±widthPx/2 * mpp`, `top/bottom = ±heightPx/2 * mpp`,
  near 1, far ≈ `2 * max(5000, heightPx * mpp + 1500)`.

### 2.2 Постобработка (fullscreen pass, nearest color+depth)

Порядок в шейдере Warsaw:
1. **Depth-edge**: толщина ребра задаётся в метрах (`edgeMetres = 2.5`), а не в
   пикселях; сравнение глубины с учётом наклона земли, затемнение `c *= 0.45`.
2. **Posterize только яркости**: 14 уровней, в gamma-пространстве, с сохранением
   hue: `y = dot(g, vec3(.299,.587,.114)); g *= round(y*levels)/levels / y`.
   Это принципиально: per-channel квантизация (как у нас, 20 уровней) в тенях
   сдвигает оттенки и «грязнит» картинку.
3. Туман квантуется полосами по 1/16, дождь/снег — в screen space, lightning.
4. Outline выбранного landmark: отдельный depth-mask pass, 1 texel, цвет `#e4b54a`.
5. Fog/desat/weather — униформы, без второй геометрии.

Наш `PixelArtPipeline` уже делает edge/dither/quantise, но:
* квантизация per-channel; перейти на luminance-only (12–14 уровней);
* включить целочисленный апскейл: `renderHeight = round(viewportH / k)`, CSS = `renderHeight*k`;
  либо `viewport/2`, как у Warsaw (360 → 540 на 1080p);
* edge threshold оставить в метрах, но проверить `uEdgeLow/High` на всех zoom;
* добавить mask-outline для выбранного объекта (сейчас есть только building highlight).

### 2.3 Материалы

* Здания: merged mesh, атрибут `facade` (число) → окна/этажи/двери считаются в
  fragment shader из world-space `u` и `y`; ни текстур, ни per-window geometry.
  Ночью окна зажигаются hash-функцией, доля зависит от типа (`facade`).
* Крыши/стены — flat vertex color + сезонный shader (снег по нормали и высоте).
* Земля — запечённая RGBA-текстура чанка (1 px/m на full LOD), Nearest, без mipmap;
  дороги/разметка/парки нарисованы в OffscreenCanvas, затем 4×4 Bayer + hash-шум.
* Деревья — InstancedMesh: 16 клеток 250×250 м на чанк для near-каста, один mesh
  на чанк для far; стволы только при `mpp <= 1`; масштаб крон от `mpp`; качество
  (доля инстансов) адаптивное.

## 3. Чанки, формат и загрузка

### 3.1 Мир

* `map.json`: origin lat/lon, chunk = 1000 м, grid 30×31, bounds, 659 чанков,
  197 846 зданий, 1 929 941 дерево. Манифест preload’ится в HTML.
* Данные версионированы путём `data/<hash>/` → `Cache-Control: immutable, 1 year`.
  У нас `cache: 'no-cache'` на каждом тайле — лишние conditional requests и задержка.

### 3.2 LOD-тиры (по `mpp`, не по расстоянию)

| mpp | файл | res | деревья | minArea (draw range) |
| --- | --- | --- | --- | --- |
| ≤ 2 | `.f.pak` (full) | 1 м | да | 0 |
| ≤ 4 | `.f.pak` | 2 м | нет | 0 |
| ≤ 8 | `.n.pak` (far) | 4 м | нет | 80 м² |
| ≤ 16 | `.o.pak` (over) | 8 м | нет | 300 м² |
| > 16 | `.o.pak` | 8 м | нет | 1000 м² |

`res` — не отдельный файл: один и тот же pack пересобирается в worker’е с другой
квантизацией/фильтрацией. Байты пака кэшируются (`packCache = 32`), поэтому
пересборка LOD не требует повторной сети.

### 3.3 Pack (`IZP1`) — готовый формат для reverse-engineering

```
u32 magic 'IZP1' (0x31505A49)
u32 headerLen
JSON header { parts: [{n, t, o, l, ...}] }
binary parts
```
Типы частей:
* `pj` — сжатый JSON: массивы чисел кодируются varint zigzag по столбцам,
  ссылки `"@0"` подставляют массив; так лежат позиции/нормали/цвета.
* `h16` — heightmap с дельтами и zigzag (501² или 126²).
* `i16d` — delta-по-колонкам (позиции far-LOD).
* `u16` — varint-массив индексов.
* `bits` — bitmap (1000×1000 маска занятости).
* `raw` — деревья.
Пак может отдаваться Brotli/gzip; код проверяет magic и при необходимости
распаковывает `DecompressionStream('brotli')`, затем gzip fallback.

Размеры: full pack ≈ 0.5–0.9 MB, far ≈ 50–150 KB, over ≈ 130 KB. Всё, что нужно
для первого экрана, — far-пакеты; full догружается в фоне.

### 3.4 Очередь и worker’ы

* Worker pool: 2–4 (desktop), каждый worker держит до 2 задач.
* Скачивание: 6 одновременных (в profile desktop до 12), приоритет — расстояние
  до цели + 5000, если чанк не виден; уже загруженные сортируются первыми.
* Для видимого чанка без контента: сначала `.n.pak` как preview (приоритет −2500),
  одновременно `.f.pak` (приоритет +2500). После preview чанк уже рисуется.
* `inflight cap = workers*2 + downloads`; LRU-кэш байтов 32 пака; dispose чанка
  за пределами `radius = max(margin + halfDiag, ...)`.
* Worker возвращает transferable typed arrays: ground RGBA, опционально ground mesh,
  buildings (position/normal/color/facade + `farVertices`, `ids`, `starts`),
  trees (16 cells: offset/count/tall/minY/maxY + общие matrices/colors),
  bridges, lod2, stops и т.д.
* `farVertices[minArea]` — граница draw range: мелкие дома лежат в хвосте буфера и
  просто не рисуются на дальнем LOD. Это дешевле отдельной геометрии.
* Terrain store: 2 м и 8 м heightmap Uint16 (0.1 м), offset `78 - datum`;
  3×3 соседей для бесшовности; LRU 48 fine-карт; билинейный `heightAt`.

### 3.5 Рендер-цикл

* Рендер on-demand: `requestAnimationFrame` коалессится флагом; ambient-тикер
  15 fps (10 на mobile) для воды/флагов.
* Тени: один directional light, BasicShadowMap 4096 (2048 mobile), цель тени
  квантуется к текселю; при GPU-кадре > 22 ms mapSize делится на 2, деревья
  режутся до 0.6.
* Системы грузятся лениво по zoom: landmarks всегда, trains ≥ 1, trams/boats/
  animals ≥ 2. Динамические import’ы, гейт проверяется каждый кадр.

## 4. Landmarks

* `landmarks.json` (2.95 MB): 294 объекта + 15 569 footprint’ов зданий, которые
  надо скрыть/вырезать. Сами модели — процедурные builder’ы в bundle
  (`landmark-adapter`, ~883 KB), не glTF.
* После сборки все статические меши каждого landmark **мержатся** по материалу,
  shadow-флагам и набору атрибутов в один-несколько BufferGeometry
  (`toNonIndexed`, лишние атрибуты удаляются, winding исправляется при
  отрицательном determinant). `userData.dynamic` и анимированные узлы не мержатся.
* Посадка на рельеф: bbox center → `heightAtAsync` → `group.position.y += ground`;
  затем то же для animated-узлов.
* Скрытие города: по OSM id здания обнуляются вершины в chunk mesh
  (`geometry.position.fill(0, starts[id], starts[id+1])`); для far-LOD
  треугольники внутри rings вырождаются (positions → 0). Это позволяет не
  перегенерировать тайлы.
* Pins: DOM-слой, SVG 9×11 (×2 = 18×22 CSS px), `image-rendering: pixelated`.
  Позиция — проекция `(bbox center, maxY)`; ниже zoom 2 показываются только
  `major` (высота ≥ 40 м или footprint ≥ 180 м). Максимум 80 pins; кластеризация:
  сортировка по y, объединение пересекающихся, раскладка по x с шагом `pinW+2`.
* Клик: pointerdown/up ≤ 5 px и ≤ 600 ms; сначала pin (радиус 20 px), иначе
  raycast по landmark-мешам (broad-phase по bbox). Hover — задержка 66 ms.
* Карточка: title/kind/desc/facts/link; ссылка — official → Wikipedia → Wikidata;
  `?info=<slug>` для deep-link. Fly-to: `centreOn` + glide 350 ms, карточка
  ставится сбоку, камера подгоняется под bbox + карточку. Outline — через
  depth-mask (см. §2.2).

Для Минска это переносимо: список landmarks, OSM id, Wikipedia/Wikidata есть.
Наши 5 curated-зданий можно оставить как геометрию, а interaction-слой сделать общим.

## 5. Общественный транспорт

### 5.1 Данные

* `trams-city.json` (344 KB): пути — delta-кодированные lon/lat (1e-7°), `h` (дм),
  `z` (дм, эстакада), `t` (тоннель); маршруты со списком остановок, `lines[ref]`
  с headway по дням (`wd/sa/su`) и составом парка.
* `trains-city.json` (1.13 MB): рёбра, станции, **реальные trip-таблицы** GTFS
  (PKP PLK/KM/WKD), patterns, составы, скорости; грузовые — синтетика.
* `stations-city.json` (273 KB): станции, платформы, координаты.

### 5.2 Модель движения

* Остановки проецируются на polyline; скорость ограничена кривизной:
  `v = min(vmax, sqrt(a_lat / curvature))`, затем forward/backward pass по
  ускорению/торможению; у остановок скорость 0 и dwell 20 s (+12 s каждой 3-й).
* Для трамваев расписание не поминутное: первый рейс `3:00 + hash*10 мин`,
  далее по headway из таблицы; это deterministic-функция `(route, date)`.
  Для поездов — реальные trip’ы, dwell из GTFS.
* Позиция рейса = `speedProfile(tau)`; окно рейсов `[now - duration - 150 s, now]`.
* Пробки/обгоны: look-ahead точки на 40–120 м; пересечение с телом впереди идущего
  даёт `blocked`, задержка хранится в Map (до 600/900 s) и затухает; при старте
  история симулируется назад на 600 s шагом 3 s (трамваи) / 5 s (поезда).
* Отрисовка: InstancedMesh по типам вагонов/секций, посадка на путь по сегменту,
  `iFront` атрибут для фар/флагов/выделения, `frustumCulled = false` + ручная
  проекция; масштаб составов зависит от zoom (`[1,1,1.9,1.2,1]`), ниже zoom 2
  трамваи не рисуются, ниже zoom 1 — поезда.
* Picking: экранное расстояние до проекции polyline (3 точки), half-width в px;
  карточка рейса с остановкой/ETA, follow-режим камеры.

Наш транспорт по возможностям не хуже (есть светофоры, dwell, phases, расписание
Минска). Стоит взять: speed profile от кривизны, delay/blocking chain, компактные
trip-таблицы и zoom-gating целиком (а не по одному объекту).

## 6. Что не копировать

* Процедурные модели 294 варшавских landmarks и ливреи — нет данных/смысла для Минска.
* Wisła/river-stage, аэропорт, погода, сезоны, самолёты, лодки — вне нашего scope.
* Их упрощённые фасады: наши recipes/trim/roofs визуально сильнее; менять не нужно.
* Полный отказ от `no-cache`: у нас данные обновляются по тому же URL, поэтому
  нужен hashed data dir (`data/<hash>/`) и immutable cache, а не просто снятие revalidate.

## 7. План внедрения (по приоритету)

**P0 — пиксель-арт, малый риск, максимум визуального эффекта**
1. `src/engine/camera/isometricCamera.ts`: квантовать target к `mpp`-сетке (см. §2.1).
2. `src/engine/createCityApp.ts` + `pixelArtPipeline.ts`: целочисленный апскейл
   (render = viewport/2, CSS = render*2; clamp 360–720) вместо фиксированных 360.
3. `pixelArtPipeline.ts`: luminance-only posterize 12–14 уровней; edge threshold
   в метрах; добавить mask-outline выбранного объекта/landmark.

**P1 — стриминг**
4. Генерировать для каждого тайла `far`-вариант (упрощённые здания, без деревьев,
   coarse ground) или строить preview в worker’е; грузить его первым.
5. Кэшировать распарсенный payload/байты в worker’е, чтобы ground LOD не
   перекачивал JSON; `packCache`-аналог.
6. Перейти на `data/<hash>/` + `Cache-Control: immutable`; manifest preload.
7. Бюджет: старт 48–64 тайла, затем idle top-up; full-detail только при `mpp ≤ 2`.

**P2 — landmarks**
8. Реестр landmark’ов (name, coords, radius, OSM ids, wiki/wikidata) + DOM pins
   с кластеризацией; карточка, deep-link, fly-to, outline.
9. Скрывать исходные здания по OSM id (в merged mesh) и вырезать far-LOD
   треугольники в rings — без перегенерации тайлов.

**P3 — транспорт**
10. Оставить наши светофоры/расписание; добавить speed profile от кривизны,
    dwell и delay-chain; сжать trip-данные (delta/varint) — 59 MB mobility-city
    при 344 маршрутах избыточны.

## 8. Артефакты и ссылки

* Сайт: `https://bedirhanyildirim.com/warsaw-izo/`
* Манифест: `data/3e8d6ff0be/map.json` (preload), `landmarks.json`,
  `trams-city.json`, `trains-city.json`, `stations-city.json`
* Чанки: `data/3e8d6ff0be/c/<i>_<j>.{f,n,o}.pak`, terrain `t2/`/`t8/`
* Код (минифицирован): `assets/index-*.js`, `assets/chunk-worker-*.js`,
  `assets/trams-*.js`, `assets/trains-*.js`, `assets/landmark-adapter-*.js`,
  `assets/landmark-info-*.js`
* Замеры: холодный контекст Chromium, viewport 1280×720, DPR1, cache disabled,
  окно 15 s (2026-11-19). Скрипты замеров не коммитились — только результаты.
