/* City Pulse — dashboard app */
(() => {
  'use strict';

  const STATE = {
    data: null,
    map: null,
    markerLayer: null,
    heatLayer: null,
    tileLayer: null,
    charts: {},
    boroughFilter: 'ALL',
    settings: loadSettings(),
    refreshTimer: null,
  };

  const TILES = {
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      attr: '&copy; OpenStreetMap &copy; CARTO',
    },
    osm: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attr: '&copy; OpenStreetMap',
    },
    positron: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      attr: '&copy; OpenStreetMap &copy; CARTO',
    },
  };

  // ---------------- Settings ----------------
  function loadSettings() {
    try {
      return Object.assign(
        {
          theme: 'ops-dark',
          density: 'comfortable',
          refresh: 0,
          defaultBorough: 'ALL',
          sla: 72,
          tiles: 'dark',
        },
        JSON.parse(localStorage.getItem('cp.settings') || '{}'),
      );
    } catch {
      return { theme: 'ops-dark', density: 'comfortable', refresh: 0, defaultBorough: 'ALL', sla: 72, tiles: 'dark' };
    }
  }
  function saveSettings() {
    localStorage.setItem('cp.settings', JSON.stringify(STATE.settings));
  }
  function applySettingsToDOM() {
    document.body.dataset.theme = STATE.settings.theme;
    document.body.dataset.density = STATE.settings.density;
  }

  // ---------------- Helpers ----------------
  function fmt(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function fmtPct(n) { return (n === null || n === undefined || isNaN(n)) ? '—' : n.toFixed(1) + '%'; }
  function ago(iso) {
    const d = new Date(iso);
    const s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function css(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }

  // ---------------- Load data ----------------
  async function loadData() {
    const res = await fetch('data/latest.json?cb=' + Date.now());
    if (!res.ok) throw new Error('Failed to load data');
    STATE.data = await res.json();
    return STATE.data;
  }

  // ---------------- Render: header ----------------
  function renderHeader() {
    const d = STATE.data;
    document.getElementById('asOf').textContent =
      new Date(d.generatedAt).toLocaleString();
    document.getElementById('cityName').textContent = d.city;
    const link = document.getElementById('sourceLink');
    link.href = d.sourceUrl;
    link.textContent = d.source.split('—')[0].trim();
    document.getElementById('footerStamp').textContent =
      'Snapshot: ' + new Date(d.generatedAt).toISOString();
  }

  // ---------------- Render: KPIs ----------------
  function renderKPIs() {
    const s = STATE.data.summary;
    const sla = STATE.settings.sla;
    const items = [
      { label: 'Total requests', value: fmt(s.total), trend: 'in current snapshot' },
      { label: 'Open', value: fmt(s.open), trend: fmtPct((s.open / s.total) * 100) + ' of total', cls: s.open / s.total > 0.5 ? 'warn' : '' },
      { label: 'Closed', value: fmt(s.closed), trend: fmtPct((s.closed / s.total) * 100) + ' of total', cls: 'ok' },
      { label: 'SLA breaches', value: fmt(s.slaBreaches), trend: 'target ' + sla + 'h', cls: s.slaBreaches > 0 ? 'bad' : 'ok' },
      { label: 'p50 cycle', value: s.cycleStats.p50 + 'h', trend: 'median time to close' },
      { label: 'p90 cycle', value: s.cycleStats.p90 + 'h', trend: 'long-tail signal', cls: s.cycleStats.p90 > sla ? 'bad' : '' },
    ];
    const row = document.getElementById('kpiRow');
    row.innerHTML = items
      .map(
        (i) => `
        <div class="kpi ${i.cls || ''}">
          <div class="kpi-label">${i.label}</div>
          <div class="kpi-value">${i.value}</div>
          <div class="kpi-trend">${i.trend}</div>
        </div>`,
      )
      .join('');
  }

  // ---------------- Map ----------------
  function initMap() {
    if (STATE.map) return;
    const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([40.73, -73.95], 11);
    STATE.tileLayer = L.tileLayer(TILES[STATE.settings.tiles].url, {
      attribution: TILES[STATE.settings.tiles].attr,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);
    STATE.markerLayer = L.layerGroup().addTo(map);
    STATE.map = map;
  }
  function setTiles(key) {
    if (!STATE.map || !STATE.tileLayer) return;
    STATE.map.removeLayer(STATE.tileLayer);
    STATE.tileLayer = L.tileLayer(TILES[key].url, {
      attribution: TILES[key].attr,
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(STATE.map);
  }
  function renderMap() {
    if (!STATE.map) initMap();
    STATE.markerLayer.clearLayers();
    if (STATE.heatLayer) { STATE.map.removeLayer(STATE.heatLayer); STATE.heatLayer = null; }

    const rows = filteredRows();
    const accent = css('--accent') || '#22d3ee';
    const bad = css('--bad') || '#f87171';
    const warn = css('--warn') || '#fbbf24';

    const heatPts = [];
    rows.forEach((r) => {
      if (!r.lat || !r.lon) return;
      const isOpen = r.status && !/closed/i.test(r.status);
      const age = (Date.now() - new Date(r.created).getTime()) / 36e5;
      const breach = isOpen && age > STATE.settings.sla;
      const color = breach ? bad : isOpen ? warn : accent;
      heatPts.push([r.lat, r.lon, breach ? 1 : 0.5]);

      const m = L.circleMarker([r.lat, r.lon], {
        radius: breach ? 7 : 5,
        color,
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.55,
      }).bindPopup(
        `<b>${r.type || 'Unknown'}</b><br/>
         <span>${r.desc || ''}</span><br/>
         <small>${r.borough} · ${r.status}</small><br/>
         <small>${ago(r.created)} · ${r.address || ''}</small>`,
      );
      STATE.markerLayer.addLayer(m);
    });

    const heatOn = document.getElementById('heatToggle').checked;
    if (heatOn && window.L && L.heatLayer) {
      STATE.heatLayer = L.heatLayer(heatPts, { radius: 18, blur: 22, maxZoom: 14 }).addTo(STATE.map);
    }

    document.getElementById('mapCount').textContent =
      rows.length + ' plotted' + (STATE.boroughFilter !== 'ALL' ? ` · ${STATE.boroughFilter}` : '');
  }

  function filteredRows() {
    const rows = STATE.data.records;
    if (STATE.boroughFilter === 'ALL') return rows;
    return rows.filter((r) => r.borough === STATE.boroughFilter);
  }

  // ---------------- Charts ----------------
  function destroyCharts() {
    for (const k of Object.keys(STATE.charts)) {
      try { STATE.charts[k].destroy(); } catch {}
    }
    STATE.charts = {};
  }

  function commonChartOpts() {
    const dim = css('--text-dim') || '#9fb0c8';
    const grid = css('--grid') || 'rgba(120,160,220,0.08)';
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { labels: { color: dim, font: { family: 'Inter', size: 11 } } },
        tooltip: { backgroundColor: '#0b1120', borderColor: 'rgba(120,160,220,0.3)', borderWidth: 1, titleColor: '#fff', bodyColor: '#cbd5e1' },
      },
      scales: {
        x: { ticks: { color: dim, font: { size: 10 } }, grid: { color: grid } },
        y: { ticks: { color: dim, font: { size: 10 } }, grid: { color: grid }, beginAtZero: true },
      },
    };
  }

  function renderCharts() {
    destroyCharts();
    const s = STATE.data.summary;
    const accent = css('--accent') || '#22d3ee';
    const accent2 = css('--accent-2') || '#60a5fa';
    const palette = ['#22d3ee', '#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#94a3b8'];

    // Borough
    const bEntries = Object.entries(s.byBorough).sort((a, b) => b[1] - a[1]);
    STATE.charts.borough = new Chart(document.getElementById('boroughChart'), {
      type: 'bar',
      data: {
        labels: bEntries.map((e) => titleCase(e[0])),
        datasets: [{ data: bEntries.map((e) => e[1]), backgroundColor: accent, borderRadius: 4 }],
      },
      options: Object.assign({}, commonChartOpts(), {
        plugins: { legend: { display: false } },
        onClick: (_, el) => {
          if (!el.length) return;
          const idx = el[0].index;
          const borough = bEntries[idx][0];
          STATE.boroughFilter = STATE.boroughFilter === borough ? 'ALL' : borough;
          renderMap();
          renderTicker();
        },
      }),
    });

    // Top types
    const tEntries = Object.entries(s.byType).sort((a, b) => b[1] - a[1]).slice(0, 10);
    STATE.charts.type = new Chart(document.getElementById('typeChart'), {
      type: 'bar',
      data: {
        labels: tEntries.map((e) => e[0]),
        datasets: [{ data: tEntries.map((e) => e[1]), backgroundColor: accent2, borderRadius: 4 }],
      },
      options: Object.assign({}, commonChartOpts(), { indexAxis: 'y', plugins: { legend: { display: false } } }),
    });

    // Hour
    STATE.charts.hour = new Chart(document.getElementById('hourChart'), {
      type: 'line',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => i + 'h'),
        datasets: [{
          data: s.byHour, borderColor: accent, backgroundColor: 'rgba(34,211,238,0.15)',
          tension: 0.35, fill: true, pointRadius: 0,
        }],
      },
      options: Object.assign({}, commonChartOpts(), { plugins: { legend: { display: false } } }),
    });

    // Channel doughnut
    const cEntries = Object.entries(s.byChannel).sort((a, b) => b[1] - a[1]);
    STATE.charts.channel = new Chart(document.getElementById('channelChart'), {
      type: 'doughnut',
      data: {
        labels: cEntries.map((e) => e[0]),
        datasets: [{ data: cEntries.map((e) => e[1]), backgroundColor: palette, borderWidth: 0 }],
      },
      options: Object.assign({}, commonChartOpts(), { scales: {}, cutout: '60%' }),
    });

    // Cycle distribution histogram
    const rows = STATE.data.records;
    const cycles = [];
    rows.forEach((r) => {
      if (r.created && r.closed) {
        const h = (new Date(r.closed) - new Date(r.created)) / 36e5;
        if (h >= 0 && h < 720) cycles.push(h);
      }
    });
    const buckets = Array(20).fill(0);
    const maxH = 12; // bucket cap at 12h for resolution detail
    cycles.forEach((h) => {
      const b = Math.min(19, Math.floor((h / maxH) * 20));
      buckets[b]++;
    });
    const labels = buckets.map((_, i) => ((i * maxH) / 20).toFixed(1) + 'h');
    STATE.charts.cycle = new Chart(document.getElementById('cycleChart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'tickets',
          data: buckets,
          backgroundColor: accent,
          borderRadius: 3,
        }],
      },
      options: Object.assign({}, commonChartOpts(), {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.parsed.y + ' tickets' } } },
      }),
    });
  }

  function titleCase(s) {
    return s.split(' ').map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');
  }

  // ---------------- Ticker ----------------
  function renderTicker() {
    const ul = document.getElementById('ticker');
    const rows = filteredRows()
      .slice()
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, 25);
    ul.innerHTML = rows
      .map((r) => {
        const isOpen = r.status && !/closed/i.test(r.status);
        const age = (Date.now() - new Date(r.created).getTime()) / 36e5;
        const cls = isOpen && age > STATE.settings.sla ? 'breach' : isOpen && age > STATE.settings.sla / 2 ? 'warn' : '';
        return `
          <li class="${cls}">
            <div class="t-type">${escapeHtml(r.type || 'Unknown')}</div>
            <div class="t-meta">${escapeHtml(r.desc || '')} · ${escapeHtml(r.borough)} · ${escapeHtml(r.status || '')}</div>
            <div class="t-time">${escapeHtml(r.agency || '')} · ${ago(r.created)}</div>
          </li>`;
      })
      .join('');
  }
  function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  // ---------------- BPMN ----------------
  function renderBPMN() {
    const s = STATE.data.summary;
    const sla = STATE.settings.sla;
    const stages = [
      { name: 'Intake', sub: 'Citizen reports via phone / online / mobile', hrs: 0 },
      { name: 'Triage', sub: 'Category + priority assignment', hrs: +(s.cycleStats.p50 * 0.1).toFixed(2) },
      { name: 'Agency Routing', sub: 'Forwarded to responsible agency', hrs: +(s.cycleStats.p50 * 0.25).toFixed(2) },
      { name: 'Field Response', sub: 'Inspection / action', hrs: +(s.cycleStats.p50 * 0.5).toFixed(2) },
      { name: 'Resolution', sub: 'Outcome recorded, ticket closed', hrs: +s.cycleStats.p50.toFixed(2) },
    ];
    const cumP90 = s.cycleStats.p90;
    function statusColor(hrs) {
      if (hrs > sla) return 'bad';
      if (hrs > sla * 0.6) return 'warn';
      return 'ok';
    }

    const W = 1000, H = 220, n = stages.length;
    const gap = (W - 60) / n;
    const boxW = gap - 30, boxH = 90;
    const accent = css('--accent') || '#22d3ee';
    const dim = css('--text-dim') || '#9fb0c8';
    const text = css('--text') || '#e7eef9';
    const ok = css('--ok') || '#34d399';
    const warn = css('--warn') || '#fbbf24';
    const bad = css('--bad') || '#f87171';
    const c = { ok, warn, bad };

    let nodes = '';
    let arrows = '';
    let labels = '';
    stages.forEach((st, i) => {
      const x = 30 + i * gap + 15;
      const y = (H - boxH) / 2;
      const color = c[statusColor(st.hrs)];
      nodes += `
        <g>
          <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="12" fill="rgba(255,255,255,0.02)" stroke="${color}" stroke-width="1.5"/>
          <text x="${x + boxW / 2}" y="${y + 28}" text-anchor="middle" fill="${text}" font-family="Inter, sans-serif" font-size="13" font-weight="600">${st.name}</text>
          <text x="${x + boxW / 2}" y="${y + 50}" text-anchor="middle" fill="${dim}" font-family="Inter, sans-serif" font-size="10">${st.sub}</text>
          <text x="${x + boxW / 2}" y="${y + 75}" text-anchor="middle" fill="${color}" font-family="JetBrains Mono, monospace" font-size="13" font-weight="700">${st.hrs}h</text>
        </g>`;
      if (i < n - 1) {
        const x1 = x + boxW;
        const x2 = 30 + (i + 1) * gap + 15;
        const yMid = H / 2;
        arrows += `
          <line x1="${x1}" y1="${yMid}" x2="${x2 - 8}" y2="${yMid}" stroke="${accent}" stroke-width="1.8" marker-end="url(#arr)"/>`;
      }
    });
    labels += `
      <text x="${W / 2}" y="${H - 6}" text-anchor="middle" fill="${dim}" font-family="Inter, sans-serif" font-size="11">
        Cumulative p50 = ${s.cycleStats.p50}h · p90 = ${cumP90}h · SLA target = ${sla}h
      </text>`;
    document.getElementById('bpmn').innerHTML = `
      <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="${accent}"/>
          </marker>
        </defs>
        ${nodes}
        ${arrows}
        ${labels}
      </svg>`;

    renderBottlenecks();
  }

  function renderBottlenecks() {
    const sla = STATE.settings.sla;
    const wi = STATE.data.summary.whatIf;
    const items = Object.entries(wi)
      .map(([k, v]) => {
        const [b, t] = k.split('|');
        return { borough: b, type: t, ...v };
      })
      .filter((x) => x.n >= 5)
      .sort((a, b) => b.p90 - a.p90)
      .slice(0, 8);

    const wrap = document.getElementById('bottleneck');
    if (!items.length) {
      wrap.innerHTML = '<p class="muted">Insufficient closed-ticket samples to compute per-bucket cycle times.</p>';
      return;
    }
    wrap.innerHTML = items
      .map((i) => {
        const cls = i.p90 > sla ? 'high' : i.p90 > sla * 0.6 ? '' : 'low';
        return `
          <div class="bn-item ${cls}">
            <div class="bn-title">${titleCase(i.borough)} · ${escapeHtml(i.type)}</div>
            <div class="bn-meta">p50 ${i.p50}h · p90 ${i.p90}h · avg ${i.avg}h · n=${i.n} · ${i.p90 > sla ? 'EXCEEDS' : 'within'} SLA</div>
          </div>`;
      })
      .join('');
  }

  // ---------------- Simulator ----------------
  function populateSim() {
    const s = STATE.data.summary;
    const boroughs = Object.keys(s.byBorough);
    const types = Object.keys(s.byType).sort();
    const bSel = document.getElementById('simBorough');
    const tSel = document.getElementById('simType');
    bSel.innerHTML = boroughs.map((b) => `<option value="${b}">${titleCase(b)}</option>`).join('');
    tSel.innerHTML = types.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

    // also populate default-borough picker in settings
    const def = document.getElementById('defaultBorough');
    def.innerHTML = '<option value="ALL">All boroughs</option>' + boroughs.map((b) => `<option value="${b}">${titleCase(b)}</option>`).join('');
    def.value = STATE.settings.defaultBorough;
  }

  function runSim() {
    const b = document.getElementById('simBorough').value;
    const t = document.getElementById('simType').value;
    const key = `${b}|${t}`;
    const wi = STATE.data.summary.whatIf[key];
    const sla = STATE.settings.sla;
    const out = document.getElementById('simResults');
    if (!wi) {
      out.innerHTML = `<p class="muted">Not enough closed-ticket samples for <b>${titleCase(b)} · ${escapeHtml(t)}</b> in this snapshot. Try another combination.</p>`;
      return;
    }
    const fill = Math.min(100, (wi.p50 / sla) * 100);
    const verdict =
      wi.p90 > sla
        ? `<b class="bad">High risk:</b> 10% of similar tickets exceed SLA. Routing optimization recommended.`
        : wi.avg > sla * 0.5
        ? `<b class="warn">Watch:</b> typical cycle time approaches half-SLA — monitor for drift.`
        : `<b class="ok">Healthy:</b> typical cycle time well within SLA target.`;
    out.innerHTML = `
      <h3>Predicted Resolution Time</h3>
      <div class="sim-headline">${wi.p50}h <span style="font-size:14px;color:var(--text-dim);font-family:var(--font)">median</span></div>
      <div class="sim-grid-mini">
        <div class="sim-cell"><div class="sim-cell-lab">p50</div><div class="sim-cell-val">${wi.p50}h</div></div>
        <div class="sim-cell"><div class="sim-cell-lab">p90</div><div class="sim-cell-val">${wi.p90}h</div></div>
        <div class="sim-cell"><div class="sim-cell-lab">avg</div><div class="sim-cell-val">${wi.avg}h</div></div>
        <div class="sim-cell"><div class="sim-cell-lab">samples</div><div class="sim-cell-val">${wi.n}</div></div>
      </div>
      <div class="sim-bar"><div class="sim-bar-fill" style="width:${fill}%"></div></div>
      <div class="sim-verdict">${verdict}</div>
      <p class="muted" style="margin-top:14px;font-size:11.5px;">
        Method: empirical percentiles from <code>${wi.n}</code> recently-closed tickets in
        <b>${titleCase(b)} · ${escapeHtml(t)}</b>. No model assumptions — direct from live snapshot.
      </p>`;
  }

  // ---------------- BRD ----------------
  function renderBRD() {
    const s = STATE.data.summary;
    const sla = STATE.settings.sla;
    const wi = Object.entries(s.whatIf).map(([k, v]) => {
      const [b, t] = k.split('|');
      return { borough: b, type: t, ...v };
    });
    const breachers = wi.filter((x) => x.p90 > sla).sort((a, b) => b.p90 - a.p90).slice(0, 5);
    const topType = Object.entries(s.byType).sort((a, b) => b[1] - a[1])[0];
    const topBorough = Object.entries(s.byBorough).sort((a, b) => b[1] - a[1])[0];

    const breachTable = breachers.length
      ? `<table><thead><tr><th>Borough</th><th>Complaint Type</th><th>p90 (h)</th><th>Avg (h)</th><th>Sample n</th></tr></thead><tbody>
         ${breachers.map((b) => `<tr><td>${titleCase(b.borough)}</td><td>${escapeHtml(b.type)}</td><td>${b.p90}</td><td>${b.avg}</td><td>${b.n}</td></tr>`).join('')}
         </tbody></table>`
      : '<p class="muted">No SLA breachers in current snapshot — system is operating within target.</p>';

    document.getElementById('brdBody').innerHTML = `
      <h3>Document control</h3>
      <p><b>Author:</b> Systems Analyst, City Pulse · <b>Snapshot:</b> ${new Date(STATE.data.generatedAt).toLocaleString()} · <b>Version:</b> 1.0 (live)</p>

      <h3>1. Background</h3>
      <p>
        New York City's 311 service intake receives a high volume of citizen reports daily across multiple
        agencies. The current routing model is largely category-driven, with limited use of historical
        resolution-time data to bias toward bottleneck mitigation.
      </p>

      <h3>2. Problem statement</h3>
      <p>
        In the current snapshot of <code>${s.total}</code> tickets, the top complaint type is
        <b>${escapeHtml(topType ? topType[0] : '—')}</b> (${topType ? topType[1] : 0} tickets) and the
        highest-volume borough is <b>${titleCase(topBorough ? topBorough[0] : '—')}</b>
        (${topBorough ? topBorough[1] : 0} tickets). Cycle-time p90 is
        <code>${s.cycleStats.p90}h</code> against an SLA target of <code>${sla}h</code>.
        ${breachers.length ? `<b class="bad">${breachers.length}</b> borough/type buckets exceed the SLA target on p90.` : 'No buckets exceed the SLA target on p90 in this snapshot.'}
      </p>

      <h3>3. Stakeholders</h3>
      <ul>
        <li>NYC 311 Operations — owns intake, triage, routing rules</li>
        <li>Responding agencies (NYPD, DSNY, DEP, HPD, DOT, DPR, …) — own resolution</li>
        <li>Citizens — end consumers, expect timely closure</li>
        <li>Office of Operations — owns SLA reporting and accountability</li>
      </ul>

      <h3>4. Proposed solution</h3>
      <p>
        Introduce a <b>data-driven auto-routing rule</b> on top of the existing category routing. For each
        incoming ticket, predicted resolution time is estimated from the live empirical distribution of the
        matching <code>(borough, complaint type)</code> bucket. Tickets whose predicted p90 exceeds the
        SLA target are <b>auto-flagged for priority queue</b> at the responding agency.
      </p>

      <h3>5. Functional requirements</h3>
      <ul>
        <li><b>FR-1:</b> System SHALL compute (borough, type) cycle-time percentiles from rolling 30-day window.</li>
        <li><b>FR-2:</b> System SHALL flag tickets whose bucket p90 exceeds the SLA target for priority queue.</li>
        <li><b>FR-3:</b> Operations dashboard SHALL display bottleneck rankings updated hourly.</li>
        <li><b>FR-4:</b> Auto-routing rule SHALL be overridable by a human dispatcher with audit log.</li>
      </ul>

      <h3>6. Non-functional requirements</h3>
      <ul>
        <li><b>NFR-1:</b> Refresh latency ≤ 1 hour from source.</li>
        <li><b>NFR-2:</b> 99.5% availability for the analytics view.</li>
        <li><b>NFR-3:</b> All routing decisions are auditable; logs retained 7 years.</li>
      </ul>

      <h3>7. Current bottlenecks (live)</h3>
      ${breachTable}

      <h3>8. Expected impact</h3>
      <p>
        Targeting the bottleneck buckets above is expected to reduce p90 cycle time in those segments
        by 25–40% (based on diversion to priority queue), trimming approximately
        <b>${Math.max(1, Math.round((s.slaBreaches || 1) * 0.3))}</b> SLA breaches per snapshot cycle.
        Citizen satisfaction proxies (re-open rate, repeat-call rate) are expected to improve in parallel.
      </p>

      <h3>9. Risks &amp; assumptions</h3>
      <ul>
        <li>Assumes recent historical distribution is predictive of near-term workload — verify quarterly.</li>
        <li>Priority queue must not starve non-flagged tickets — cap diversion at 30% of agency capacity.</li>
        <li>Live data exposes minor delays in close-out reporting — model uses p90, not max, to dampen noise.</li>
      </ul>

      <h3>10. Acceptance criteria</h3>
      <ul>
        <li>Routing rule reduces SLA-breach rate by ≥ 20% across pilot agencies within 8 weeks.</li>
        <li>No measurable increase in cycle time for non-flagged tickets.</li>
        <li>Dispatcher overrides &lt; 10% of flagged tickets (signal that the model is trusted).</li>
      </ul>`;
  }

  // ---------------- Tabs ----------------
  function bindTabs() {
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        const id = 'tab-' + t.dataset.tab;
        document.getElementById(id).classList.add('active');
        // Re-size map / charts on activation
        if (t.dataset.tab === 'ops' && STATE.map) {
          setTimeout(() => STATE.map.invalidateSize(), 100);
        }
      });
    });
  }

  // ---------------- Settings drawer ----------------
  function bindSettings() {
    const drawer = document.getElementById('settingsDrawer');
    const overlay = document.getElementById('overlay');
    const open = () => { drawer.classList.add('open'); overlay.classList.add('show'); reflectSettings(); };
    const close = () => { drawer.classList.remove('open'); overlay.classList.remove('show'); };
    document.getElementById('openSettings').addEventListener('click', open);
    document.getElementById('closeSettings').addEventListener('click', close);
    overlay.addEventListener('click', close);

    document.getElementById('applySettings').addEventListener('click', () => {
      const themeEl = document.querySelector('input[name=theme]:checked');
      const densEl = document.querySelector('input[name=density]:checked');
      STATE.settings.theme = themeEl ? themeEl.value : STATE.settings.theme;
      STATE.settings.density = densEl ? densEl.value : STATE.settings.density;
      STATE.settings.refresh = +document.getElementById('refreshInterval').value;
      STATE.settings.defaultBorough = document.getElementById('defaultBorough').value;
      STATE.settings.sla = Math.max(1, +document.getElementById('slaTarget').value || 72);
      STATE.settings.tiles = document.getElementById('tileStyle').value;
      saveSettings();
      applySettingsToDOM();
      STATE.boroughFilter = STATE.settings.defaultBorough;
      setTiles(STATE.settings.tiles);
      rerender();
      setupAutoRefresh();
      close();
    });

    document.getElementById('resetSettings').addEventListener('click', () => {
      localStorage.removeItem('cp.settings');
      STATE.settings = loadSettings();
      applySettingsToDOM();
      reflectSettings();
      STATE.boroughFilter = 'ALL';
      setTiles(STATE.settings.tiles);
      rerender();
      setupAutoRefresh();
    });
  }
  function reflectSettings() {
    document.querySelectorAll('input[name=theme]').forEach((el) => (el.checked = el.value === STATE.settings.theme));
    document.querySelectorAll('input[name=density]').forEach((el) => (el.checked = el.value === STATE.settings.density));
    document.getElementById('refreshInterval').value = String(STATE.settings.refresh);
    document.getElementById('slaTarget').value = STATE.settings.sla;
    document.getElementById('tileStyle').value = STATE.settings.tiles;
    const db = document.getElementById('defaultBorough');
    if (db) db.value = STATE.settings.defaultBorough;
  }

  function setupAutoRefresh() {
    if (STATE.refreshTimer) { clearInterval(STATE.refreshTimer); STATE.refreshTimer = null; }
    if (STATE.settings.refresh > 0) {
      STATE.refreshTimer = setInterval(async () => {
        try {
          await loadData();
          rerender();
        } catch (e) {
          console.error('Auto-refresh failed', e);
        }
      }, STATE.settings.refresh * 1000);
    }
  }

  function rerender() {
    renderHeader();
    renderKPIs();
    renderMap();
    renderCharts();
    renderTicker();
    renderBPMN();
    renderBRD();
  }

  function bindSim() {
    document.getElementById('simRun').addEventListener('click', runSim);
    document.getElementById('heatToggle').addEventListener('change', renderMap);
    document.getElementById('printBrd').addEventListener('click', () => window.print());
  }

  async function init() {
    applySettingsToDOM();
    bindTabs();
    bindSettings();
    bindSim();
    try {
      await loadData();
    } catch (e) {
      console.error(e);
      document.body.insertAdjacentHTML(
        'afterbegin',
        '<div style="padding:20px;background:#3a0d0d;color:#fff">Failed to load data/latest.json. Run <code>node scripts/fetch-data.js</code> first.</div>',
      );
      return;
    }
    populateSim();
    STATE.boroughFilter = STATE.settings.defaultBorough || 'ALL';
    rerender();
    setupAutoRefresh();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
