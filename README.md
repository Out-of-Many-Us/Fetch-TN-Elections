# Fetch-TN-Elections

The fetch tool for Tennessee election results at the county level.

Tennessee's Secretary of State publishes statewide and federal results. It has
never published county commission, school board, sheriff, trustee or any other
county office, so those results live only on the 95 county election commission
sites, in whatever form each county chose.

This is the tool that goes and gets them.

Built by [Out of Many. Us](https://outofmany.us) by Timothy Gaull, to be used by
anyone. The data is free and should stay that way.

---

## Why it runs on your machine and not on a server

Several county servers block cloud fetchers outright — Bradley County's web
application firewall is the documented case. Results that a laptop on a home
connection can fetch without trouble may be permanently unreachable from a
hosted environment.

That is not a limitation of this tool. It is the reason it takes the shape it
does. **Run it from where you are.**

## What you can check without trusting us

Every CSV is a pure function of the bytes in `archive/`.

```
tnlocal fetch  --county rutherford --cycle 2026   # the only step that uses the network
tnlocal parse  --county rutherford                # reads archive/ only
tnlocal verify --county rutherford                # rebuilds from archive/, no network
```

`verify` re-derives every row from the archived source files and requires the
result to match byte for byte. **Change one vote count in an archived file and
`verify` fails.** You do not have to believe anything in this README — you can
check that claim in about five minutes.

Every fetch writes a `MANIFEST.txt` beside the source it saved: the URL, the
time, the HTTP status, the byte count and a SHA-256. The archive is append-only.
Nothing here re-fetches over a file that already exists.

## Method

Every row this tool produces came from a county's own server, through a parser
that imports nothing. No row was exported from a database and reshaped to look
scraped. If a county page is gone, changed, or refuses the request, the run
records a miss and moves on rather than filling the gap from somewhere else.

## The output

```
election_date,primary_party,office_source,candidate,party,votes
2026-05-05,R,County Mayor,Randy Allen,,6844
```

**`office_source` is the office exactly as the county printed it** — *"County
Commission District 01"*, not a code and not split into office and district.
Decomposing it is an interpretation, and yours may differ from ours. The whole
string is here so you can make that call yourself.

**`primary_party` is the county's own field, not a stage we inferred.** Non-empty
means the contest is that party's primary.

### One source document can contain more than one election

This is the thing that will surprise you on your second county. Rutherford's
August 2026 report contains **both** a party primary and a general election in
one file. `election_date` alone is not a key — you need `primary_party` with it.

### It reports what the county published

That includes **write-in rows**, and it includes **state and federal races** the
county printed alongside its local ones. If you are comparing against a source
that carries only local contests, expect a Governor row and know why it is
there. A tool that reports what a county published cannot quietly drop the parts
of it that are inconvenient.

## Coverage, stated plainly

**21 counties are configured. 20 have data.** Haywood County is configured and
has produced nothing — either its source changed or it never fetched
successfully, and that is not yet established. It is listed here rather than
quietly omitted, because a coverage number you find yourself reads as
concealment where one we state reads as what it is.

## Adding a county

The parsers are deliberately dependency-free — no database, no framework, no
environment variables, nothing to configure before a first run. A new county
needs its report URLs and, if it publishes in a format not yet handled, a parser
that takes a string and returns rows.

## Licence

MIT. Use it, fork it, publish what you collect.
