
/// TS port of scripts/lib/tn-elections-scrape.mjs — the parse core for
/// elections.tn.gov's Election Night Reporting Dashboard (server-rendered
/// `chart-container` blocks with a `data-candidates` JSON attribute per
/// race). The CLI scrape scripts remain the manual escape hatch; this copy
/// feeds the scheduled results sync (docs/ELECTION_RESULTS_AUTOMATION.md).

/// The results dashboard blocks non-browser User-Agents (plain fetch gets
/// a 403), so the sync identifies as a browser. One request at a time,
/// never parallel — politeness to a state server.
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const RACE_BLOCK_REGEX = /data-race="([^"]+)"\s+id="[^"]*"\s+data-candidates="([^"]*)"/g;

export type RaceCandidate = { name: string; votes: number };

export type ExtractedRace<T> = T & {
  raceId: string;
  candidates: RaceCandidate[];
  reportingProgress: string | null;
  /// The source's own link to this race's per-county breakdown. Captured
  /// rather than reconstructed: the URL spells a race differently from its
  /// race id, so building it by hand would break quietly.
  countyBreakdownPath: string | null;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/// Both of these read the slice from a race block to the next one, so a
/// value can never be picked up from a neighbouring race.
function sliceForRace(html: string, fromIndex: number): string {
  const nextBlockStart = html.indexOf("chart-container", fromIndex + 1);
  return html.slice(fromIndex, nextBlockStart === -1 ? html.length : nextBlockStart);
}

function extractCountyBreakdownPath(html: string, fromIndex: number): string | null {
  const match = sliceForRace(html, fromIndex).match(/href="(\/county-breakdown\/[^"]+)"/);
  return match ? match[1] : null;
}

function extractReportingProgress(html: string, fromIndex: number): string | null {
  const nextBlockStart = html.indexOf("chart-container", fromIndex + 1);
  const searchEnd = nextBlockStart === -1 ? html.length : nextBlockStart;
  const slice = html.slice(fromIndex, searchEnd);
  const match = slice.match(/county-reporting-header-text"[^>]*>\s*([^<]+?)\s*</);
  return match ? match[1].trim() : null;
}

export function isUnqualifiedPlaceholder(candidates: RaceCandidate[]): boolean {
  return candidates.length === 1 && /^No .+ Candidate Qualified$/.test(candidates[0].name);
}

/// Extracts every `chart-container` race block. `parseRaceId` returns null
/// to skip a race, or an object describing it that merges onto the entry.
export function extractRaces<T>(
  html: string,
  parseRaceId: (raceId: string) => T | null,
): ExtractedRace<T>[] {
  const races: ExtractedRace<T>[] = [];
  let match: RegExpExecArray | null;
  while ((match = RACE_BLOCK_REGEX.exec(html)) !== null) {
    const [, raceId, candidatesRaw] = match;
    const parsed = parseRaceId(raceId);
    if (!parsed) {
      continue;
    }

    let rawCandidates: { name: string; votes: number }[];
    try {
      rawCandidates = JSON.parse(decodeHtmlEntities(candidatesRaw));
    } catch (error) {
      throw new Error(
        `Failed to parse candidates JSON for race "${raceId}": ${error instanceof Error ? error.message : error}`,
      );
    }

    races.push({
      ...parsed,
      raceId,
      candidates: rawCandidates.map((candidate) => ({ name: candidate.name, votes: candidate.votes })),
      reportingProgress: extractReportingProgress(html, match.index),
      countyBreakdownPath: extractCountyBreakdownPath(html, match.index),
    });
  }
  return races;
}

/// Retention elections — appellate judges — are a different ballot
/// question and a different shape in the markup: a
/// `judicial-retention-chart-container`, `data-candidates` in SINGLE
/// quotes, and retain/replace counts instead of votes. The main block
/// regex cannot match them, which is why four appellate races were
/// invisible even after the judicial page was added.
const RETENTION_BLOCK_REGEX =
  /data-race="([^"]+)"\s+id="[^"]*"\s+data-candidates='([^']*)'/g;

export type RetentionCandidate = { name: string; retainVotes: number; replaceVotes: number };

export type ExtractedRetentionRace = {
  raceId: string;
  candidates: RetentionCandidate[];
  reportingProgress: string | null;
  countyBreakdownPath: string | null;
};

export function extractRetentionRaces(html: string): ExtractedRetentionRace[] {
  const races: ExtractedRetentionRace[] = [];
  const pattern = new RegExp(RETENTION_BLOCK_REGEX.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const [, raceId, candidatesRaw] = match;
    let raw: { name: string; retainVotes: number; replaceVotes: number }[];
    try {
      raw = JSON.parse(decodeHtmlEntities(candidatesRaw));
    } catch (error) {
      throw new Error(
        `Failed to parse retention candidates for race "${raceId}": ${error instanceof Error ? error.message : error}`,
      );
    }
    races.push({
      raceId,
      candidates: raw.map((candidate) => ({
        name: candidate.name,
        retainVotes: candidate.retainVotes,
        replaceVotes: candidate.replaceVotes,
      })),
      reportingProgress: extractReportingProgress(html, match.index),
      countyBreakdownPath: extractCountyBreakdownPath(html, match.index),
    });
  }
  return races;
}

/// Every race id on a page, whatever its markup shape. Deliberately the
/// LOOSEST possible match — one attribute, no assumptions about ordering,
/// quoting or container class — because this is the inventory the sync
/// checks itself against. An earlier version reused the strict block
/// regex, which meant it was blind to exactly the races it existed to
/// catch: it reported "nothing missing" while four appellate retention
/// races were being dropped.
export function extractAllRaceIds(html: string): string[] {
  const ids: string[] = [];
  const pattern = /data-race="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/// Every `/categories/<slug>/offices` link the dashboard's own front page
/// carries — pure, so it can be checked against a captured page without a
/// fetch (S1 item 5c, `p10-upcoming-general`).
///
/// WHY THIS EXISTS
///
/// `election-results-sync.ts` fetches five hardcoded category URLs and its
/// own comment claimed "the sync now fails if a sixth appears" — checked
/// directly, 2026-08-24, and that claim was false: nothing in the sync ever
/// read the site's own category list, so a sixth category (the state adding
/// a constitutional-amendment or referendum category for the November
/// general, which the DoR names as the open risk) would simply never be
/// fetched, with no error, no log line, nothing. `assertKnownCategories`
/// below diffs this against the five known slugs and throws, naming exactly
/// what changed, rather than silently missing a race category the way
/// judicial and State Executive Committee were missed until Aug 2026 (see
/// extractAllRaceIds's own doc comment for that precedent).
export function categoriesLinkedIn(html: string): string[] {
  const slugs = new Set<string>();
  for (const m of html.matchAll(/href="\/categories\/([a-z-]+)\/offices"/g)) {
    slugs.add(m[1]);
  }
  return [...slugs].sort();
}

/// Every category the state's dashboard published as of 2026-08-24 —
/// re-confirmed live the day this was written (the dashboard's own root
/// redirects to /categories/governor/offices, and that page's nav still
/// names exactly these five). Kept beside `categoriesLinkedIn` rather than
/// in election-results-sync.ts so a plain-node `verify:*` script can import
/// both without pulling in Prisma.
export const KNOWN_CATEGORY_SLUGS = [
  "congressional",
  "general-assembly",
  "governor",
  "judicial",
  "state-executive-committee",
] as const;

/// WHAT THE DASHBOARD IS DOING RIGHT NOW — three states, told apart by a
/// POSITIVE signal rather than by absence.
///
/// Measured 2026-09-08, after `/api/cron/election-results-sync` had failed
/// 24 of 24 attempts a day and 156 times since 2026-08-17. The fetch was
/// fine (200, 9,528 bytes, no redirect). The categories had not been
/// renamed — the dashboard had been EMPTIED between elections. Its whole
/// `<main>` is now one `empty-chart` block reading "Official election
/// results for past elections can be found here", linking to
/// sos.tn.gov/elections/results, with `id="electionTitle"` present and
/// blank.
///
/// The old `assertKnownCategories` could not express that. It diffed the
/// nav against a closed allow-list and threw on ANY difference, so an
/// ordinary between-elections state and a genuine schema change produced
/// the identical fatal error — and the run died before it could say which.
///
/// ⚠️ `between-elections` is asserted, never inferred. Zero categories on
/// its own is NOT enough: this repo's own rule is that an empty result is
/// not evidence of absence until you know the command could have shown it,
/// and a fetch that returns a login page also has zero categories. The
/// empty-chart marker must be positively present, or the state is
/// `unrecognised` and the caller refuses.
export type DashboardState = "live" | "between-elections" | "unrecognised";

/// Byte-exact from the 2026-09-08 capture. Two markers, both required.
const EMPTY_CHART_MARKERS = ['class="empty-chart"', "empty-chart-message"] as const;

export function dashboardStateIn(html: string): DashboardState {
  if (categoriesLinkedIn(html).length > 0) return "live";
  const empty = EMPTY_CHART_MARKERS.every((marker) => html.includes(marker));
  return empty ? "between-elections" : "unrecognised";
}

/// The open default that replaces the closed allow-list.
///
/// A closed allow-list is the wrong shape here for the same reason the
/// every-party rule rejects a closed party enumeration: it fails whenever
/// the source adds or renames anything, and one unknown category takes down
/// the four we can read perfectly well. The correct shape is an open
/// default with an explicit absent list.
///
/// ⚠️ What does NOT change: an unknown category is still never parsed. Its
/// race-id shape is unknown, and guessing it is what "never guess a number"
/// forbids. It is reported as a finding so a person adds a parser
/// deliberately — the difference is that the other categories keep syncing
/// while that happens, instead of the whole run dying.
export type CategoryPlan = {
  /// Categories the page lists AND we have a parser for. Fetch these.
  parseable: string[];
  /// Categories the page lists that we cannot read. Reported, never guessed.
  unknown: string[];
  /// Categories we know about that the page no longer lists. Reported.
  absent: string[];
};

export function categoryPlan(html: string): CategoryPlan {
  const live = categoriesLinkedIn(html);
  const known: readonly string[] = KNOWN_CATEGORY_SLUGS;
  return {
    parseable: live.filter((slug) => known.includes(slug)),
    unknown: live.filter((slug) => !known.includes(slug)),
    absent: known.filter((slug) => !live.includes(slug)),
  };
}

/// The page's OWN election title — e.g. "August 6th, 2026 Unofficial
/// Election Results" (real, captured 2026-08-24, `id="electionTitle"` on
/// every category page). Pure, so it can be checked against a captured page
/// without a fetch.
export function electionTitleIn(html: string): string | null {
  const m = html.match(/id="electionTitle">\s*([^<]*?)\s*<\/h1>/);
  return m ? m[1] : null;
}

/// S1 item 5c (`p10-upcoming-general`)'s other confirmed, load-bearing risk:
/// `election-results-sync.ts` hardcodes `ELECTION_DATE = 2026-08-06` and
/// `STAGE = "PRIMARY"` — its own comment already says why ("When the SoS
/// flips the dashboard to the general, this becomes a mapping keyed off the
/// page content — for now one constant"). Checked directly, 2026-08-24: the
/// dashboard still serves the August primary, so there is no live page to
/// design the general's actual mapping against yet, and guessing its shape
/// is exactly what "never guess" forbids. What CAN ship today: the page
/// states its own election in `electionTitleIn` above, so this asserts that
/// title still contains the expected constant's own date string, and throws
/// BEFORE inserting a single row if it does not — the fail-closed-but-wrong
/// mislabelling this DoR item is named for (November's real results tagged
/// electionDate 2026-08-06 / stage PRIMARY, silently) becomes a fail-loud
/// refusal instead. `expectedDateText` is the constant's own date, spelled
/// exactly as the page would print it, never derived by guessing a format.
export function assertPageMatchesExpectedElection(html: string, expectedDateText: string): void {
  const title = electionTitleIn(html);
  if (!title) {
    throw new Error(
      `Could not find the page's own election title (id="electionTitle") — the page markup ` +
        `may have changed. Refusing to guess which election this page reports.`,
    );
  }
  if (!title.includes(expectedDateText)) {
    throw new Error(
      `The dashboard's own title ("${title}") no longer names "${expectedDateText}" — the state ` +
        `has likely flipped the dashboard to a different election (most plausibly the November ` +
        `general). ELECTION_DATE/STAGE in election-results-sync.ts are hardcoded and must be ` +
        `updated by a human who has looked at the new page's actual race-id shape before this ` +
        `sync writes another row — refusing rather than silently mislabelling.`,
    );
  }
}

export async function fetchResultsHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/html",
    },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${url}`);
  }
  return response.text();
}
