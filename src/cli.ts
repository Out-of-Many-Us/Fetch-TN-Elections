#!/usr/bin/env node
// tnlocal — collect Tennessee local election results from the counties' own
// servers, archive what was served, and emit a flat CSV.
//
// WHY THIS IS A LAPTOP TOOL AND NOT A HOSTED SERVICE. Several county servers
// block cloud fetchers outright — Bradley County's web application firewall is
// the documented case. Results a laptop on a home connection fetches without
// trouble can be permanently unreachable from a hosted environment. That is the
// reason this tool takes the shape it does, rather than a caveat on it.
//
// NO DATABASE. NO ENV VARS REQUIRED. The parsers import nothing at all, which is
// what makes this runnable anywhere without setup.
//
//   tnlocal fetch  --county rutherford [--cycle 2026]
//   tnlocal parse  --county rutherford [--cycle 2026]   (archive only, no network)
//   tnlocal verify --county rutherford                  (rebuild from archive)
//
// ARCHIVE IS APPEND-ONLY AND NEVER REWRITTEN. `parse` and `verify` read only
// what `fetch` stored, so the CSV is a pure function of archived bytes — the
// same rule the ingestion lanes follow, and the only thing that makes a figure
// traceable to the document it came from.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEssHtmlReport } from "./parsers/ess-html-results-parser.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE = path.join(ROOT, "archive");

/// Politeness posture, inherited from the product's standing rule: serial by
/// construction, a User-Agent naming the project and a contact address. A
/// missing robots.txt is a permissive posture, not an invitation.
const USER_AGENT =
  "tnlocal/0.1 (Out of Many. Us local-results kit; +https://github.com/outofmany-us; hello@mail.outofmany.us)";

/// ⚠️ THE URL'S DATE IS THE ELECTION'S DATE, AND IT IS THE ONLY RELIABLE ONE.
/// Rutherford encodes MMDDYY in the path — `080626` is 2026-08-06. The report
/// body carries a printed date too, but it has been observed to disagree, so the
/// archive is keyed on the URL's date and the body's is recorded beside it.
type Source = { slug: string; fips: string; name: string; urls: string[] };

const COUNTIES: Source[] = [
  {
    slug: "rutherford",
    fips: "47149",
    name: "Rutherford County",
    urls: [
      "https://secured.rutherfordcountytn.gov/election/080626-html/Rutherford_ElecSumm_all.htm",
      "https://secured.rutherfordcountytn.gov/election/050526-html/Rutherford_ElecSumm_all.htm",
      "https://secured.rutherfordcountytn.gov/election/030524-html/Rutherford_ElecSumm_all.htm",
      "https://secured.rutherfordcountytn.gov/election/110822-html/Rutherford_ElecSumm_all.htm",
      "https://secured.rutherfordcountytn.gov/election/080422-html/Rutherford_ElecSumm_all.htm",
      "https://secured.rutherfordcountytn.gov/election/050322-html/Rutherford_ElecSumm_all.htm",
      "https://secured.rutherfordcountytn.gov/election/110618-html/Rutherford_ElecSumm_all.htm",
      "https://secured.rutherfordcountytn.gov/election/080218-html/Rutherford_ElecSumm_all.htm",
    ],
  },
];

/// `080626` -> `2026-08-06`. Two-digit years are 20xx; this data starts in 2018.
function electionDateFromUrl(url: string): string | null {
  const m = /\/(\d{2})(\d{2})(\d{2})-html\//.exec(url);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  return `20${yy}-${mm}-${dd}`;
}

const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");

function countyOrDie(slug: string): Source {
  const c = COUNTIES.find((x) => x.slug === slug);
  if (!c) {
    console.error(`unknown county "${slug}". known: ${COUNTIES.map((x) => x.slug).join(", ")}`);
    process.exit(2);
  }
  return c;
}

function urlsFor(c: Source, cycle: string | null): string[] {
  if (!cycle) return c.urls;
  return c.urls.filter((u) => electionDateFromUrl(u)?.startsWith(cycle));
}

/// ── fetch ──────────────────────────────────────────────────────────────────
/// ⛔ SERIAL BY CONSTRUCTION. One request at a time, with a pause between, and
/// never a retry loop that a county's server would experience as a burst.
async function cmdFetch(slug: string, cycle: string | null) {
  const c = countyOrDie(slug);
  const urls = urlsFor(c, cycle);
  if (urls.length === 0) {
    console.log(`no reports for ${slug} in cycle ${cycle}. nothing fetched.`);
    return;
  }
  for (const url of urls) {
    const date = electionDateFromUrl(url);
    if (!date) { console.log(`SKIP  no date in url: ${url}`); continue; }
    const dir = path.join(ARCHIVE, c.slug, date);
    const file = path.join(dir, path.basename(url));
    if (existsSync(file)) { console.log(`have  ${c.slug} ${date}  (archive is append-only; not refetched)`); continue; }

    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html" } });
    } catch (e) {
      /// ⛔ A COUNTY THAT CANNOT BE REACHED IS RECORDED, NOT RETRIED INTO
      /// SUCCESS, AND NEVER FILLED IN FROM SOMEWHERE ELSE. A smaller honest kit
      /// beats a complete-looking one.
      console.log(`MISS  ${c.slug} ${date}  network: ${(e as Error).message}`);
      continue;
    }
    if (!res.ok) { console.log(`MISS  ${c.slug} ${date}  HTTP ${res.status}`); continue; }
    const body = await res.text();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, body, "utf8");
    writeFileSync(
      path.join(dir, "MANIFEST.txt"),
      [
        `url          ${url}`,
        `fetched_at   ${new Date().toISOString()}`,
        `http_status  ${res.status}`,
        `bytes        ${Buffer.byteLength(body, "utf8")}`,
        `sha256       ${sha256(body)}`,
        `user_agent   ${USER_AGENT}`,
        "",
      ].join("\n"),
      "utf8",
    );
    console.log(`SAVED ${c.slug} ${date}  ${Buffer.byteLength(body, "utf8")} bytes  ${sha256(body).slice(0, 12)}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/// ── parse ──────────────────────────────────────────────────────────────────
/// Reads ONLY the archive. No network. The output contract is one row per
/// candidate per contest.
type Row = { date: string; primaryParty: string; office: string; candidate: string; party: string; votes: number };

function rowsFromArchive(c: Source, cycle: string | null): { rows: Row[]; rejected: number; dates: string[] } {
  const base = path.join(ARCHIVE, c.slug);
  if (!existsSync(base)) return { rows: [], rejected: 0, dates: [] };
  const dates = readdirSync(base).filter((d) => !cycle || d.startsWith(cycle)).sort();
  const rows: Row[] = [];
  let rejected = 0;
  for (const date of dates) {
    const dir = path.join(base, date);
    const html = readdirSync(dir).find((f) => f.endsWith(".htm") || f.endsWith(".html"));
    if (!html) continue;
    const report = parseEssHtmlReport(readFileSync(path.join(dir, html), "utf8"));
    rejected += report.rejected.length;
    for (const contest of report.contests) {
      for (const cand of contest.candidates) {
        rows.push({
          date,
          /// ⛔ THE SOURCE'S OWN FIELD, NOT A STAGE WE DERIVED. One report file
          /// can contain BOTH a party primary and a general election — measured
          /// on Rutherford's August 2026 report — so `election_date` alone is
          /// not a key. A non-empty `primary_party` means the contest is that
          /// party's primary; empty means it is not.
          ///
          /// ⚠️ We deliberately do NOT emit "PRIMARY"/"GENERAL". That is one
          /// inference further than the county printed, and the consumer may
          /// classify differently. Reporting the source's own value keeps the
          /// judgement where it belongs.
          primaryParty: contest.primaryParty ?? "",
          /// ⛔ THE WHOLE OFFICE STRING AS PRINTED. No `district` column and no
          /// office code: decomposing "County Commission District 01" is a
          /// classifier decision, and the moment this kit makes it, a consumer
          /// inherits an interpretation they did not choose.
          office: contest.office,
          candidate: cand.name,
          party: cand.party ?? "",
          votes: cand.votes,
        });
      }
    }
  }
  return { rows, rejected, dates };
}

function toCsv(rows: Row[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [
    "election_date,primary_party,office_source,candidate,party,votes",
    ...rows.map((r) => [r.date, esc(r.primaryParty), esc(r.office), esc(r.candidate), esc(r.party), String(r.votes)].join(",")),
  ].join("\n") + "\n";
}

function cmdParse(slug: string, cycle: string | null) {
  const c = countyOrDie(slug);
  const { rows, rejected, dates } = rowsFromArchive(c, cycle);
  const out = path.join(ROOT, "out", `${c.slug}${cycle ? `-${cycle}` : ""}.csv`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, toCsv(rows), "utf8");
  console.log(`${rows.length} rows from ${dates.length} report(s) -> ${path.relative(ROOT, out)}`);
  /// ⚠️ A REJECTED CONTEST IS A FINDING, NOT A DROPPED ROW. Reported every run
  /// so a silent shrink is impossible.
  if (rejected > 0) console.log(`${rejected} contest(s) rejected by the parser — inspect before trusting coverage`);
}

/// ── verify ─────────────────────────────────────────────────────────────────
/// ⛔ THE CHECK THAT MAKES THE KIT TRUSTWORTHY: rebuild from `archive/` alone,
/// with no network, and require the CSV to match byte for byte. If this passes,
/// every published figure is a pure function of bytes somebody can re-read.
function cmdVerify(slug: string) {
  const c = countyOrDie(slug);
  const { rows } = rowsFromArchive(c, null);
  const rebuilt = toCsv(rows);
  const out = path.join(ROOT, "out", `${c.slug}.csv`);
  if (!existsSync(out)) { console.error(`no ${path.relative(ROOT, out)} to verify against — run parse first`); process.exit(1); }
  const onDisk = readFileSync(out, "utf8");
  if (rebuilt === onDisk) {
    console.log(`verify ok — ${rows.length} rows rebuilt from archive alone, byte for byte, no network`);
    return;
  }
  console.error("VERIFY FAILED — the CSV is not a pure function of the archived bytes");
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] ?? null : null; };
const county = arg("county") ?? "rutherford";
const cycle = arg("cycle");

if (cmd === "fetch") await cmdFetch(county, cycle);
else if (cmd === "parse") cmdParse(county, cycle);
else if (cmd === "verify") cmdVerify(county);
else {
  console.log("usage: tnlocal <fetch|parse|verify> --county <slug> [--cycle <year>]");
  process.exit(2);
}
