# Контракт данных мобильности

Дата: 16 ноября 2026. Ветка: `codex/public-transport-signals`.

Источник истины по схеме — [`src/shared/mobility.ts`](../../src/shared/mobility.ts). Этот файл описывает
только поток данных и границы ответственности; при расхождении побеждает TypeScript-контракт.

## Координаты и время

- Геометрия — локальные метры UTM 35N минус `originUtm` из tile-manifest (тот же origin, что у тайлов).
  `[localX, localY, height]` → `[worldX, height, -localY]`; используйте `mobilityLocalToWorld()`.
- Полилинии — плоские `p = [x,y,h, …]` плюс `s` (накопленная длина). Горизонтальная длина; высота — профиль.
- Время расписания — целые секунды от начала **дня обслуживания** в часовом поясе источника
  (`Europe/Minsk`). Времена после полуночи продолжают счёт (> 86400) и не заворачиваются.
- Даты — ISO `YYYY-MM-DD` в часовом поясе расписания, не браузера.

## Конвейер

```
data/raw/Minsk.osm.pbf ──extract_network.py──► data/processed/mobility/network_raw.json
                                                   │
                                   build_network.py ┘
                                                   ▼
                       data/processed/mobility/network.json  +  report.json
                                                   │
 публичное расписание ──import_schedule.py──► data/processed/mobility/schedule.json
                                                   │
                                              export.py
                                                   ▼
                       public/data/mobility/{manifest.json, chunks/*.json, routes/*.json}
                                                   │
                                    MobilityLayer (браузер, по области камеры)
                                                   ▼
                           src/mobility/* (часы, рейсы, сигналы, движение)
```

`data/processed/mobility/*` — вне сайта, промежуточные файлы с отчётами. `public/data/mobility/*` —
только проверенные runtime-данные версии `MOBILITY_VERSION` и provenance.

## Промежуточный формат расписания (`schedule.json`)

Пишет `import_schedule.py`, читает `export.py`. Все координаты — уже в локальных метрах.

```jsonc
{
  "source": { "source": "…", "url": "…", "retrievedAt": "…", "licence": "…", "note": "…" },
  "generatedAt": "2026-11-16T00:00:00Z",
  "timeZone": "Europe/Minsk",
  "calendars": [ /* MobilityServiceCalendar[] */ ],
  "routes": [
    {
      "mode": "bus", "ref": "100", "direction": 0, "headSign": "…",
      "stops": [
        { "seq": 0, "name": "…", "x": 0.0, "y": 0.0, "sourceId": "…", "timed": true }
      ],
      "trips": [
        {
          "sourceTripId": "…", "calendarId": "cal:…", "complete": true,
          "stopTimes": [ { "seq": 0, "arrivalS": 20040, "departureS": 20040 } ]
        }
      ]
    }
  ],
  "warnings": [ "…" ]
}
```

`routes[].stops[].seq` — порядок следования в расписании; `build_network.py`/`export.py` сопоставляют его
с остановками геометрии и создают `MobilityStopCall`. Несопоставленные остановки/рейсы не выбрасываются
молча: они попадают в `warnings` и в отчёт покрытия.

## Статус расписания в релизе

`manifest.scheduleStatus` честно описывает, что это за времена:

| Значение | Смысл | Публикуется |
|---|---|---|
| `ready` | все рейсы и времена из лицензированного публичного источника | да |
| `partial` | источник неполный, ограничения описаны в `scheduleNote` | да, с ограничениями |
| `synthetic` | **демонстрационное** расписание (модельные интервалы), не данные перевозчика | только с `export.py --allow-synthetic-timetable` |
| `unavailable` | расписание не получено (нет разрешения на переиспользование) | нет: маршруты без рейсов |
| `absent` | файла расписания нет | нет |

Публичный источник минского расписания сейчас недоступен по условиям переиспользования
([SOURCES.md](SOURCES.md)), поэтому в релизе стоит `synthetic`: движение проверяется на модели, а не на
расписании Минсктранса. UI обязан это показывать; за готовый общественный транспорт «по расписанию» такая
выгрузка не принимается.

## Приёмка данных

- `scripts/qa/mobility-audit.py` — независимая проверка всего payload (версии, байты, инварианты,
  конфликты фаз, календари, детерминизм; пишет `data/processed/mobility/audit.json`).
- `tests/unit/mobility/payload.test.ts` — те же инварианты со стороны TypeScript-контракта на реальных
  файлах; при отсутствии payload тест явно пропускается, а не подменяется фикстурой.


## Границы ответственности

| Область | Владелец | Файлы |
|---|---|---|
| Извлечение сети, сборка трасс, привязка остановок, экспорт | network | `scripts/mobility/extract_network.py`, `build_network.py`, `export.py`, `scripts/mobility/tests/test_network*.py`, `docs/mobility/ROUTES.md`, `data/processed/mobility/network*`, `public/data/mobility/**` |
| Публичное расписание | scheduler | `scripts/mobility/import_schedule.py`, `scripts/mobility/tests/test_schedule*.py`, `data/raw/mobility/**`, `data/processed/mobility/schedule.json`, `docs/mobility/SOURCES.md` |
| Чистая логика времени/рейсов/сигналов/движения | simlogic | `src/mobility/**`, `tests/unit/mobility/**` |
| Загрузчик, сцена, UI, QA, приёмка | lead | `src/engine/mobility/**`, `src/city/mobility/**`, `src/shared/appApi.ts`, `src/app/**`, `src/engine/createCityApp.ts`, `scripts/qa/mobility-*`, `docs/mobility/REVIEW.md` |

Общие файлы (`src/shared/mobility.ts`, `src/shared/types.ts`, `src/shared/config.ts`) меняет только lead
по согласованию: если контракта не хватает — сообщите, не правьте молча.

## Инварианты, которые проверяются автоматически

- `edge[i].to === edge[i+1].from` для каждого перехода внутри варианта маршрута.
- Каждый `MobilityStopCall` лежит на одном из `edges` варианта; `s` в пределах длины полосы.
- Мост/туннель/уровень не соединяются по близости XY (`layer`, `bridge`, `tunnel` сохраняются).
- `MobilityTrip.stopTimes` не убывают по `arrivalS`/`departureS`, `seq` совпадает с порядком остановок.
- Если на промежуточной остановке `arrivalS === departureS` (в выгрузке есть только отправление),
  симулятор добавляет модельную стоянку `stopCalls[i].dwellS` **до** отправления. Время отправления
  не сдвигается, задержка не накапливается; начальная и конечная остановки не меняются.
- `release` (network/schedule/bindings) один и тот же у manifest, chunks и routes; иначе loader отказывается.
- Календари и времена не зависят от часового пояса браузера.
