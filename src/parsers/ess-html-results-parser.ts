/// Deliberately NOT server-only, and deliberately free of any I/O: like
/// pdf-results-parser.ts this file is pure functions over already-fetched
/// markup. Fetching lives in the sync. Keeping the parsing pure is what lets
/// it run against real county files from a plain script, which is the only
/// way to know a layout change has broken it before a page renders a wrong
/// vote count.

/// Reads the ES&S "Election Summary Report" HTML export.
///
/// WHY THIS EXISTS SEPARATELY FROM THE PDF PARSER
///
/// Counties running ES&S tabulators can export their reports as PDF or as
/// HTML, and the HTML export is a different document — not the same report
/// in another wrapper. It is a print-to-HTML dump: no `<table>` anywhere,
/// every value an absolutely-positioned `<span>`, geometry carried in
/// generated CSS classes (`.s0_` bands, `.f1_` cells).
///
/// It went undetected for a long time because the vendor survey matched
/// VENDOR DOMAINS, and this export carries none — it is static files served
/// from the county's own web server. Detect the format, not the vendor.
///
/// WHY IT IS WORTH MORE THAN THE PDF
///
/// Three things the PDF cannot give us:
///
/// 1. **The party is stated, not inferred.** The PDF parser refuses to store
///    primary blocks because the report's Party column is empty there and
///    only document order separates the Republican block from the Democratic
///    one — an assumption about ES&S's generator, not a fact the source
///    states. The HTML export labels the contest itself: `(R) Governor`,
///    `(D) Governor`. That refusal does not apply here, because the source
///    says it.
/// 2. **The vote method is broken out** — Election Day / Absentee / Early —
///    which the state dashboard does not publish.
/// 3. **It is text, not a scan.** No OCR hazard, so the correctness risk
///    that makes a third of the PDF counties permanently human-only is
///    simply absent.
///
/// WHAT IT REFUSES TO DO
///
/// 1. **It ingests county and municipal offices only.** The report also
///    carries state, federal and appellate-retention races, but those are
///    already ingested from the state dashboard with a per-county breakdown.
///    Taking them here would count the same votes twice under two contests —
///    the same trap the Enhanced Voting adapter avoids.
///
/// 2. **It will not emit a contest whose arithmetic does not close.** The
///    column order is the dangerous part of every ES&S layout: read it wrong
///    and you publish an absentee count as the total. So this parser does
///    not trust a column ORDER at all. It derives which column is the total
///    by finding the one the others sum to, and refuses any contest where
///    that fails or where the candidate totals do not sum to the contest's
///    own printed `VOTES=`. A rejected contest is reported, never guessed.

export type EssCell = { x: number; y: number; text: string };
export type EssBand = { cls: string; cells: EssCell[] };

/// `left:` and `top:` for every generated class. The export declares each
/// cell's position once in a stylesheet and then references it by class, so
/// the geometry has to be read from the CSS before any row can be rebuilt.
///
/// BOTH axes are required, and `y` is not optional detail. The header block
/// lays out two independent columns of label/value pairs; drop `y` and sort
/// on `x` alone and "REGISTERED VOTERS:" is followed by the OTHER column's
/// first figure — Putnam reads 7,832 (its Election Day ballots) instead of
/// 52,546 registered voters, with nothing to indicate anything went wrong.
function readClassBoxes(html: string): Map<string, { left: number; top: number }> {
  const boxes = new Map<string, { left: number; top: number }>();
  for (const m of html.matchAll(/\.([sf]\d+_)\s*\{([^}]*)\}/g)) {
    const left = m[2].match(/left:\s*(-?[\d.]+)pt/);
    const top = m[2].match(/top:\s*(-?[\d.]+)pt/);
    if (left || top) {
      boxes.set(m[1], { left: left ? Number(left[1]) : 0, top: top ? Number(top[1]) : 0 });
    }
  }
  return boxes;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

/// Rebuilds the report's rows.
///
/// Each top-level `<div class="sN_">` is exactly one visual row — that is the
/// single structural fact this parser leans on, and it is what makes the
/// candidate/number binding safe. Document ORDER is not usable: the export
/// emits a candidate's name AFTER its vote figures, and interleaves the two
/// halves of the header block, so anything reading text in sequence pairs the
/// wrong name with the wrong row.
export function parseBands(html: string): EssBand[] {
  const boxes = readClassBoxes(html);
  const body = html.slice(Math.max(0, html.indexOf("<body")));
  const bands: EssBand[] = [];
  let current: EssBand | null = null;
  let depth = 0;
  let pending = { left: 0, top: 0 };

  // Every tag is matched, not just div/span: the report embeds an <img> for
  // the county seal, and a regex that only knows div and span leaves the
  // image tag to be swallowed by the text branch, injecting `img src="..."`
  // into the report as if it were a printed cell.
  const token = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>|([^<]+)/g;
  for (const m of body.matchAll(token)) {
    const [, closing, tag, attrs, text] = m;
    if (tag) {
      const name = tag.toLowerCase();
      if (name !== "div" && name !== "span") continue;
      if (closing === "/") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      const cls = attrs?.match(/class="([^"]+)"/)?.[1] ?? null;
      if (name === "div" && depth === 0) {
        current = { cls: cls ?? "", cells: [] };
        bands.push(current);
      }
      if (cls && boxes.has(cls)) pending = boxes.get(cls)!;
      // Self-closing tags never open a level.
      if (!/\/\s*$/.test(attrs ?? "")) depth += 1;
      continue;
    }
    const value = decodeEntities(text ?? "").replace(/\s+/g, " ").trim();
    if (value && current) current.cells.push({ x: pending.left, y: pending.top, text: value });
  }

  // Reading order within a band: down the page, then across. On a candidate
  // row every cell shares y, so this reduces to left-to-right; in the header
  // it keeps each label beside its own value.
  for (const band of bands) band.cells.sort((a, b) => a.y - b.y || a.x - b.x);
  return bands.filter((b) => b.cells.length > 0);
}

export type EssCandidate = {
  name: string;
  /// As printed by the source, e.g. "R", "D", "I" — taken from the `(R)`
  /// prefix the export puts on general-election candidates. Null when the
  /// source prints none, which is the case inside a party primary where the
  /// CONTEST already carries the party.
  party: string | null;
  votes: number;
  /// Vote-method split exactly as the report's columns are labelled. Keyed by
  /// the source's own header letter so a county that publishes a different
  /// set of methods is carried rather than flattened.
  byMethod: Record<string, number>;
};

export type EssContest = {
  /// The contest line exactly as printed, including any `(R)`/`(D)` prefix.
  rawContest: string;
  /// Office with the party prefix removed, for matching against other sources.
  office: string;
  /// Set when the contest is a party primary, which the export states in the
  /// title. Never inferred from document order.
  primaryParty: string | null;
  seats: number;
  /// The contest's own printed total, used as an independent check on the sum
  /// of the candidate rows.
  printedTotal: number;
  candidates: EssCandidate[];
  scope: ContestScope;
};

export type ContestScope =
  | "county"
  | "municipal"
  | "state-or-federal"
  | "judicial-retention"
  /// Elected by a multi-county judicial district, so not a county office.
  | "judicial-district";

/// Races the state dashboard already publishes per county. Ingesting them
/// here as well would double-count the same votes under two contests.
/// Davidson drops the "State" prefix and prints "Executive Committeeman
/// District 1" — 74 of them, which arrived at the county classifier as
/// unclassified county offices. They are the party's own committee races and
/// the state source already carries them.
///
/// Counties abbreviate differently between cycles, so these match the
/// dialects actually observed rather than one county's current spelling:
/// 2026 prints "Tennessee Senate District 13", 2022 prints "TN Senate
/// District 13", and a pattern written against only the newer one silently
/// lets state races through to be stored as county offices.
const STATE_OR_FEDERAL =
  /^(governor|united states (senate|house|representative)|u\.?s\.? (house|senate)|(tennessee|tn) (senate|house)|state exec|state committee|executive committee)/i;

/// Presidential-preference primaries, which counties print in their own
/// vocabulary — "President and Vice President of the U.S.", "Presidential
/// Candidates", "Delegates At-Large", "Presidential Delegates". All federal,
/// all already carried by the state source, none a county office.
const PRESIDENTIAL = /^(president|presidential|delegates?\b|.*\bdelegates? at-large)/i;
/// The trailing alternative is Davidson's dialect — its live feed prints
/// "Judicial Retention, Kyle A. Hixson" where the ES&S exports print the
/// court's name. Without it those races fall through to county scope and
/// seven state appellate retention questions would publish as county offices.
const JUDICIAL_RETENTION = /^(supreme court|ct of appeals|ct of crim appeals|court of (appeals|criminal)|judicial retention\b)/i;

/// Trial-level offices elected by JUDICIAL DISTRICT rather than by county —
/// "Circuit Court Judge District 16", "Chancellor 16th District", "District
/// Attorney General 16th District", "Public Defender 16th District". A
/// judicial district spans several counties, so these are not a county's own
/// offices and a county page should not own them. That is a structural fact
/// about the constituency, not a judgement about the office.
/// "Court" is abbreviated "Ct" in some cycles — Putnam's 2024 file prints
/// "Criminal Ct Judge Part I" — so the abbreviation has to be matched or a
/// multi-county judicial office arrives looking like a county one.
const JUDICIAL_DISTRICT =
  /^(circuit|criminal|chancery)\s+(court|ct)\s+judge|^chancellor|^(district )?attorney general|^district attorney|^public defender|\b\d{1,2}(st|nd|rd|th) district\b/i;
/// Matches both dialects: 2026 prints "Mayor City of Murfreesboro", 2022
/// prints "City of Murfreesboro Mayor".
const MUNICIPAL = /\b(city of|town of|alderman|council\s*man|council\s*member|ward\s+\d+)\b|^[A-Za-z ]+-[A-Za-z .']+\s+Ward\s+\d+/i;

/// Exported because other county adapters reuse it: the tabulator prints the
/// same office names whether they reach us as an HTML export or as JSON from a
/// county's own results app, so the rules for what is a county office and what
/// belongs to the state are shared.
export function scopeForOffice(office: string): ContestScope {
  if (STATE_OR_FEDERAL.test(office) || PRESIDENTIAL.test(office)) return "state-or-federal";
  if (JUDICIAL_RETENTION.test(office)) return "judicial-retention";
  if (JUDICIAL_DISTRICT.test(office)) return "judicial-district";
  if (MUNICIPAL.test(office)) return "municipal";
  return "county";
}

export type EssHeader = {
  electionName: string | null;
  electionDate: string | null;
  /// The tabulator's own election id, e.g. "TNRUTPG6". Useful as a stable
  /// key for "is this the same election we already ingested".
  electionId: string | null;
  jurisdiction: string | null;
  registeredVoters: number | null;
  ballotsCast: number | null;
  precinctsTotal: number | null;
  precinctsReported: number | null;
  /// The report's own generation timestamp, as printed. This is the closest
  /// thing the source gives to "as of", and is not the time we fetched it.
  generatedAt: string | null;
};

export type EssReport = {
  header: EssHeader;
  contests: EssContest[];
  /// Contests whose arithmetic did not close, with the reason. These are
  /// deliberately NOT in `contests`: a row we cannot prove is a row we do not
  /// publish. They are surfaced so a layout change is loud rather than silent.
  rejected: { rawContest: string; reason: string }[];
};

const toInt = (s: string): number | null => {
  const cleaned = s.replace(/,/g, "");
  return /^-?\d+$/.test(cleaned) ? Number(cleaned) : null;
};

/// Pulls a labelled figure out of the header block.
///
/// Constrained to the label's OWN printed line. The header runs two
/// independent columns of label/value pairs side by side, so "the next number
/// after the label" is only correct if "next" respects the line — otherwise
/// a label in the left column happily claims the right column's figure.
function headerFigure(bands: EssBand[], label: RegExp, tolerance = 2): number | null {
  for (const band of bands.slice(0, 12)) {
    const at = band.cells.findIndex((c) => label.test(c.text));
    if (at === -1) continue;
    const anchor = band.cells[at];
    for (const cell of band.cells.slice(at + 1)) {
      if (Math.abs(cell.y - anchor.y) > tolerance) break;
      const n = toInt(cell.text);
      if (n !== null) return n;
    }
  }
  return null;
}

function readHeader(bands: EssBand[]): EssHeader {
  const cells = bands.slice(0, 12).flatMap((b) => b.cells);
  const flat = cells.map((c) => c.text);
  const dateAt = flat.findIndex((t) => /^Election Date:/i.test(t));
  const jurisdiction = cells.find((c) => /,\s*Tennessee$/i.test(c.text)) ?? null;

  /// The header's left column reads downward: jurisdiction, election name,
  /// tabulator id, election date. Walking it by COLUMN is the only reliable
  /// way through — "the next cell" is not good enough, because the right-hand
  /// column's rows fall between them by `y` and a plain forward scan from the
  /// jurisdiction returns "PUBLIC COUNT:".
  const nextInColumn = (from: EssCell | null): EssCell | null =>
    from
      ? (cells
          .filter((c) => Math.abs(c.x - from.x) <= 2 && c.y > from.y)
          .sort((a, b) => a.y - b.y)[0] ?? null)
      : null;

  const electionName = nextInColumn(jurisdiction);

  return {
    electionName: electionName?.text ?? null,
    electionDate: dateAt >= 0 ? (flat[dateAt].replace(/^Election Date:\s*/i, "") || null) : null,
    /// The tabulator id sits directly beneath the election name. Read by
    /// POSITION, not by shape: "the only all-caps alphanumeric token" picks up
    /// `REPORTED` from the "PRECINCT STATUS: REPORTED" line that the
    /// per-precinct variant of this report prints above it.
    electionId: nextInColumn(electionName)?.text ?? null,
    jurisdiction: jurisdiction?.text ?? null,
    registeredVoters: headerFigure(bands, /^REGISTERED VOTERS/i),
    ballotsCast: headerFigure(bands, /^PUBLIC COUNT/i),
    precinctsTotal: headerFigure(bands, /^NUMBER OF PRECINCTS/i),
    precinctsReported: headerFigure(bands, /^#\s*OF PRECINCTS REPORTED/i),
    generatedAt: flat.find((t) => /^\d{1,2}\/\d{1,2}\/\d{4}\s+-\s+/.test(t)) ?? null,
  };
}

/// Learns the vote-method column letters from the report's own header row
/// ("E  A  W  TOTAL  %"), so a county publishing a different set of methods
/// is read correctly instead of being forced into another county's shape.
function readMethodColumns(bands: EssBand[]): string[] {
  for (const band of bands) {
    const texts = band.cells.map((c) => c.text);
    const total = texts.indexOf("TOTAL");
    if (total <= 0 || !texts.includes("%")) continue;
    // The header row is titled with a rule of dashes — "- - - VOTES - - -" —
    // printed as its own cell above the column letters. Select the letters
    // rather than requiring that everything before TOTAL is one, which the
    // banner defeats.
    const letters = texts.slice(0, total).filter((t) => /^[A-Z]$/.test(t));
    if (letters.length > 0) return letters;
  }
  return [];
}

const PARTY_PREFIX = /^\(([A-Z]{1,3})\)\s*/;

export function parseEssHtmlReport(html: string): EssReport {
  const bands = parseBands(html);
  const header = readHeader(bands);
  const methods = readMethodColumns(bands);
  const contests: EssContest[] = [];
  const rejected: { rawContest: string; reason: string }[] = [];

  let open: { contest: EssContest; rows: { name: string; nums: number[] }[] } | null = null;

  const close = () => {
    if (!open) return;
    const { contest, rows } = open;
    open = null;
    if (rows.length === 0) {
      rejected.push({ rawContest: contest.rawContest, reason: "no candidate rows" });
      return;
    }

    // Which column is the total? Derived, never assumed. The report's own
    // column order has differed between ES&S layouts (Davidson's PDF prints
    // TOTAL FIRST), so the safe question is not "where is TOTAL" but "which
    // column do the others sum to, on every row".
    const width = rows[0].nums.length;
    if (!rows.every((r) => r.nums.length === width)) {
      rejected.push({ rawContest: contest.rawContest, reason: "ragged rows" });
      return;
    }
    //
    // BOTH constraints are applied together, and that is not belt-and-braces.
    // The per-row test alone has real false positives: in Putnam's May 2026
    // `(D) School Board Member Dist 4` the only voted row is Write-In at
    // E=4, A=0, W=4 — where W coincidentally equals E+A, so column 2 passes
    // "the others sum to me" on every row while the true total sits at
    // column 3. Requiring the column to ALSO reproduce the contest's printed
    // `VOTES=` picks the right one. Small contests with zeros and ties are
    // where this bites, and those are exactly the down-ballot races nobody
    // would check by eye.
    let totalAt = -1;
    let rowConsistent = false;
    for (let t = 1; t < width; t += 1) {
      const parts = rows.map((r) => r.nums.slice(0, t).reduce((a, b) => a + b, 0));
      if (!rows.every((r, i) => parts[i] === r.nums[t])) continue;
      rowConsistent = true;
      if (rows.reduce((sum, r) => sum + r.nums[t], 0) === contest.printedTotal) {
        totalAt = t;
        break;
      }
    }
    if (totalAt === -1) {
      rejected.push({
        rawContest: contest.rawContest,
        reason: rowConsistent
          ? "a column the others sum to exists, but none reproduces the printed VOTES="
          : "no column the others sum to — column layout not recognised",
      });
      return;
    }

    contest.candidates = rows.map((r) => {
      const name = r.name.replace(PARTY_PREFIX, "");
      const byMethod: Record<string, number> = {};
      for (let i = 0; i < totalAt; i += 1) {
        byMethod[methods[i] ?? `col${i}`] = r.nums[i];
      }
      return {
        name,
        party: r.name.match(PARTY_PREFIX)?.[1] ?? null,
        votes: r.nums[totalAt],
        byMethod,
      };
    });

    // Re-asserted after the mapping is applied, not just while choosing it.
    // The derivation above already requires this, so a failure here means the
    // chosen column and the emitted candidates disagree — a bug between the
    // two rather than a bad report. Cheap, and it fails loudly instead of
    // publishing.
    const summed = contest.candidates.reduce((a, c) => a + c.votes, 0);
    if (summed !== contest.printedTotal) {
      rejected.push({
        rawContest: contest.rawContest,
        reason: `candidate totals sum to ${summed}, report prints ${contest.printedTotal}`,
      });
      return;
    }
    contests.push(contest);
  };

  for (const band of bands) {
    const texts = band.cells.map((c) => c.text);
    const votesAt = texts.indexOf("VOTES=");

    if (votesAt >= 0) {
      close();
      // Read by CONTENT, not by column position. The name column is not in the
      // same place in every county's export — Rutherford puts it at 315pt,
      // Montgomery at 297pt — so a threshold that works for one silently
      // shreds the other: at 297 every candidate name falls on the numbers
      // side, every contest comes back with no rows, and the bare seat count
      // becomes the contest title.
      //
      // "VOTE FOR" and its number are one cell in some exports and two in
      // others, which is the other half of the same problem.
      const voteForAt = texts.findIndex((t) => /^VOTE\s+FOR\b/i.test(t));
      let seats = 1;
      let seatCellUsed = -1;
      if (voteForAt >= 0) {
        const inline = texts[voteForAt].match(/(\d+)/);
        if (inline) {
          seats = Number(inline[1]);
        } else {
          const next = texts[voteForAt + 1]?.match(/^\d+$/)?.[0];
          if (next) {
            seats = Number(next);
            seatCellUsed = voteForAt + 1;
          }
        }
      }
      const printedTotal = toInt(texts[votesAt + 1] ?? "") ?? 0;
      // Whatever is left that is neither a marker nor a figure is the title.
      const consumed = new Set([votesAt, votesAt + 1, voteForAt, seatCellUsed]);
      const rawContest =
        texts
          .filter(
            (t, i) =>
              !consumed.has(i) && t && !/^VOTE\s+FOR\b/i.test(t) && toInt(t) === null && !/%$/.test(t),
          )
          .sort((a, b) => b.length - a.length)[0] ?? "(untitled contest)";
      const office = rawContest.replace(PARTY_PREFIX, "");
      open = {
        contest: {
          rawContest,
          office,
          primaryParty: rawContest.match(PARTY_PREFIX)?.[1] ?? null,
          seats,
          printedTotal,
          candidates: [],
          scope: scopeForOffice(office),
        },
        rows: [],
      };
      continue;
    }

    if (!open) continue;

    // A candidate row, again read by content: the whole-number cells are the
    // vote columns in left-to-right order, the percentage is discarded, and
    // the one remaining text is the candidate. Position is used only to ORDER
    // the figures, never to decide what a cell is.
    const nums = band.cells
      .map((c) => toInt(c.text))
      .filter((n): n is number => n !== null);
    const name = band.cells
      .filter((c) => toInt(c.text) === null && !/%$/.test(c.text))
      .map((c) => c.text)
      .pop();
    if (name && nums.length >= 2) open.rows.push({ name, nums });
  }
  close();

  return { header, contests, rejected };
}

/// The contests worth storing: county and municipal offices, which no other
/// source in the pipeline carries per county.
export function ingestableContests(report: EssReport): EssContest[] {
  return report.contests.filter((c) => c.scope === "county" || c.scope === "municipal");
}

/// Maps an ES&S contest title onto the office vocabulary the county page
/// renders (`src/lib/county-ballot.ts`).
///
/// Kept here, beside the parser, rather than in the sync: it is a fact about
/// the ES&S dialect, and the dialect is what it has to be tested against.
/// Enhanced Voting has its own classifier for the same reason — the two
/// sources name the same offices differently enough that one shared function
/// would be a pile of alternations serving neither. Worked examples of the
/// divergence: Enhanced Voting writes `County Commissioner District 1` and
/// `Bartlett School Board Position 2 Bartlett`; ES&S writes
/// `County Commission District 01` and `School Board City of Murfreesboro`.
///
/// Anything unrecognised returns null and MUST be reported by the caller,
/// never dropped silently — a missing county office should be loud.
export type EssClassification = {
  office: string;
  /// Always county-prefixed, matching the Enhanced Voting adapter: every
  /// county elects a sheriff, so `COUNTY_SHERIFF` alone is not a key.
  district: string;
  seats: number;
};

const pad2 = (v: string): string => v.padStart(2, "0");
const slug = (v: string): string =>
  v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/// "Mayor City of Murfreesboro" -> "murfreesboro"; "Councilman Town Of
/// Baxter" -> "baxter"; "Alderman-Monterey Ward 1" -> "monterey".
/// The place named by an EXPLICIT "City of X" / "Town of X" / "City-X" marker.
///
/// Separate from `cityIn` below because this is what feeds `explicitPlacesIn`,
/// and the evidence set has to be clean: it decides how the bare-city dialect
/// is read. The loose "Office-Name" fallback is deliberately not here — it
/// matches appellate retention contests like "Ct of Appeals Western Div -
/// Bivins" and would enter judges' surnames into the county's list of towns.
function explicitCityIn(office: string): string | null {
  // City-FIRST dialect, anchored: "City of Murfreesboro Mayor" (2022). This
  // has to be tried BEFORE the city-last patterns, or the trailing match
  // swallows the office too and yields "murfreesboro-mayor" as a place.
  const leading = office.match(
    // "Town Court Clerk" and "Town Court Judge" come FIRST in the alternation.
    // They are office names in their own right — Smyrna elects a town court
    // clerk — and without them the lazy capture in "Town of Smyrna Town Court
    // Clerk" has to run past "Town" to reach "Court Clerk", yielding the place
    // "Smyrna Town".
    /^(?:City|Town)[-\s]+(?:Of[-\s]+)?(.+?)\s+(Town\s+Court\s+(?:Clerk|Judge)|Mayor|Council\s*man|Council\s*members?|Alderman|School\s*Board|SB|Court\s+Clerk|Court\s+Judge|Judge)\b/i,
  );
  if (leading) return slug(leading[1]);

  // City-LAST dialect: "Mayor City of Murfreesboro" (2026),
  // "Council Members-City Of Algood".
  //
  // The leading `^.*` is deliberate and greedy: it forces the match onto the
  // LAST "City/Town of" in the string. Without it, the office's own words win
  // — "Town Court Clerk Town of Smyrna" matches at its FIRST "Town" and
  // produces the place "court-clerk-town-of-smyrna", which then renders as a
  // heading on the county page.
  const trailing = office.match(/^.*\b(?:City|Town)[-\s]+Of[-\s]+([A-Za-z .'-]+?)$/i);
  if (trailing) return slug(trailing[1].replace(/\bward\s+\d+.*$/i, "").trim());

  // "Alderman Ward 1 Town-S.Carthage" — hyphenated, no "of". The separator
  // must be an actual HYPHEN: allowing whitespace here made "Smyrna Town
  // Court Clerk" resolve to the place "court-clerk", because "Town" followed
  // by anything at all satisfied it.
  const hyphen = office.match(/^.*\b(?:City|Town)-\s*([A-Za-z .'-]+?)$/i);
  if (hyphen) return slug(hyphen[1].replace(/\bward\s+\d+.*$/i, "").trim());

  return null;
}

/// Every way a place is named, including the loose "Alderman-Monterey Ward 1"
/// form where the place carries no City/Town word at all. Used for
/// CLASSIFYING a contest, where the office keyword check that follows keeps
/// the loose pattern honest — never for harvesting evidence.
function cityIn(office: string): string | null {
  const explicit = explicitCityIn(office);
  if (explicit) return explicit;
  // The loose form, for places that carry no City/Town word: "Alderman-Monterey
  // Ward 1". It is only safe while what follows the hyphen actually looks like
  // a name — "Gen Sessions-Juv Ct Judge Div V Unexp" is an office on both
  // sides of the hyphen, and without this guard its second half becomes a town.
  const dash = office.match(/^[A-Za-z ]+-([A-Za-z .']+?)(?:\s+Ward\s+\d+)?$/i);
  if (!dash) return null;
  const OFFICE_WORDS =
    /\b(judge|court|ct|clerk|board|commission(?:er)?|mayor|sessions|attorney|defender|chancellor|div|division|part|unexp(?:ired)?|term)\b/i;
  return OFFICE_WORDS.test(dash[1]) ? null : slug(dash[1]);
}



/// A contest whose options are Yes/No rather than people. Detected from the
/// OPTION NAMES, which is a structural fact about the contest, never from the
/// wording of its title — "Cookeville Annexation" is a measure because its
/// choices are For and Against, not because of the word "annexation".
function isBallotMeasure(contest: EssContest): boolean {
  const options = contest.candidates
    .map((c) => c.name.trim().toLowerCase())
    .filter((n) => n !== "write-in");
  if (options.length < 2) return false;
  return options.every((n) => /^(yes|no|for|against|approve|reject|retain|replace)\b/.test(n));
}

/// The places a report names EXPLICITLY, as slugs — every contest in it that
/// carries a "City of X" / "Town of X" / "…-X" marker.
///
/// This is the evidence base for reading the bare-city dialect (below). It is
/// deliberately derived from what a county published rather than from any list
/// of Tennessee municipalities: the claim "Murfreesboro is a city in this
/// county" is then something the county itself said, in its own results, not
/// something we assumed.
export function explicitPlacesIn(report: EssReport): string[] {
  const places = new Set<string>();
  for (const contest of report.contests) {
    const place = explicitCityIn(contest.office);
    if (place) places.add(place);
  }
  return [...places];
}

const escapeRegex = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/// A place slug as it might be printed: "s-carthage" also matches
/// "S. Carthage" and "S Carthage", because the slug came from one of those
/// spellings and the bare dialect may use another.
function placePattern(slug: string): RegExp {
  return new RegExp(`\\b${slug.split("-").map(escapeRegex).join("[\\s.-]*")}\\b`, "i");
}

/// The bare-city dialect: "Murfreesboro Mayor", "Smyrna Town Court Clerk",
/// "Councilman Eagleville Unexpired Term" — a place name with no City/Town
/// marker at all, which no pattern can distinguish from an office word.
///
/// Resolved only against places the SAME COUNTY has explicitly published
/// elsewhere. That is what keeps this from being a guess: we are not
/// inferring that Murfreesboro is a city because it sits before the word
/// "Mayor", we are recognising a name Rutherford County itself printed as
/// "City of Murfreesboro" in another election.
///
/// Longest first, so a place whose name contains another's cannot shadow it.
function barePlaceIn(office: string, knownPlaces: Iterable<string>): string | null {
  const sorted = [...knownPlaces].sort((a, b) => b.length - a.length);
  for (const slug of sorted) {
    if (placePattern(slug).test(office)) return slug;
  }
  return null;
}

/// Standard place-name abbreviations, expanded ONLY when the county itself
/// published the fuller spelling.
///
/// Smith County's August 2026 report prints both "Town Of South Carthage" and
/// "Town-S.Carthage" — the same town, two spellings, in one file — which
/// otherwise renders as two places on the county page. The rule is not "S
/// means South": it is "this county wrote both, so they are the same place".
/// Where only the abbreviation appears, it is left exactly as published,
/// because nothing has told us what it stands for.
const PLACE_ABBREVIATIONS: [RegExp, string][] = [
  [/^s-/, "south-"],
  [/^n-/, "north-"],
  [/^e-/, "east-"],
  [/^w-/, "west-"],
  [/^mt-/, "mount-"],
  [/^ft-/, "fort-"],
  [/^st-/, "saint-"],
];

function canonicalPlace(slug: string, knownPlaces: Iterable<string>): string {
  const known = new Set(knownPlaces);
  for (const [pattern, expansion] of PLACE_ABBREVIATIONS) {
    if (!pattern.test(slug)) continue;
    const expanded = slug.replace(pattern, expansion);
    if (known.has(expanded)) return expanded;
  }
  return slug;
}

/// Knox appends the ballot section to every office — "County Commission
/// At-Large, Seat 10 - General", "Governor - Republican Party". The stage is
/// already known from elsewhere (the PDF parser holds back every primary block
/// it cannot attribute, and the HTML export puts the party in a PREFIX), so
/// here the suffix is only noise in front of the office name.
const BALLOT_SECTION_SUFFIX = /\s*[-–]\s*(General|Republican Party|Democratic Party)\s*$/i;

export function classifyEssContest(
  contest: EssContest,
  countySlug: string,
  /// Places this county has explicitly published elsewhere. Supplied by the
  /// sync, which unions the current report's own markers with every place
  /// already stored for the county — so the set grows as more of a county's
  /// archive is ingested, and an earlier report becomes readable once a
  /// later one has named its towns.
  knownPlaces: Iterable<string> = [],
): EssClassification | null {
  const name = contest.office.trim().replace(BALLOT_SECTION_SUFFIX, "").trim();
  const at = (office: string, suffix: string): EssClassification => ({
    office,
    district: `${countySlug}/${suffix}`,
    seats: contest.seats,
  });

  // --- county government -------------------------------------------------
  // Ballot measures first: they are identified by their options, and their
  // titles look like nothing else in the vocabulary.
  if (isBallotMeasure(contest)) {
    return at("COUNTY_BALLOT_MEASURE", `measure/${slug(name).slice(0, 60) || "unnamed"}`);
  }

  // "District" is abbreviated "Dist" in some cycles, and county commission
  // seats are variously "County Commission", "County Commissioner".
  //
  // A LETTERED SEAT IS ITS OWN SEAT. Sevier elects "County Commissioner
  // District 1, Seat A" AND "Seat B" — two distinct races on the same ballot.
  // Dropping the letter merges them onto one key, and the second one's results
  // silently replace the first's. Nothing errors; one race simply disappears.
  let m = name.match(/^County Commission(?:er)?\s+Dist(?:rict)?\.?\s+(\d+)\s*,?\s*Seat\s+([A-Z0-9]+)/i);
  if (m) return at("COUNTY_COMMISSION", `district-${pad2(m[1])}-seat-${m[2].toLowerCase()}`);

  m = name.match(/^County Commission(?:er)?\s+Dist(?:rict)?\.?\s+(\d+)/i);
  if (m) return at("COUNTY_COMMISSION", `district-${pad2(m[1])}`);

  // "At-Large, Seat N" is a countywide commission seat rather than a district
  // one — Knox elects both — so it keeps its own seat key instead of being
  // filed as district N and colliding with the real district N.
  m = name.match(/^County Commission(?:er)?\s+At[- ]Large,?\s*Seat\s+(\d+)/i);
  if (m) return at("COUNTY_COMMISSION", `at-large-seat-${pad2(m[1])}`);

  // County school boards are districted or zoned depending on the county;
  // both are the same office, so the seat carries the difference. Knox calls
  // it the Board of Education. And a lettered seat is its own seat here too:
  // Loudon elects "County School Board District 2, Seat A" AND "Seat B" —
  // dropping the letter merges two races onto one key, the same silent loss
  // the commission rule above guards against.
  m = name.match(/^(?:County\s+)?(?:School Board|Board of Education)(?:\s+Member)?\s+(Dist(?:rict)?|Zone)\.?\s+(\d+)\s*,?\s*Seat\s+([A-Z0-9]+)/i);
  if (m) {
    const kind = /^zone/i.test(m[1]) ? "zone" : "district";
    return at("COUNTY_SCHOOL_BOARD", `${kind}-${pad2(m[2])}-seat-${m[3].toLowerCase()}`);
  }
  m = name.match(/^(?:County\s+)?(?:School Board|Board of Education)(?:\s+Member)?\s+(Dist(?:rict)?|Zone)\.?\s+(\d+)/i);
  if (m) {
    const kind = /^zone/i.test(m[1]) ? "zone" : "district";
    return at("COUNTY_SCHOOL_BOARD", `${kind}-${pad2(m[2])}`);
  }

  // Roads: Putnam elects a single Road Supervisor, Rutherford a zoned Road
  // Board. One office, two structures, which is exactly what the seat is for.
  m = name.match(/^Road\s+(?:Board|Commission(?:er)?)\s+(?:Zone|Dist(?:rict)?)\.?\s+(\d+)/i);
  if (m) return at("COUNTY_ROAD", `zone-${pad2(m[1])}`);
  // "Road Supervisor", "Road Superintendent", "Superintendent of Roads" — the
  // same countywide office, named three ways across counties.
  if (/^(Road\s+(Supervisor|Superintendent)|Superintendent\s+of\s+Roads?|Road\s+Commissioner)/i.test(name)) {
    return at("COUNTY_ROAD", "countywide");
  }

  // Constables are elected by district, like the county commission — and
  // Sevier elects them in lettered seats, "Constable District 1, Seat A" AND
  // "Seat B". The letter is the third office to need this rule; the sync's
  // collision handler is what caught it, after the merged pair had already
  // cost five rows silently.
  m = name.match(/^Constables?\s+Dist(?:rict)?\.?\s+(\d+)\s*,?\s*Seat\s+([A-Z0-9]+)/i);
  if (m) return at("COUNTY_CONSTABLE", `district-${pad2(m[1])}-seat-${m[2].toLowerCase()}`);
  m = name.match(/^Constables?\s+Dist(?:rict)?\.?\s+(\d+)/i);
  if (m) return at("COUNTY_CONSTABLE", `district-${pad2(m[1])}`);
  if (/^Constables?\b/i.test(name)) return at("COUNTY_CONSTABLE", "countywide");

  // A combined clerkship — Knox's "Circuit, Civil Sessions and Juvenile Court
  // Clerk" — is ONE elected office serving several courts, so the seat is
  // built from all of them rather than from whichever is printed first.
  m = name.match(/^((?:Circuit|Criminal|Juvenile|Probate|Chancery|Civil Sessions|General Sessions)(?:\s*,\s*|\s+and\s+|\s*&\s*)?)+\s*Court Clerk/i);
  if (m) {
    const courts = [...name.matchAll(/(Circuit|Criminal|Juvenile|Probate|Chancery|Civil Sessions|General Sessions)/gi)]
      .map((c) => c[1].toLowerCase().replace(/\s+/g, "-"));
    return at("COUNTY_COURT_CLERK", `${[...new Set(courts)].join("-")}-court`);
  }

  // "General Sessions" is abbreviated "Gen Sessions", divisions are numbered in
  // arabic or roman, and a vacancy is marked "Unexp". Montgomery prints the
  // combined bench as "Gen Sessions-Juv Ct Judge Div V Unexp" — one seat, one
  // office, and emphatically not a town called "Juv Ct Judge Div V Unexp".
  if (/^Gen(?:eral)?\s+Sessions/i.test(name)) {
    const division = name.match(/\b(?:Div(?:ision)?|Part)\.?\s+([IVXLC]+|\d+)\b/i);
    const unexpired = /\bunexp(?:ired)?\b/i.test(name);
    const seat = [
      division ? `division-${division[1].toLowerCase()}` : "countywide",
      unexpired ? "unexpired-term" : null,
    ]
      .filter(Boolean)
      .join("/");
    return at("COUNTY_GENERAL_SESSIONS_JUDGE", seat);
  }

  // Elected by the county, unlike the circuit/chancery/criminal benches, which
  // are judicial-district offices spanning several counties and are held back
  // above. Checked before the city branch so a place name can never claim it.
  if (/^Juv(?:enile)?\s+(?:Court|Ct)\s+Judge/i.test(name)) {
    const division = name.match(/\b(?:Div(?:ision)?|Part)\.?\s+([IVXLC]+|\d+)\b/i);
    const unexpired = /\bunexp(?:ired)?\b/i.test(name);
    const seat = [
      division ? `division-${division[1].toLowerCase()}` : "countywide",
      unexpired ? "unexpired-term" : null,
    ]
      .filter(Boolean)
      .join("/");
    return at("COUNTY_JUVENILE_COURT_JUDGE", seat);
  }

  // --- cities and towns --------------------------------------------------
  // Checked BEFORE the countywide table below, because "Mayor City of
  // Murfreesboro" and "County Mayor" both contain "Mayor", and
  // "Town Court Clerk Town of Smyrna" contains "Court Clerk".
  const found = cityIn(name) ?? barePlaceIn(name, knownPlaces);
  const city = found ? canonicalPlace(found, knownPlaces) : null;
  if (city) {
    const ward = name.match(/\bWard\s+(\d+)/i);
    /// A special election to fill a vacancy is a DIFFERENT seat from the
    /// regular one, and both can appear on the same ballot — Eagleville
    /// elected a councilman and a councilman-unexpired-term in 2022. Without
    /// this they collide on one contest key and two races merge into one.
    const unexpired = /\bunexpired\s+term\b/i.test(name);
    const seat = [city, ward ? `ward-${pad2(ward[1])}` : null, unexpired ? "unexpired-term" : null]
      .filter(Boolean)
      .join("/");
    // NOT anchored to the start of the string. The office can lead ("Mayor
    // City of Murfreesboro", 2026) or trail ("City of Murfreesboro Mayor",
    // 2022), and anchoring silently drops one of the two dialects. Safe to
    // leave open here because this branch only runs once a city was found,
    // and a countywide office never carries "City of" / "Town of".
    if (/\bMayor\b/i.test(name)) return at("MUNICIPAL_MAYOR", seat);
    if (/\b(Alderman|Council\s*man|Council\s*members?|Council\s*woman|Commissioner)s?\b/i.test(name)) {
      return at("MUNICIPAL_COUNCIL", seat);
    }
    if (/School\s*Board|\bSB\b/i.test(name)) return at("MUNICIPAL_SCHOOL_BOARD", seat);
    if (/Court\s+Clerk/i.test(name)) return at("MUNICIPAL_COURT_CLERK", seat);
    if (/Judge/i.test(name)) return at("MUNICIPAL_JUDGE", seat);
  }

  // --- countywide single seats -------------------------------------------
  const countywide: [RegExp, string][] = [
    // "County Executive" is Tennessee's statutory title for the same office
    // before the 2003 rename, and some counties still publish it that way —
    // Tipton in 2026. Mapped to one office (Tim, 2026-08-13) so a county's top
    // job compares across counties instead of splitting into two headings.
    [/^County (Mayor|Executive)/i, "COUNTY_MAYOR"],
    [/^Sheriff/i, "COUNTY_SHERIFF"],
    [/^(?:County\s+)?Trustee/i, "COUNTY_TRUSTEE"],
    [/^Assessor of Property/i, "COUNTY_ASSESSOR"],
    [/^Register Of Deeds/i, "COUNTY_REGISTER_OF_DEEDS"],
    [/^(?:County\s+)?Assessor/i, "COUNTY_ASSESSOR"],
    [/^County Clerk/i, "COUNTY_CLERK"],
  ];
  for (const [pattern, office] of countywide) {
    if (pattern.test(name)) return at(office, "countywide");
  }

  return null;
}
