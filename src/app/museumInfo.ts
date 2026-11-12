/**
 * Museum exhibit card content (Russian).
 *
 * Keyed by the baked model slug (`placement.json`), because two exhibits of the
 * same type share the model and the reference text; the card title uses the
 * per-exhibit `ref` (board number / name) from the placement payload.
 *
 * Links point at the Belarusian aviation diary ("Белорусский авиадневник",
 * aircraft-museum.ucoz.ru): the Minsk museum section and a site search for the
 * exhibit, which is the closest thing to a per-exhibit pointer the site offers.
 */

const MUSEUM_PAGE = 'http://aircraft-museum.ucoz.ru/index/minskij_aviamuzej/0-206';
const MUSEUM_SEARCH = 'https://aircraft-museum.ucoz.ru/search/?q=';

export interface MuseumInfo {
  title: string;
  years: string;
  description: string;
  /** Site search term for this exhibit. */
  query: string;
}

export const MUSEUM_INFO: Record<string, MuseumInfo> = {
  'mi-1': {
    title: 'Ми-1М',
    years: '1948–1965',
    description:
      'Первый советский серийный вертолёт ОКБ Миля. Ми-1М — модернизированная версия с более мощным двигателем АИ-26В.',
    query: 'Ми-1',
  },
  'mi-2': {
    title: 'Ми-2',
    years: 'с 1965',
    description:
      'Лёгкий многоцелевой вертолёт польского производства (WSK Świdnik). Долгие годы — основной учебный и связной вертолёт ДОСААФ.',
    query: 'Ми-2',
  },
  'mi-8': {
    title: 'Ми-8Т',
    years: 'с 1965',
    description:
      'Самый массовый вертолёт в истории авиации. Транспортная модификация Ми-8Т перевозит до 24 пассажиров или 4 т груза.',
    query: 'Ми-8',
  },
  'mi-24': {
    title: 'Ми-24П',
    years: 'с 1975',
    description:
      'Ударный вертолёт с пушечной установкой ГШ-30К. «Крокодил» — самый узнаваемый боевой вертолёт советской школы.',
    query: 'Ми-24',
  },
  'mi-26': {
    title: 'Ми-26',
    years: 'с 1980',
    description:
      'Самый тяжёлый серийный вертолёт в мире: 20 т полезной нагрузки и 32-метровый винт. Экспонат борта 07.',
    query: 'Ми-26',
  },
  'an-2': {
    title: 'Ан-2Т',
    years: 'с 1947',
    description:
      'Лёгкий биплан ОКБ Антонова, «кукурузник». Транспортная модификация Ан-2Т использовалась для авиахимработ и десантирования.',
    query: 'Ан-2',
  },
  'an-26': {
    title: 'Ан-26ЛЛ',
    years: 'с 1969',
    description:
      'Военно-транспортный турбовинтовой самолёт с грузовой рампой. Экспонат — летающая лаборатория Ан-26ЛЛ.',
    query: 'Ан-26',
  },
  'il-18': {
    title: 'Ил-18В',
    years: 'с 1958',
    description:
      'Четырёхмоторный турбовинтовой лайнер ОКБ Ильюшина. Борт СССР-75781 — один из первых советских пассажирских «дальников».',
    query: 'Ил-18',
  },
  'tu-134': {
    title: 'Ту-134А',
    years: 'с 1967',
    description:
      'Ближнемагистральный лайнер с двигателями на хвостовой части и Т-образным оперением. Борт СССР-65038.',
    query: 'Ту-134',
  },
  'yak-18': {
    title: 'Як-18',
    years: 'с 1946',
    description:
      'Учебно-тренировочный самолёт ОКБ Яковлева с рядным двигателем. Готовил лётчиков ДОСААФ два десятилетия.',
    query: 'Як-18',
  },
  'yak-28': {
    title: 'Як-28ПП',
    years: 'с 1962',
    description:
      'Самолёт радиоэлектронной борьбы на базе сверхзвукового Як-28. Борт 14 с двумя двигателями Р-11.',
    query: 'Як-28',
  },
  'yak-40': {
    title: 'Як-40',
    years: 'с 1968',
    description:
      'Первый в мире серийный реактивный самолёт для местных авиалиний. В экспозиции два борта: СССР-87308 и EW-88187.',
    query: 'Як-40',
  },
  'l-29': {
    title: 'Л-29 «Дельфин»',
    years: 'с 1963',
    description:
      'Чехословацкий реактивный учебно-тренировочный самолёт, основная «парта» лётчиков стран Варшавского договора.',
    query: 'Л-29',
  },
  'mig-15': {
    title: 'МиГ-15УТИ',
    years: 'с 1949',
    description:
      'Спарка на базе МиГ-15 — первого массового реактивного истребителя. Борт 18.',
    query: 'МиГ-15',
  },
  'mig-17': {
    title: 'МиГ-17',
    years: 'с 1952',
    description:
      'Развитие МиГ-15 с крылом большей стреловидности. Борт 28 — участник пары с МиГ-19П.',
    query: 'МиГ-17',
  },
  'mig-19': {
    title: 'МиГ-19П',
    years: 'с 1955',
    description:
      'Первый советский серийный сверхзвуковой истребитель, перехватчик с ракетами класса «воздух-воздух». Борт 11.',
    query: 'МиГ-19',
  },
  'mig-21': {
    title: 'МиГ-21СМТ',
    years: 'с 1971',
    description:
      'Самый массовый сверхзвуковой истребитель в мире. Модификация СМТ несла увеличенный запас топлива. Борт 53.',
    query: 'МиГ-21',
  },
  'mig-23': {
    title: 'МиГ-23УБ',
    years: 'с 1970',
    description:
      'Двухместный учебно-боевой истребитель с крылом изменяемой геометрии. В экспозиции борта [88] и [71].',
    query: 'МиГ-23',
  },
  'mig-25': {
    title: 'МиГ-25ПУ / МиГ-25БМ',
    years: 'с 1970-х',
    description:
      'Высотный перехватчик ОКБ Микояна. В музее два борта: учебный МиГ-25ПУ [20] и разведывательно-ударный МиГ-25БМ [78].',
    query: 'МиГ-25',
  },
  'mig-27': {
    title: 'МиГ-27К',
    years: 'с 1976',
    description:
      'Истребитель-бомбардировщик с крылом изменяемой геометрии и оптико-электронной прицельной системой «Кайра». Борта [05] и [17].',
    query: 'МиГ-27',
  },
  'mig-29': {
    title: 'МиГ-29',
    years: 'с 1983',
    description:
      'Фронтовой истребитель поколения 4. В экспозиции одноместный МиГ-29 (9-13) [29] и спарка МиГ-29УБ [65].',
    query: 'МиГ-29',
  },
  'su-17': {
    title: 'Су-17М',
    years: 'с 1972',
    description:
      'Истребитель-бомбардировщик с крылом изменяемой геометрии. Борт 35.',
    query: 'Су-17',
  },
  'su-24': {
    title: 'Су-24М',
    years: 'с 1977',
    description:
      'Фронтовой бомбардировщик с крылом изменяемой геометрии и прицельным комплексом «Тигр». Борта [25] и [26].',
    query: 'Су-24',
  },
  'su-25': {
    title: 'Су-25',
    years: 'с 1981',
    description:
      'Штурмовик «Грач», бронированная машина поля боя. Борт 51.',
    query: 'Су-25',
  },
  'citation-x': {
    title: 'Cessna 750 Citation X',
    years: 'с 1996',
    description:
      'Реактивный бизнес-джет, один из самых быстрых гражданских самолётов. Борт EW-15257.',
    query: 'Citation',
  },
};

export const MUSEUM_SITE_PAGE = MUSEUM_PAGE;

/** Site-search link that points the museum site at this exhibit. */
export function museumExhibitUrl(slug: string, fallback: string): string {
  const query = MUSEUM_INFO[slug]?.query ?? fallback;
  return MUSEUM_SEARCH + encodeURIComponent(query);
}
