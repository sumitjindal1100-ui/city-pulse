#!/usr/bin/env node
/**
 * City Pulse — live data fetcher.
 * Pulls latest NYC 311 Service Requests + Open Transit feed,
 * computes analytics, and writes data/latest.json.
 * Runs locally and on GitHub Actions cron.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'data');
const OUT_FILE = path.join(OUT_DIR, 'latest.json');
const HISTORY_FILE = path.join(OUT_DIR, 'history.json');

const NYC_311_URL =
  'https://data.cityofnewyork.us/resource/erm2-nwe9.json' +
  '?$limit=2000' +
  '&$order=created_date%20DESC' +
  '&$where=latitude%20IS%20NOT%20NULL';

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'city-pulse/1.0' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function hoursBetween(a, b) {
  return (new Date(b) - new Date(a)) / 36e5;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}

function summarize(rows) {
  const now = new Date();
  const total = rows.length;
  const open = rows.filter((r) => r.status && !/closed/i.test(r.status)).length;
  const closed = total - open;

  const byBorough = {};
  const byType = {};
  const byAgency = {};
  const byHour = Array(24).fill(0);
  const byChannel = {};
  const slaHours = 72; // 3-day SLA target

  const resolutionHours = [];
  let slaBreaches = 0;

  for (const r of rows) {
    const b = (r.borough || 'UNKNOWN').toUpperCase();
    byBorough[b] = (byBorough[b] || 0) + 1;
    if (r.complaint_type) byType[r.complaint_type] = (byType[r.complaint_type] || 0) + 1;
    if (r.agency) byAgency[r.agency] = (byAgency[r.agency] || 0) + 1;
    if (r.open_data_channel_type)
      byChannel[r.open_data_channel_type] = (byChannel[r.open_data_channel_type] || 0) + 1;

    if (r.created_date) {
      const h = new Date(r.created_date).getUTCHours();
      byHour[h]++;
    }

    if (r.created_date && r.closed_date) {
      const dh = hoursBetween(r.created_date, r.closed_date);
      if (dh >= 0 && dh < 24 * 90) {
        resolutionHours.push(dh);
        if (dh > slaHours) slaBreaches++;
      }
    } else if (r.created_date && /open|progress|pending/i.test(r.status || '')) {
      const age = hoursBetween(r.created_date, now);
      if (age > slaHours) slaBreaches++;
    }
  }

  const cycleStats = {
    p50: +percentile(resolutionHours, 50).toFixed(2),
    p75: +percentile(resolutionHours, 75).toFixed(2),
    p90: +percentile(resolutionHours, 90).toFixed(2),
    p95: +percentile(resolutionHours, 95).toFixed(2),
    avg:
      resolutionHours.length > 0
        ? +(
            resolutionHours.reduce((a, b) => a + b, 0) / resolutionHours.length
          ).toFixed(2)
        : 0,
    samples: resolutionHours.length,
  };

  // Per-(borough, type) percentile table for the "What-if" simulator.
  const buckets = {};
  for (const r of rows) {
    if (!r.created_date || !r.closed_date) continue;
    const dh = hoursBetween(r.created_date, r.closed_date);
    if (dh < 0 || dh > 24 * 90) continue;
    const key = `${(r.borough || 'UNKNOWN').toUpperCase()}|${r.complaint_type || 'Other'}`;
    (buckets[key] = buckets[key] || []).push(dh);
  }
  const whatIf = {};
  for (const k of Object.keys(buckets)) {
    const a = buckets[k];
    if (a.length < 3) continue;
    whatIf[k] = {
      n: a.length,
      p50: +percentile(a, 50).toFixed(1),
      p90: +percentile(a, 90).toFixed(1),
      avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1),
    };
  }

  return {
    total,
    open,
    closed,
    slaBreaches,
    slaBreachRate: total > 0 ? +((slaBreaches / total) * 100).toFixed(1) : 0,
    byBorough,
    byType,
    byAgency,
    byChannel,
    byHour,
    cycleStats,
    whatIf,
  };
}

function compactRow(r) {
  return {
    id: r.unique_key,
    created: r.created_date,
    closed: r.closed_date || null,
    type: r.complaint_type,
    desc: r.descriptor,
    agency: r.agency,
    borough: (r.borough || 'UNKNOWN').toUpperCase(),
    status: r.status,
    channel: r.open_data_channel_type,
    zip: r.incident_zip,
    address: r.incident_address,
    lat: r.latitude ? +r.latitude : null,
    lon: r.longitude ? +r.longitude : null,
  };
}

async function main() {
  console.log('Fetching NYC 311 live data...');
  let raw;
  try {
    raw = await get(NYC_311_URL);
  } catch (e) {
    console.error('Fetch failed:', e.message);
    process.exit(1);
  }
  console.log('Records fetched:', raw.length);

  const rows = raw.map(compactRow).filter((r) => r.lat && r.lon);
  const summary = summarize(raw);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: 'NYC Open Data — 311 Service Requests (Socrata)',
    sourceUrl: 'https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9',
    city: 'New York City',
    summary,
    records: rows,
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(snapshot));

  // Append a trimmed history point for trend lines.
  let history = [];
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch {}
  }
  history.push({
    t: snapshot.generatedAt,
    total: summary.total,
    open: summary.open,
    closed: summary.closed,
    slaBreaches: summary.slaBreaches,
    slaBreachRate: summary.slaBreachRate,
    p50: summary.cycleStats.p50,
    p90: summary.cycleStats.p90,
  });
  history = history.slice(-200);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));

  console.log('Wrote', OUT_FILE, '— records:', rows.length);
}

main();
