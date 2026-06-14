# City Pulse

> **Live demo:** <https://sumitjindal1100-ui.github.io/city-pulse/> · One of seven projects in my portfolio: <https://sumitjindal1100-ui.github.io/>

**Live Public Transit + 311 Service-Request Analytics Dashboard.**
A real, hourly-updating, zero-cost ops command center for a real city's open data,
framed as a Systems Analyst / Business Analyst portfolio piece.

> Most portfolio projects use static Kaggle CSVs. This one pulls live municipal data
> every hour from a public API and presents it as an interactive city operations
> command center — process diagnostics included.

![status](https://img.shields.io/badge/data-live-22d3ee?style=flat-square)
![pipeline](https://img.shields.io/badge/refresh-hourly-60a5fa?style=flat-square)
![cost](https://img.shields.io/badge/infra%20cost-%240-34d399?style=flat-square)

---

## What you get

- **Live KPIs** — total / open / closed / SLA breaches / p50 / p90 cycle times against your own SLA target.
- **Live incident map** (Leaflet) — circle markers colored by status and age; click any to see the full ticket. Heatmap toggle. Borough filter by clicking the bar chart.
- **Live ticker** — newest first, with breach/warn coloring.
- **Six analytics panels** — by borough, top 10 complaint types, intake-by-hour, channel mix doughnut, cycle-time histogram.
- **SA Process Map** — auto-generated BPMN-style swimlane of the 311 lifecycle, with **measured** cycle times at each stage and a bottleneck ranking computed from the live snapshot.
- **What-If Simulator** — pick borough + complaint type, get the empirical p50/p90/avg resolution time from the live data, with a verdict against your SLA.
- **BRD (BA framing)** — auto-populated Business Requirements Document for an auto-routing improvement, with quantified expected impact pulled from the live numbers. Print to PDF in one click.
- **Customization drawer** — 4 themes (Ops dark, Amber CRT, Mint matrix, Daylight), 2 densities, auto-refresh interval, default borough filter, SLA target hours, map tile style. Settings persist via `localStorage`.

## Why this is different

| Most portfolios | City Pulse |
|---|---|
| Static CSV | Live API, hourly snapshot |
| Cleaned demo data | Real government operational data |
| Charts only | Charts + process map + BRD + simulator |
| "Project" framing | "Systems Analyst monitoring a real public service" framing |
| Hidden in a repo | Permanent public URL, recruiter-clickable |

## Architecture (zero cost)

```
+--------------------------+        +-----------------------------+
|  NYC Open Data Socrata   |        |  GitHub Actions (cron)      |
|  311 Service Requests    | -----> |  hourly: node fetch-data.js |
+--------------------------+        |  commits data/latest.json   |
                                    +--------------+--------------+
                                                   |
                                                   v
                                    +-----------------------------+
                                    |  GitHub Pages (static site) |
                                    |  index.html + app.js        |
                                    |  Chart.js + Leaflet         |
                                    +-----------------------------+
```

- **Data:** NYC Open Data — *311 Service Requests* (Socrata API, no auth required for low volume).
- **Pipeline:** Node.js script on a GitHub Actions cron (every hour) → commits `data/latest.json`.
- **Frontend:** Vanilla HTML / CSS / JS, Leaflet for the map, Chart.js for the charts. No framework, no build step.
- **Hosting:** GitHub Pages — permanent URL, free, HTTPS.
- **Cost:** $0/month — no backend, no database, no auth.

## Local development

```bash
# 1. Generate a snapshot (writes data/latest.json)
node scripts/fetch-data.js

# 2. Serve the directory on any static server
npx http-server . -p 8080
#   or: python -m http.server 8080

# 3. Open http://localhost:8080
```

## Customization

Click the gear icon in the top-right. Settings persist in `localStorage`.

| Setting | Options |
|---|---|
| Theme | Ops dark · Amber CRT · Mint matrix · Daylight |
| Density | Comfortable · Compact |
| Auto-refresh | Off · 1m · 5m · 15m |
| Default borough filter | All / Manhattan / Brooklyn / Queens / Bronx / Staten Island |
| SLA target | Any value in hours (default 72) |
| Map tiles | Dark / OpenStreetMap / Positron |

## Pointing at another city

Replace the Socrata URL in [`scripts/fetch-data.js`](scripts/fetch-data.js) with your city's open-data endpoint
(Toronto, Halifax, Chicago, Boston, San Francisco all publish similar feeds). The `compactRow` and `summarize` functions
only need the eight common fields (`borough/area`, `complaint_type`, `created_date`, `closed_date`, `status`, `latitude`, `longitude`, `agency`) — rename to taste.

## What this demonstrates

- **Live external systems integration** — not just clean datasets.
- **Process thinking applied to real operations** — measured cycle times feed a BPMN-style diagram.
- **SQL/data + BPMN + BRD + frontend** — the whole BA/SA skill stack in one artifact.
- **Engineering maturity** — scheduled pipeline, idempotent commits, concurrency control, theming, persistence.

## License

MIT — see [LICENSE](LICENSE).

## Data source

NYC Open Data · [311 Service Requests from 2010 to Present](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9).
