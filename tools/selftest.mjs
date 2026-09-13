#!/usr/bin/env node
/**
 * Checks the parts that talk to the outside world or do fiddly maths, against real
 * data rather than mocks. Run with:  node tools/selftest.mjs
 *
 * The live-API section is skipped with --offline.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const offline = process.argv.includes('--offline');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/* ---------------- marker transform parsing (copy of markerPixel) ---------------- */

function markerPixel(transform) {
  const matches = [...transform.matchAll(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  return [Number(last[1]), Number(last[2])];
}

console.log('\nMarker transform parsing');
{
  // Captured verbatim from a live daft.ie price pin on 2026-08-12.
  const real =
    'translate(-50%, -100%) translate(618.039px, 281.703px) rotateX(0deg) rotateZ(0deg)';
  const px = markerPixel(real);
  check('reads the projected pixel, not the % anchor', px?.[0] === 618.039 && px?.[1] === 281.703, JSON.stringify(px));

  const negative = markerPixel('translate(-50%, -100%) translate(-12.5px, -3px)');
  check('handles negative offsets (marker off-screen left)', negative?.[0] === -12.5 && negative?.[1] === -3);

  check('returns null when there is no pixel translate', markerPixel('translate(-50%, -100%)') === null);
}

/* --------------------------- polyline decoding ---------------------------- */

function decodePolyline(encoded, precision = 5) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let result = 0, shift = 0, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

console.log('\nPolyline decoding');
{
  // The canonical example from Google's encoded-polyline spec.
  const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
  const expected = [[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]];
  const close = decoded.every((c, i) => Math.abs(c[0] - expected[i][0]) < 1e-6 && Math.abs(c[1] - expected[i][1]) < 1e-6);
  check('matches the reference vector', close && decoded.length === 3, JSON.stringify(decoded));
}

/* ------------------------------ Dublin time ------------------------------- */

const TZ = 'Europe/Dublin';
function tzOffsetMs(instant) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    - Math.floor(instant.getTime() / 1000) * 1000;
}
function dublinLocalToInstant(y, m, d, h, min) {
  const naive = Date.UTC(y, m - 1, d, h, min);
  let utc = naive - tzOffsetMs(new Date(naive));
  utc = naive - tzOffsetMs(new Date(utc));
  return new Date(utc);
}
function dublinParts(instant) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(instant);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: +get('year'), month: +get('month'), day: +get('day'),
    hour: +get('hour'), minute: +get('minute'), weekday: get('weekday'),
  };
}
const WEEKEND = new Set(['Sat', 'Sun']);

/** Great-circle metres between two [lon, lat] points. */
function metresApart([lon1, lat1], [lon2, lat2]) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nextWeekdayTarget(hour, minute, now = new Date()) {
  const today = dublinParts(now);
  let candidate = dublinLocalToInstant(today.year, today.month, today.day, hour, minute);
  for (let i = 0; i < 8; i++) {
    const p = dublinParts(candidate);
    if (candidate.getTime() > now.getTime() && !WEEKEND.has(p.weekday)) return candidate;
    candidate = new Date(candidate.getTime() + 24 * 3600 * 1000);
    const next = dublinParts(candidate);
    candidate = dublinLocalToInstant(next.year, next.month, next.day, hour, minute);
  }
  return candidate;
}

console.log('\nDublin-local 09:00 targeting');
{
  // Summer: Dublin is UTC+1, so 09:00 local is 08:00Z.
  const summer = nextWeekdayTarget(9, 0, new Date('2026-08-12T06:00:00Z'));
  check('August 09:00 Dublin === 08:00Z', summer.toISOString() === '2026-08-12T08:00:00.000Z', summer.toISOString());

  // Winter: Dublin is UTC+0, so 09:00 local is 09:00Z. Same code, different offset -
  // this is the case a naive UTC bucket gets wrong for half the year.
  const winter = nextWeekdayTarget(9, 0, new Date('2026-01-14T06:00:00Z'));
  check('January 09:00 Dublin === 09:00Z', winter.toISOString() === '2026-01-14T09:00:00.000Z', winter.toISOString());

  // Friday evening must roll to Monday, not Saturday.
  const friEvening = nextWeekdayTarget(9, 0, new Date('2026-08-14T20:00:00Z'));
  check('Friday night rolls to Monday', dublinParts(friEvening).weekday === 'Mon', friEvening.toISOString());

  // Already past 09:00 today -> tomorrow, not today.
  const afternoon = nextWeekdayTarget(9, 0, new Date('2026-08-12T14:00:00Z'));
  check('afternoon rolls to the next day', afternoon.toISOString() === '2026-08-13T08:00:00.000Z', afternoon.toISOString());
}

console.log('\nPinned commute date');
{
  const resolveTarget = (o, now) => {
    if (o.targetDate) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(o.targetDate);
      if (m) return dublinLocalToInstant(+m[1], +m[2], +m[3], o.targetHour, o.targetMinute);
    }
    return nextWeekdayTarget(o.targetHour, o.targetMinute, now);
  };
  const now = new Date('2026-08-12T06:00:00Z');

  // A pinned date must win outright, including a weekend - timetables differ by day and
  // "how long on a Saturday?" is a legitimate question the auto mode cannot express.
  const saturday = resolveTarget({ targetDate: '2026-08-15', targetHour: 9, targetMinute: 0 }, now);
  check('pinned Saturday is honoured', saturday.toISOString() === '2026-08-15T08:00:00.000Z', saturday.toISOString());

  // Pinned dates go through the same Dublin conversion, so winter must shift too.
  const january = resolveTarget({ targetDate: '2026-01-14', targetHour: 9, targetMinute: 0 }, now);
  check('pinned winter date is UTC+0', january.toISOString() === '2026-01-14T09:00:00.000Z', january.toISOString());

  const half = resolveTarget({ targetDate: '2026-08-15', targetHour: 8, targetMinute: 30 }, now);
  check('minutes are respected', half.toISOString() === '2026-08-15T07:30:00.000Z', half.toISOString());

  const auto = resolveTarget({ targetDate: null, targetHour: 9, targetMinute: 0 }, now);
  check('null date falls back to next weekday', auto.toISOString() === '2026-08-12T08:00:00.000Z', auto.toISOString());

  const junk = resolveTarget({ targetDate: 'not-a-date', targetHour: 9, targetMinute: 0 }, now);
  check('malformed date falls back rather than throwing', junk.toISOString() === '2026-08-12T08:00:00.000Z');
}

/* ------------------------------ bundled data ------------------------------ */

console.log('\nBundled transport data');
{
  const lines = JSON.parse(await readFile(path.join(root, 'extension/public/data/dublin-rail-lines.json'), 'utf8'));
  const stops = JSON.parse(await readFile(path.join(root, 'extension/public/data/dublin-rail-stops.json'), 'utf8'));

  const names = lines.features.map((f) => `${f.properties.name}|${f.properties.detail}`);
  check('has both Luas lines', names.some((n) => n.includes('Luas Green')) && names.some((n) => n.includes('Luas Red')));
  check('has DART', names.some((n) => n.startsWith('DART')));
  check('every feature has a colour', lines.features.every((f) => /^#[0-9a-f]{6}$/i.test(f.properties.color)));
  check('every feature has a known mode', lines.features.every((f) => ['luas', 'dart', 'commuter'].includes(f.properties.mode)));

  const coords = lines.features.flatMap((f) =>
    f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates.flat()
  );
  const inIreland = coords.every(([lon, lat]) => lon > -11 && lon < -5 && lat > 51 && lat < 56);
  check('all coordinates are in Ireland and lon/lat ordered', inIreland);

  // Spot-check against ground truth: Luas Green must pass near Ranelagh (53.3245,-6.2545).
  const green = lines.features.find((f) => f.properties.name === 'Luas Green');
  const nearRanelagh = green.geometry.coordinates.some(
    ([lon, lat]) => Math.abs(lat - 53.3245) < 0.004 && Math.abs(lon + 6.2545) < 0.004
  );
  check('Luas Green passes Ranelagh', nearRanelagh);

  const stopNames = new Set(stops.features.map((f) => f.properties.name));
  check('stops include Connolly', stopNames.has('Connolly'));
  check('stops include Ranelagh', stopNames.has('Ranelagh'), `${stops.features.length} stops`);
}

/* ------------------------------- live API --------------------------------- */

if (!offline) {
  console.log('\nTransitous live API (the exact parameters the extension sends)');

  const options = { arriveBy: true, maxTransfers: 3, maxTravelMinutes: 120, maxWalkMeters: 1000 };
  const target = nextWeekdayTarget(9, 0);
  const from = [-6.240177677027, 53.287142333315]; // a real Daft listing, Dundrum
  const to = [-6.2546, 53.3438]; // Trinity College

  const params = new URLSearchParams({
    fromPlace: `${from[1]},${from[0]}`,
    toPlace: `${to[1]},${to[0]}`,
    time: target.toISOString(),
    arriveBy: String(options.arriveBy),
    maxTransfers: String(options.maxTransfers),
    maxTravelTime: String(options.maxTravelMinutes),
    maxPreTransitTime: String(Math.round(options.maxWalkMeters / 1.4)),
  });

  const url = `https://api.transitous.org/api/v1/plan?${params}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'DublinCommuteOverlay/0.1.0 (+selftest)' },
  });
  check(`plan() parameters accepted (HTTP ${res.status})`, res.ok, res.ok ? '' : await res.text().then((t) => t.slice(0, 200)));

  if (res.ok) {
    const body = await res.json();
    const its = body.itineraries ?? [];
    check('returns itineraries', its.length > 0, `${its.length}`);

    if (its.length) {
      const best = its[0];
      const arrivesBefore = new Date(best.endTime).getTime() <= target.getTime();
      check('arriveBy honoured (arrival <= target)', arrivesBefore, `${best.endTime} vs ${target.toISOString()}`);

      const modes = [...new Set(its.flatMap((i) => i.legs.map((l) => l.mode)))];
      check('legs carry modes', modes.length > 0, modes.join(','));

      const withGeom = its.flatMap((i) => i.legs).find((l) => l.legGeometry?.points);
      check('legs carry geometry', !!withGeom, withGeom ? `precision=${withGeom.legGeometry.precision}` : 'none');

      if (withGeom) {
        const pts = decodePolyline(withGeom.legGeometry.points, withGeom.legGeometry.precision ?? 5);
        const sane = pts.length > 1 && pts.every(([lon, lat]) => lon > -7 && lon < -5.5 && lat > 52.8 && lat < 53.8);
        check('decoded geometry lands in the Dublin area', sane,
          sane ? `${pts.length} pts` : JSON.stringify(pts.slice(0, 2)));
      }

      const summary = best.legs
        .map((l) => (l.mode === 'WALK' ? `walk ${Math.round(l.duration / 60)}m` : `${l.routeShortName ?? l.mode} ${Math.round(l.duration / 60)}m`))
        .join(' -> ');
      console.log(`       best: ${Math.round(best.duration / 60)} min — ${summary}`);
    }
  }

  console.log('\nTravel modes (walk / cycle / drive)');
  {
    const FROM = [-6.240178, 53.287142];
    const TO = [-6.2546, 53.3438];

    // Mirrors plan() exactly. Three params here are load-bearing and were found by
    // testing: maxDirectTime must be set or walk/bike return nothing, transitModes=''
    // is what suppresses transit ('NONE' is rejected outright by the enum), and
    // arriveBy must be false for direct modes - see the note in transitous.ts.
    const buildParams = (mode) => {
      const p = new URLSearchParams({
        fromPlace: `${FROM[1]},${FROM[0]}`,
        toPlace: `${TO[1]},${TO[0]}`,
        time: nextWeekdayTarget(9, 0).toISOString(),
        arriveBy: String(mode === 'transit'),
      });
      if (mode === 'transit') {
        p.set('maxTransfers', '3');
        p.set('maxTravelTime', '120');
        p.set('maxPreTransitTime', String(Math.round(1000 / 1.4)));
      } else {
        p.set('directModes', { walk: 'WALK', bike: 'BIKE', car: 'CAR' }[mode]);
        p.set('transitModes', '');
        p.set('maxDirectTime', String(120 * 60));
      }
      return p;
    };

    const durations = {};
    for (const mode of ['walk', 'bike', 'car']) {
      const res = await fetch(`https://api.transitous.org/api/v1/plan?${buildParams(mode)}`, {
        headers: { 'User-Agent': 'DublinCommuteOverlay/0.1.0 (+selftest)' },
      });
      if (!res.ok) {
        check(`${mode} accepted`, false, `HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
        continue;
      }
      const body = await res.json();
      const it = (body.direct ?? [])[0];
      check(`${mode} returns a route`, !!it, it ? `${Math.round(it.duration / 60)} min` : 'empty direct[]');
      if (!it) continue;

      durations[mode] = it.duration / 60;
      check(`${mode} leg uses the requested mode`,
        it.legs.every((l) => l.mode === { walk: 'WALK', bike: 'BIKE', car: 'CAR' }[mode]),
        it.legs.map((l) => l.mode).join(','));
      check(`${mode} leg carries geometry`, !!it.legs[0]?.legGeometry?.points);
      check(`${mode} suppresses transit computation`, (body.itineraries ?? []).length === 0);

      // The regression this suite missed once: asked with arriveBy=true, MOTIS returned
      // a polyline rotated about the backward search's meeting point. It began mid-route
      // and closed on itself - a loop on the map instead of a line from the property to
      // the destination - and both endpoints sat ~2.5 km from where they belonged.
      const geom = it.legs[0].legGeometry;
      const pts = decodePolyline(geom.points, geom.precision ?? 5);
      // Walk and cycle snap to the footpath outside the door; a drive can only end at
      // the nearest road the car may use, which is legitimately a couple of streets away.
      const snap = mode === 'car' ? 300 : 60;
      const startGap = metresApart(pts[0], FROM);
      const endGap = metresApart(pts[pts.length - 1], TO);
      check(`${mode} route starts at the property`, startGap < snap, `${Math.round(startGap)} m off`);
      check(`${mode} route ends at the destination`, endGap < snap, `${Math.round(endGap)} m off`);

      let drawn = 0;
      for (let i = 1; i < pts.length; i++) drawn += metresApart(pts[i - 1], pts[i]);
      check(`${mode} route is a line, not a loop`, metresApart(pts[0], pts[pts.length - 1]) > snap,
        `${(drawn / 1000).toFixed(1)} km drawn, ends ${Math.round(metresApart(pts[0], pts[pts.length - 1]))} m from its start`);
    }

    // Sanity on the numbers themselves: for a ~7 km city trip these must order sensibly.
    if (durations.walk && durations.bike && durations.car) {
      check('drive < cycle < walk', durations.car < durations.bike && durations.bike < durations.walk,
        `car ${Math.round(durations.car)} / bike ${Math.round(durations.bike)} / walk ${Math.round(durations.walk)} min`);
    }
  }

  console.log('\nWhy a lookup came back empty');
  {
    // "No route found" is true both for a property with no nearby stop and for one whose
    // commute merely exceeds the cap, but the two need different advice. The relaxed
    // probe is what separates them - these cases check it actually does.
    const ask = async (from, to, opts) => {
      const p = new URLSearchParams({
        fromPlace: from, toPlace: to,
        time: '2026-08-14T08:00:00Z', arriveBy: 'true',
        maxTransfers: String(opts.maxTransfers),
        maxTravelTime: String(opts.maxTravelMinutes),
        maxPreTransitTime: String(Math.round(opts.maxWalkMeters / 1.4)),
      });
      const res = await fetch(`https://api.transitous.org/api/v1/plan?${p}`, {
        headers: { 'User-Agent': 'DublinCommuteOverlay/0.1.0 (+selftest)' },
      });
      if (!res.ok) return null;
      return (await res.json()).itineraries ?? [];
    };
    const NORMAL = { maxWalkMeters: 1000, maxTransfers: 3, maxTravelMinutes: 120 };
    const RELAXED = { maxWalkMeters: 3000, maxTransfers: 4, maxTravelMinutes: 240 };

    // A rural property with no stop within ~3 km: genuinely unserved, and the probe
    // must agree rather than inventing an answer.
    const RURAL = '53.46000,-6.42000';
    const AWS_FINGAL = '53.40403,-6.36217';
    const rural = await ask(RURAL, AWS_FINGAL, NORMAL);
    check('unserved property returns nothing at normal limits', rural?.length === 0, `${rural?.length}`);
    const ruralProbe = await ask(RURAL, AWS_FINGAL, RELAXED);
    check('and still nothing when relaxed -> honest "no service"', ruralProbe?.length === 0,
      `${ruralProbe?.length} - reported as no-route`);

    // A well-connected property reaching the same site: comfortably routable, so the
    // empty-result path must not fire at all.
    const dundrum = await ask('53.287142,-6.240178', AWS_FINGAL, NORMAL);
    check('well-connected property routes normally', (dundrum?.length ?? 0) > 0,
      dundrum?.length ? `${Math.round(dundrum[0].duration / 60)} min` : 'none');

    // A journey that exists but only outside the caps -> "outside-limits", with numbers.
    const tight = await ask('53.287142,-6.240178', AWS_FINGAL, { ...NORMAL, maxTravelMinutes: 45 });
    const loose = await ask('53.287142,-6.240178', AWS_FINGAL, RELAXED);
    check('a too-long commute is empty at a tight cap', tight?.length === 0, `${tight?.length}`);
    check('but the probe finds it, so we can name the cost', (loose?.length ?? 0) > 0,
      loose?.length ? `${Math.round(loose[0].duration / 60)} min` : 'none');
  }

  console.log('\nTransitous client identification');
  {
    // Transitous ENFORCES a non-generic User-Agent. Node's default is rejected, which is
    // why the extension's declarativeNetRequest rule is load-bearing rather than polite.
    const generic = await fetch('https://api.transitous.org/api/v1/geocode?text=Dublin');
    check('generic User-Agent is rejected (403)', generic.status === 403,
      `got ${generic.status} — if this ever passes, revisit SPEC 4.2`);

    const identified = await fetch('https://api.transitous.org/api/v1/geocode?text=Dublin', {
      headers: { 'User-Agent': 'DublinCommuteOverlay/0.1.0 (+selftest)' },
    });
    check('identified User-Agent is accepted', identified.ok, `HTTP ${identified.status}`);
  }

  console.log('\nTransitous geocoding (with the extension’s ranking)');
  {
    const params = new URLSearchParams({ text: 'Trinity College', language: 'en', place: '53.3498,-6.2603' });
    const gres = await fetch(`https://api.transitous.org/api/v1/geocode?${params}`, {
      headers: { 'User-Agent': 'DublinCommuteOverlay/0.1.0 (+selftest)' },
    });
    check(`geocode() accepted (HTTP ${gres.status})`, gres.ok);

    if (gres.ok) {
      const hits = (await gres.json()).filter((h) => typeof h.lat === 'number');
      const countryOf = (h) => h.areas?.find((a) => a.adminLevel === 2)?.name ?? '';

      // The raw ranking is wrong for an Irish property tool; prove it, so the re-rank
      // below is demonstrably doing something rather than being cargo-culted.
      check('raw ranking puts a non-Irish match first (why we re-rank)',
        countryOf(hits[0]) !== 'Ireland', `raw #1 = ${hits[0]?.name}, ${countryOf(hits[0])}`);

      const ranked = [
        ...hits.filter((h) => countryOf(h) === 'Ireland'),
        ...hits.filter((h) => countryOf(h) !== 'Ireland'),
      ];
      const top = ranked[0];
      check('re-ranked top hit is the Dublin one',
        countryOf(top) === 'Ireland' && Math.abs(top.lat - 53.344) < 0.02,
        `${top?.name} ${Number(top?.lat).toFixed(3)},${Number(top?.lon).toFixed(3)}`);
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll checks passed\n');
process.exit(failures ? 1 : 0);
