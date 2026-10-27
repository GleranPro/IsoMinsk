/**
 * Solar position math for the isometric renderer.
 *
 * The sun/moon direction is not scripted: it is derived from the real date and
 * the pilot location (Minsk) so that the light direction (and therefore the
 * shadow direction) is plausible for the season. The simplified NOAA solar
 * position algorithm is accurate to well under a degree, which is far more than
 * an isometric scene needs.
 *
 * Everything here is pure math: no THREE, no DOM.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Minsk is UTC+3 all year round (no DST since 2011). */
export const PILOT_TIME_ZONE_HOURS = 3;

/** Minutes per day. */
const MINUTES_PER_DAY = 24 * 60;

export interface SolarPosition {
  /** Degrees above the horizon; negative at night. */
  elevation: number;
  /** Solar azimuth measured clockwise from north, radians in [0, 2π). */
  azimuth: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Day of the year (1 = 1 January) for the local civil date of `date`. */
export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86_400_000) + 1;
}

/**
 * Solar elevation + azimuth for a local civil clock hour.
 *
 * @param hours          Local clock time in hours (0..24, may be fractional).
 * @param latitudeDeg    Observer latitude in degrees.
 * @param longitudeDeg   Observer longitude in degrees (east positive).
 * @param date           Calendar date; defaults to the current date.
 * @param timeZoneHours  Offset of the local clock from UTC in hours.
 */
export function solarPosition(
  hours: number,
  latitudeDeg: number,
  longitudeDeg: number,
  date: Date = new Date(),
  timeZoneHours: number = PILOT_TIME_ZONE_HOURS,
): SolarPosition {
  // Fractional year in radians, from the (approximate) UTC time. Equation of
  // time only needs the time of day, not the exact minute, so this is enough.
  const doy = dayOfYear(date);
  const utcHours = hours - timeZoneHours;
  const fractionalYear = ((2 * Math.PI) / 365.24) * (doy - 1 + (utcHours - 12) / 24);

  // Equation of time in minutes.
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(fractionalYear) -
      0.032077 * Math.sin(fractionalYear) -
      0.014615 * Math.cos(2 * fractionalYear) -
      0.040849 * Math.sin(2 * fractionalYear));

  // Solar declination in radians.
  const declination =
    0.006918 -
    0.399912 * Math.cos(fractionalYear) +
    0.070257 * Math.sin(fractionalYear) -
    0.006758 * Math.cos(2 * fractionalYear) +
    0.000907 * Math.sin(2 * fractionalYear) -
    0.002697 * Math.cos(3 * fractionalYear) +
    0.00148 * Math.sin(3 * fractionalYear);

  // Convert local clock time to apparent solar time (minutes), then to the
  // hour angle. Longitude correction uses the standard "solar noon offset".
  const clockMinutes = (((hours % 24) + 24) % 24) * 60;
  const solarMinutes =
    clockMinutes + equationOfTime + 4 * (longitudeDeg - 15 * timeZoneHours);
  const hourAngle = (solarMinutes / MINUTES_PER_DAY) * 2 * Math.PI - Math.PI;

  const lat = latitudeDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinDecl = Math.sin(declination);
  const cosDecl = Math.cos(declination);
  const cosZenith = clamp(
    sinLat * sinDecl + cosLat * cosDecl * Math.cos(hourAngle),
    -1,
    1,
  );
  const zenith = Math.acos(cosZenith);
  const elevation = (Math.PI / 2 - zenith) * RAD;

  // Azimuth measured clockwise from north. The acos form is unambiguous only
  // with the hour-angle sign fix (afternoon -> west).
  const sinZenith = Math.sin(zenith);
  let azimuthFromNorth = 0;
  if (sinZenith > 1e-6 && Math.cos(lat) > 1e-6) {
    const cosAzimuth = clamp(
      (sinDecl - sinLat * cosZenith) / (cosLat * sinZenith),
      -1,
      1,
    );
    const acosAzimuth = Math.acos(cosAzimuth);
    const afternoon = Math.sin(hourAngle) > 0;
    azimuthFromNorth = afternoon ? 2 * Math.PI - acosAzimuth : acosAzimuth;
  }
  if (azimuthFromNorth < 0) azimuthFromNorth += 2 * Math.PI;

  return { elevation, azimuth: azimuthFromNorth };
}

/**
 * World-space unit vector pointing *towards* the sun.
 *
 * Renderer convention: +X east, +Y up, +Z south (-Z north). Azimuth is measured
 * clockwise from north, so north is (0, 0, -1) and east is (1, 0, 0).
 */
export function sunDirectionFromAngles(
  azimuthFromNorth: number,
  elevationDeg: number,
): [number, number, number] {
  const elevation = elevationDeg * DEG;
  const cosElevation = Math.cos(elevation);
  return [
    Math.sin(azimuthFromNorth) * cosElevation,
    Math.sin(elevation),
    -Math.cos(azimuthFromNorth) * cosElevation,
  ];
}

/** Sun rise/set clock hours for the given date/location (for debug tooling). */
export function solarDaylightWindow(
  latitudeDeg: number,
  longitudeDeg: number,
  date: Date = new Date(),
): { sunrise: number; sunset: number } {
  // Scan once per 5 minutes: cheap, monotonic enough and avoids extra trig.
  let sunrise = 6;
  let sunset = 18;
  let previousElevation = solarPosition(0, latitudeDeg, longitudeDeg, date).elevation;
  for (let minute = 5; minute <= MINUTES_PER_DAY; minute += 5) {
    const elevation = solarPosition(
      (minute % MINUTES_PER_DAY) / 60,
      latitudeDeg,
      longitudeDeg,
      date,
    ).elevation;
    if (previousElevation <= 0 && elevation > 0) sunrise = minute / 60;
    if (previousElevation > 0 && elevation <= 0) sunset = minute / 60;
    previousElevation = elevation;
  }
  return { sunrise, sunset };
}
