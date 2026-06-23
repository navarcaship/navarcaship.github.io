// Fetches a live vessel snapshot around the UAE from VesselAPI and writes data/vessels.json.
// Run by GitHub Actions on a schedule. Key comes from env (never commit it).
//
// Coverage uses two query types (VesselAPI allows both):
//  - one bounding box for the western Gulf (Ruwais / Abu Dhabi / Jebel Ali; max 4-degree span)
//  - one 100 km radius centred on Ras Al Khaimah, which reaches Dubai, the northern
//    emirates, and the east coast (Khor Fakkan / Fujairah) in a single call
// Each query returns up to 50 results; we merge and dedupe by MMSI.
//
// Flag is derived from the MMSI's first 3 digits (the ITU "MID"), so it needs
// no extra API call. IMO, nav_status, heading and position come from each query.

import { writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";

const KEY = process.env.VESSELAPI_KEY;
if (!KEY) { console.error("Missing VESSELAPI_KEY"); process.exit(1); }

const LOCATION = "United Arab Emirates";
const BOX    = "https://api.vesselapi.com/v1/location/vessels/bounding-box";
const RADIUS = "https://api.vesselapi.com/v1/location/vessels/radius";
const MAX_VESSELS = 100;   // show ~the whole fetch (2 queries × up to 50, deduped) — a long, varied loop

const QUERIES = [
  { label: "Western Gulf · Ruwais / Abu Dhabi / Jebel Ali", type: "box",
    latBottom: 23.9, latTop: 25.0, lonLeft: 52.3, lonRight: 55.1 },   // span 3.9°
  { label: "Northern + east coast · Dubai / RAK / Fujairah / Hormuz", type: "radius",
    lat: 25.796157, lon: 56.089480, radius: 100000 }   // metres (max 100,000)
];

// ---- MMSI MID (first 3 digits) -> ISO-2 country code (full ITU table) --------
const MID = {
  "201":"AL","202":"AD","203":"AT","204":"PT","205":"BE","206":"BY","207":"BG","208":"VA",
  "209":"CY","210":"CY","211":"DE","212":"CY","213":"GE","214":"MD","215":"MT","216":"AM",
  "218":"DE","219":"DK","220":"DK","224":"ES","225":"ES","226":"FR","227":"FR","228":"FR",
  "229":"MT","230":"FI","231":"FO","232":"GB","233":"GB","234":"GB","235":"GB","236":"GI",
  "237":"GR","238":"HR","239":"GR","240":"GR","241":"GR","242":"MA","243":"HU","244":"NL",
  "245":"NL","246":"NL","247":"IT","248":"MT","249":"MT","250":"IE","251":"IS","252":"LI",
  "253":"LU","254":"MC","255":"PT","256":"MT","257":"NO","258":"NO","259":"NO","261":"PL",
  "262":"ME","263":"PT","264":"RO","265":"SE","266":"SE","267":"SK","268":"SM","269":"CH",
  "270":"CZ","271":"TR","272":"UA","273":"RU","274":"MK","275":"LV","276":"EE","277":"LT",
  "278":"SI","279":"RS",
  "301":"AI","303":"US","304":"AG","305":"AG","306":"NL","307":"AW","308":"BS","309":"BS",
  "310":"BM","311":"BS","312":"BZ","314":"BB","316":"CA","319":"KY","321":"CR","323":"CU",
  "325":"DM","327":"DO","329":"GP","330":"GD","331":"GL","332":"GT","334":"HN","336":"HT",
  "338":"US","339":"JM","341":"KN","343":"LC","345":"MX","347":"MQ","348":"MS","350":"NI",
  "351":"PA","352":"PA","353":"PA","354":"PA","355":"PA","356":"PA","357":"PA","358":"PR",
  "359":"SV","361":"PM","362":"TT","364":"TC","366":"US","367":"US","368":"US","369":"US",
  "370":"PA","371":"PA","372":"PA","373":"PA","374":"PA","375":"VC","376":"VC","377":"VC",
  "378":"VG","379":"VI",
  "401":"AF","403":"SA","405":"BD","408":"BH","410":"BT","412":"CN","413":"CN","414":"CN",
  "416":"TW","417":"LK","419":"IN","422":"IR","423":"AZ","425":"IQ","428":"IL","431":"JP",
  "432":"JP","434":"TM","436":"KZ","437":"UZ","438":"JO","440":"KR","441":"KR","443":"PS",
  "445":"KP","447":"KW","450":"LB","451":"KG","453":"MO","455":"MV","457":"MN","459":"NP",
  "461":"OM","463":"PK","466":"QA","468":"SY","470":"AE","471":"AE","472":"TJ","473":"YE",
  "475":"YE","477":"HK","478":"BA",
  "501":"TF","503":"AU","506":"MM","508":"BN","510":"FM","511":"PW","512":"NZ","514":"KH",
  "515":"KH","516":"CX","518":"CK","520":"FJ","523":"CC","525":"ID","529":"KI","531":"LA",
  "533":"MY","536":"MP","538":"MH","540":"NC","542":"NU","544":"NR","546":"PF","548":"PH",
  "550":"TL","553":"PG","555":"PN","557":"SB","559":"AS","561":"WS","563":"SG","564":"SG",
  "565":"SG","566":"SG","567":"TH","570":"TO","572":"TV","574":"VN","576":"VU","577":"VU",
  "578":"WF",
  "601":"ZA","603":"AO","605":"DZ","607":"TF","608":"SH","609":"BI","610":"BJ","611":"BW",
  "612":"CF","613":"CM","615":"CG","616":"KM","617":"CV","618":"TF","619":"CI","620":"KM",
  "621":"DJ","622":"EG","624":"ET","625":"ER","626":"GA","627":"GH","629":"GM","630":"GW",
  "631":"GQ","632":"GN","633":"BF","634":"KE","635":"TF","636":"LR","637":"LR","638":"SS",
  "642":"LY","644":"LS","645":"MU","647":"MG","649":"ML","650":"MZ","654":"MR","655":"MW",
  "656":"NE","657":"NG","659":"NA","660":"RE","661":"RW","662":"SD","663":"SN","664":"SC",
  "665":"SH","666":"SO","667":"SL","668":"ST","669":"SZ","670":"TD","671":"TG","672":"TN",
  "674":"TZ","675":"UG","676":"CD","677":"TZ","678":"ZM","679":"ZW",
  "701":"AR","710":"BR","720":"BO","725":"CL","730":"CO","735":"EC","740":"FK","745":"GF",
  "750":"GY","755":"PY","760":"PE","765":"SR","770":"UY","775":"VE"
};

const flag = (mmsi) => {
  const cc = MID[String(mmsi).slice(0, 3)];
  return cc ? cc.replace(/./g, c => String.fromCodePoint(127397 + c.charCodeAt(0))) : "";
};

// ---- AIS navigational status code -> short label ----------------------------
const NAV = {
  0:"UNDERWAY", 1:"AT ANCHOR", 2:"NOT UNDER CMD", 3:"RESTRICTED",
  4:"DRAUGHT-CONSTR.", 5:"MOORED", 6:"AGROUND", 7:"FISHING", 8:"SAILING"
};

const byMmsi = new Map();

function url(q) {
  if (q.type === "radius") {
    return `${RADIUS}?` + new URLSearchParams({
      "filter.latitude": q.lat, "filter.longitude": q.lon,
      "filter.radius": q.radius, "pagination.limit": "50"
    });
  }
  return `${BOX}?` + new URLSearchParams({
    "filter.latBottom": q.latBottom, "filter.latTop": q.latTop,
    "filter.lonLeft": q.lonLeft, "filter.lonRight": q.lonRight,
    "pagination.limit": "50"
  });
}

for (const q of QUERIES) {
  const r = await fetch(url(q), { headers: { Authorization: `Bearer ${KEY}` } });
  if (!r.ok) {
    console.error(`Query "${q.label}" failed:`, r.status, await r.text().catch(() => ""));
    continue;
  }
  const d = await r.json();
  let n = 0;
  for (const x of (d.vessels || [])) {
    if (!x.vessel_name) continue;
    n++;
    const prev = byMmsi.get(x.mmsi);
    if (!prev || new Date(x.timestamp) > new Date(prev.t)) {
      byMmsi.set(x.mmsi, {
        mmsi: x.mmsi,
        name: x.vessel_name.trim().replace(/\s+/g, " "),
        imo: (x.imo && String(x.imo).length === 7) ? x.imo : null,
        flag: flag(x.mmsi),
        lat: +(+x.latitude).toFixed(4),
        lon: +(+x.longitude).toFixed(4),
        sog: (x.sog == null || x.sog >= 102) ? 0 : x.sog,          // 102.2 = AIS "unavailable"
        heading: (x.heading == null || x.heading >= 360) ? null : x.heading, // 511 = unavailable
        status: NAV[x.nav_status] || "",
        t: x.timestamp
      });
    }
  }
  console.error(`  ${q.label}: ${n} vessels`);
}

const now = new Date().toISOString();
const all = [...byMmsi.values()].map(({ t, ...v }) => v);   // full deduped set, drop internal timestamp

// ---- 1) Live ticker feed ------------------------------------------------------
// Show as much of the fetch as we can (idle vessels included): the point is to
// reflect real UAE traffic. A long list also keeps the scroll loop from visibly
// repeating, which would make the live feed look like canned data. Shuffled so
// movers and anchored vessels interleave rather than clump, and so the running
// order refreshes each day.
const ticker = shuffle(all).slice(0, MAX_VESSELS);
writeFileSync("data/vessels.json", JSON.stringify({
  location: LOCATION, updated: now, count: ticker.length, vessels: ticker
}, null, 1));

// ---- 2) Cumulative database — roster (fleet.json/.csv) + history (NDJSON) ------
updateDatabase(all, now);

console.log(`Wrote data/vessels.json — ${ticker.length} of ${all.length} tracked vessels (ticker).`);

// =============================================================================
// Cumulative vessel database
//   data/fleet.json   — roster: one upserted record per unique MMSI
//   data/fleet.csv    — same roster, spreadsheet-friendly (UTF-8 BOM for Excel)
//   data/history.ndjson — append-only log: one JSON line per vessel per run
// The live ticker (vessels.json) is untouched; this just accumulates alongside it.
// =============================================================================
function updateDatabase(vessels, ts) {
  const ROSTER = "data/fleet.json";

  // load existing roster, keyed by MMSI
  const roster = new Map();
  if (existsSync(ROSTER)) {
    try {
      for (const v of (JSON.parse(readFileSync(ROSTER, "utf8")).vessels || [])) roster.set(v.mmsi, v);
    } catch (e) { console.error("  Could not parse fleet.json, starting fresh:", e.message); }
  }

  // upsert each vessel seen this run
  let added = 0;
  for (const v of vessels) {
    const r = roster.get(v.mmsi);
    if (r) {
      r.lastSeen = ts;
      r.timesSeen += 1;
      if (v.name && !r.names.includes(v.name)) r.names.push(v.name);   // catch renames / AIS typos
      if (v.name) r.name = v.name;
      if (v.imo)  r.imo  = v.imo;
      if (v.flag) r.flag = v.flag;
      r.lastLat = v.lat; r.lastLon = v.lon;
      r.lastSog = v.sog; r.lastHeading = v.heading; r.lastStatus = v.status;
    } else {
      roster.set(v.mmsi, {
        mmsi: v.mmsi, name: v.name, names: v.name ? [v.name] : [],
        imo: v.imo, flag: v.flag,
        firstSeen: ts, lastSeen: ts, timesSeen: 1,
        lastLat: v.lat, lastLon: v.lon, lastSog: v.sog,
        lastHeading: v.heading, lastStatus: v.status
      });
      added++;
    }
  }

  const list = [...roster.values()]
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || (a.name || "").localeCompare(b.name || ""));
  writeFileSync(ROSTER, JSON.stringify({ updated: ts, count: list.length, vessels: list }, null, 1));
  writeFileSync("data/fleet.csv", toCsv(list));

  // append this run's snapshot to the history log
  const lines = vessels.map(v => JSON.stringify({
    ts, mmsi: v.mmsi, name: v.name, imo: v.imo, flag: v.flag,
    lat: v.lat, lon: v.lon, sog: v.sog, heading: v.heading, status: v.status
  })).join("\n") + "\n";
  appendFileSync("data/history.ndjson", lines);

  console.log(`  Database: ${list.length} unique vessels on record (+${added} new); ${vessels.length} observations logged.`);
}

// Fisher–Yates shuffle (returns a new array; original order is API-ranked)
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toCsv(list) {
  const cols = ["mmsi","name","names","imo","flag","firstSeen","lastSeen","timesSeen",
                "lastLat","lastLon","lastSog","lastHeading","lastStatus"];
  const esc = s => {
    s = s == null ? "" : String(s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = list.map(v => cols.map(c => esc(c === "names" ? v.names.join("; ") : v[c])).join(","));
  return "﻿" + [cols.join(","), ...rows].join("\n") + "\n";   // BOM so Excel reads UTF-8/emoji
}
