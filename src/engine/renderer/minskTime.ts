/**
 * Local clock time for Minsk.
 *
 * Minsk stays on UTC+3 all year round (no DST since 2011), so local hours are
 * pure arithmetic — no `Intl` formatting needed. The lighting rig uses this to
 * run the day/night cycle on the real city clock (see createCityApp tick).
 *
 * Kept pure: callers may pass any instant, tests pin concrete dates.
 */

import { PILOT_TIME_ZONE_HOURS } from './solarPosition';

/** Local Minsk clock hours (0..24, fractional) for a moment in time. */
export function minskLocalHours(date: Date = new Date()): number {
  const hours = (date.getTime() / 3_600_000 + PILOT_TIME_ZONE_HOURS) % 24;
  return hours < 0 ? hours + 24 : hours;
}
