/* Jakarta AQI - static front-end (r7, NB8 contract).
 *
 * Consumes three static files from web/data (produced by build_web_data.py):
 *   meta.json           - resolution, model_status, anchor_date, slot_hours, horizons, legend, disclaimers
 *   forecast_r{R}.json  - { model_status, anchor_date, slot_hours, horizons_h,
 *                           cells: { h3_id: { slot_h: [ {offset_h, value, category, colour} ] } } }
 *                         (slot_h = a fixed clock slot; historical views use one point per
 *                          slot to show the full diurnal pattern. A legacy flat shape is still accepted.)
 *   hexes_r{R}.geojson  - hex-cell polygons (+ h3_id, center_lat/lon)
 *
 * AQI scale, category and colour all come from meta (exported from aqi_models.physics),
 * so nothing about the scale is hardcoded here.
 *
 * Historical-first flow:
 *   The page starts with map + location tools only. Forecast values are loaded
 *   only after the user chooses a historical date and presses "Show date".
 *
 * Date picker (archive):
 *   meta.archive = { start_date, end_date, path_pattern } tells the page the bounds
 *   and filename pattern of already-built per-date forecast files
 *   (data/forecast_r{R}_{date}.json). Missing dates are handled with an inline
 *   message, not a crash.
 */

const JAKARTA_CENTER = [-6.2, 106.84];
const state = {
  meta: null,
  forecast: null,
  climatology: null,
  resolution: 7,
  h3ToLayer: new Map(),
  geoLayer: null,
  maskLayer: null,
  selectedLayer: null,
  locationMarker: null,
  chart: null,
  currentSlot: null, // retained for legacy flat data; historical views use all clock slots
  selected: null, // { h3id, lat, lng } of the chosen cell, so the clock tick can re-render it
  mode: "current", // "current" | "other"
  archiveDate: null, // "YYYY-MM-DD" currently shown
  archiveCache: new Map(), // date -> forecast object, or null if known-missing
  climatologyCache: new Map(), // date -> climatology overlay object, or null if known-missing
  simulationMode: "raw", // "raw" | "blend_climatology"
};

// Fallback if meta.json predates the archive feature; meta.archive (when present) wins.
const DEFAULT_ARCHIVE = {
  start_date: "2024-02-02",
  end_date: "2025-02-28",
  path_pattern: "data/forecast_r{res}_{date}.json",
};

const isPending = () => !state.meta || !state.forecast || state.meta.model_status === "pending_retrain";
const cellsMap = () => (state.forecast && state.forecast.cells) || {};
const show = (id, on) => document.getElementById(id).classList.toggle("hidden", !on);

const DEFAULT_SIMULATION_MODES = [
  { id: "raw", label: "Tanpa klimatologi", description: "Murni hasil model prediksi" },
  { id: "blend_climatology", label: "Dengan klimatologi", description: "50% hasil model + 50% klimatologi ISPU." },
];

// ---------------------------------------------------------------------------
// AQI scale helpers - driven entirely by meta.legend (single source of truth).
// ---------------------------------------------------------------------------
function legendEntryFor(value) {
  const legend = state.meta.legend;
  for (const e of legend) {
    if (e.upper === null || value <= e.upper) return e;
  }
  return legend[legend.length - 1];
}
const colorFor = (value) => legendEntryFor(value).color;
const round1 = (value) => Math.round(Number(value) * 10) / 10;

function modeInfo(id) {
  const modes = (state.meta && state.meta.simulation_modes) || DEFAULT_SIMULATION_MODES;
  return modes.find((m) => m.id === id) || { id, label: id, description: "" };
}

function classifyPoint(sourcePoint, value) {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  const e = legendEntryFor(safe);
  return {
    ...sourcePoint,
    value: round1(safe),
    category: e.category,
    colour: e.color,
  };
}

// ---------------------------------------------------------------------------
// Diurnal clock-slice: the forecast carries every fixed clock slot; the page
// shows the slot nearest the user's current WIB time (current + next-3, weather-
// forecast style). The data's slots are WIB clock hours, so "now" is WIB too.
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, "0");
// A Date whose UTC fields read as WIB wall-clock (WIB = UTC+7), so the date and
// hour are correct no matter what timezone the viewer's browser is in.
const nowWIB = () => new Date(Date.now() + 7 * 3600 * 1000);
const nowHourWIB = () => nowWIB().getUTCHours();
const wibDateStr = () => { const d = nowWIB(); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const wibClockStr = () => { const d = nowWIB(); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
const circDist = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };

function nearestSlot(hour, slots) {
  const list = slots || (state.meta && state.meta.slot_hours) || [];
  if (!list.length) return null;
  return list.reduce((best, s) => (circDist(s, hour) < circDist(best, hour) ? s : best), list[0]);
}

// The slot_hours that govern the CURRENTLY LOADED forecast (archive dates carry their
// own slot_hours; fall back to meta for generated/default files or legacy data).
const activeSlotHours = () => (state.forecast && state.forecast.slot_hours) || (state.meta && state.meta.slot_hours) || [];

// The current-slot series for a cell. Accepts the slot-keyed shape
// { slot_h: [series] } and the legacy flat [series] (returned as-is).
function diurnalSeriesForCell(h3id) {
  const cell = cellsMap()[h3id];
  if (!cell) return null;
  if (Array.isArray(cell)) return cell;                       // legacy flat (single anchor)
  const slots = Object.keys(cell).map(Number).sort((a, b) => a - b);
  const points = slots.map((slot) => {
    const series = cell[String(slot)] || [];
    const point = series.find((p) => Number(p.offset_h) === 0) || series[0];
    if (!point) return null;
    let out = { ...point, offset_h: 0, clock_h: slot };
    if (state.simulationMode === "blend_climatology" && state.climatology) {
      const climCell = state.climatology[h3id];
      const climSeries = climCell && climCell[String(slot)];
      const climValue = Array.isArray(climSeries) ? Number(climSeries[0]) : NaN;
      if (Number.isFinite(climValue)) {
        const weight = Number(state.meta.blend_weight ?? 0.5);
        out = classifyPoint(out, (1 - weight) * Number(out.value) + weight * climValue);
      }
    }
    return out;
  }).filter(Boolean);
  return points.length ? points : null;
}

function peakForSeries(series) {
  if (!series || !series.length) return null;
  return series.reduce((best, p) => (Number(p.value) > Number(best.value) ? p : best), series[0]);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function initMap() {
  const map = L.map("map").setView(JAKARTA_CENTER, 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  state.map = map;
  // "Lat/lon" mode: click anywhere to resolve the containing cell.
  map.on("click", (e) => {
    if (state.mode === "other") selectByLatLng(e.latlng.lat, e.latlng.lng);
  });
  return map;
}

function styleForFeature(feature) {
  // Pending: render the grid uniformly so users can see coverage (no values yet).
  if (isPending()) {
    return { fillColor: "#cdd6e0", fillOpacity: 0.22, color: "#8aa0b8", weight: 0.4 };
  }
  const series = diurnalSeriesForCell(feature.properties.h3_id);
  const peak = peakForSeries(series);
  const idx = peak ? peak.value : null;
  return {
    fillColor: idx === null ? state.meta.no_data_color : peak.colour || colorFor(idx),
    fillOpacity: 0.4,
    color: "#5b6573",
    weight: 0.3,
  };
}

function addGeoLayer(geojson) {
  state.geoLayer = L.geoJSON(geojson, {
    style: styleForFeature,
    onEachFeature: (feature, layer) => {
      const id = feature.properties.h3_id;
      state.h3ToLayer.set(id, layer);
      layer.on("click", (e) => {
        L.DomEvent.stopPropagation(e); // don't also fire the map "other" click
        const p = feature.properties;
        placeMarker(p.center_lat, p.center_lon);
        selectByCell(id, p.center_lat, p.center_lon);
      });
    },
  }).addTo(state.map);
}

// Opaque mask: hide the basemap everywhere OUTSIDE the hex grid, so only the
// Jakarta study area shows map tiles. Each hex ring becomes a hole in a
// world-covering polygon (Leaflet's default evenodd fill-rule cuts them out);
// a dedicated pane keeps the mask above the tiles but below the hex layer.
// Also frames the grid and bounds panning so the view can't wander off Jakarta.
function addGridMask() {
  if (!state.geoLayer) return;
  const holes = [];
  state.geoLayer.eachLayer((layer) => {
    const rings = layer.getLatLngs();
    if (rings && rings[0]) holes.push(rings[0]);
  });
  const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];

  if (!state.map.getPane("maskPane")) {
    const pane = state.map.createPane("maskPane");
    pane.style.zIndex = 350; // tilePane(200) < maskPane(350) < overlayPane(400)
    pane.style.pointerEvents = "none";
  }
  state.maskLayer = L.polygon([world, ...holes], {
    pane: "maskPane",
    stroke: false,
    fillColor: "#e9eef3",
    fillOpacity: 1,
    interactive: false,
  }).addTo(state.map);

  const b = state.geoLayer.getBounds();
  state.map.fitBounds(b);
  state.map.setMaxBounds(b.pad(0.5));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function placeMarker(lat, lng) {
  if (state.locationMarker) state.locationMarker.setLatLng([lat, lng]);
  else state.locationMarker = L.marker([lat, lng]).addTo(state.map);
}

function highlight(layer) {
  if (state.selectedLayer && state.geoLayer) state.geoLayer.resetStyle(state.selectedLayer);
  if (layer) {
    layer.setStyle({ color: "#111", weight: 2.5, fillOpacity: isPending() ? 0.4 : 0.65 });
    layer.bringToFront();
  }
  state.selectedLayer = layer;
}

function selectByLatLng(lat, lng) {
  // h3-js v4 API (matches Python aqi_utils.h3_grid.latlng_to_cell at the same res).
  const cell = h3.latLngToCell(lat, lng, state.resolution);
  placeMarker(lat, lng);
  selectByCell(cell, lat, lng);
}

function selectByCell(h3id, lat, lng) {
  state.selected = { h3id, lat, lng };
  show("result-card", true);
  const layer = state.h3ToLayer.get(h3id) || null;
  const onGrid = layer !== null;
  highlight(layer);
  if (layer) state.map.panTo(layer.getBounds().getCenter());

  const coordTxt = lat != null ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : "";
  const dateTxt = state.archiveDate
    ? `<br>Historical date: ${state.archiveDate}`
    : "";
  document.getElementById("result-meta").innerHTML =
    `Cell <code>${h3id}</code>${coordTxt ? "<br>" + coordTxt : ""}${dateTxt}` +
    (onGrid ? "" : `<br><span class="warn">Outside the Jakarta study grid.</span>`);

  // --- PENDING (coming-soon) state ---
  if (isPending()) {
    show("aqi-readout", false);
    show("forecast-section", false);
    show("peak-summary", false);
    show("aqi-pending", true);
    document.getElementById("pending-text").textContent = onGrid
      ? "Choose a historical date and press Show date to load the simulation for this cell."
      : "This location is outside the Jakarta mainland study grid, so it has no simulated AQI.";
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }

  // --- Historical simulation state ---
  show("aqi-pending", false);
  const series = diurnalSeriesForCell(h3id);
  if (!series) {
    show("aqi-readout", true);
    show("forecast-section", false);
    show("peak-summary", false);
    document.getElementById("aqi-value").textContent = "—";
    const badge = document.getElementById("aqi-badge");
    badge.textContent = "Outside coverage";
    badge.style.background = state.meta.no_data_color;
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }
  show("aqi-readout", true);
  show("peak-summary", true);
  show("forecast-section", true);
  const peak = peakForSeries(series);
  const e = legendEntryFor(peak.value);
  document.getElementById("aqi-value").textContent = Math.round(peak.value);
  const badge = document.getElementById("aqi-badge");
  badge.textContent = `${peak.category || e.category} · ${e.english}`;
  badge.style.background = peak.colour || e.color;
  renderPeakSummary(peak);
  renderChart(series);
  renderStepBadges(series);
}

// ---------------------------------------------------------------------------
// Forecast chart + step badges
// ---------------------------------------------------------------------------
const stepLabel = (offsetH) => (offsetH === 0 ? "Now" : `+${offsetH}h`);

// WIB clock time of a forecast point. Slots are whole WIB clock hours and offsets
// are whole hours, so the wall-clock is just (slot + offset) mod 24 -- computed in
// WIB directly, independent of the viewer's browser timezone.
function stepClock(offsetH) {
  if (state.currentSlot != null) return pad2((state.currentSlot + offsetH) % 24) + ":00";
  // legacy flat data (single anchor): derive the hour from anchor_ts if present.
  if (state.meta.anchor_ts) {
    const d = new Date(String(state.meta.anchor_ts).replace(" ", "T"));
    if (!isNaN(d.getTime())) return pad2((d.getHours() + offsetH) % 24) + ":00";
  }
  return "";
}

function pointClock(point) {
  if (point && point.clock_h != null) return pad2(point.clock_h) + ":00";
  return stepClock(point ? point.offset_h : 0);
}

function renderPeakSummary(peak) {
  const el = document.getElementById("peak-summary");
  const e = legendEntryFor(peak.value);
  const clk = pointClock(peak);
  el.innerHTML =
    `<strong>Peak AQI</strong> <span class="peak-time">${clk} WIB</span>` +
    ` &middot; ${Math.round(peak.value)} &middot; ${peak.category || e.category} (${e.english})`;
}

function renderChart(series) {
  // Heading reflects the actual step size + horizon span from the data (not hardcoded).
  const step = series.length > 1 && series[1].clock_h != null
    ? (series[1].clock_h - series[0].clock_h + 24) % 24
    : (series.length > 1 ? series[1].offset_h - series[0].offset_h : 0);
  const titleEl = document.getElementById("chart-title");
  if (titleEl) titleEl.textContent = step ? `Historical diurnal pattern · ${step}-hour slots` : "Historical pattern";

  const labels = series.map((s) => {
    const clk = pointClock(s);
    return clk ? clk : stepLabel(s.offset_h);
  });
  const values = series.map((s) => s.value);
  const colors = series.map((s) => s.colour || colorFor(s.value));
  const ctx = document.getElementById("forecast-chart");

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: "#8893a0",
        borderWidth: 2,
        tension: 0.3,
        pointBackgroundColor: colors,
        pointBorderColor: "#333",
        pointRadius: 6,
        pointHoverRadius: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { left: 0, right: 4, top: 4, bottom: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const e = legendEntryFor(item.parsed.y);
              return `AQI ${Math.round(item.parsed.y)} — ${e.category} (${e.english})`;
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          suggestedMax: 150,
          title: { display: true, text: "ISPU", font: { size: 10 } },
          ticks: { font: { size: 10 }, padding: 2, maxTicksLimit: 5 },
        },
        x: {
          ticks: { maxRotation: 0, autoSkip: false, font: { size: 10 }, padding: 2 },
          title: { display: true, text: "WIB", font: { size: 10 }, padding: { top: 0 } },
        },
      },
    },
  });
}

function renderStepBadges(series) {
  const wrap = document.getElementById("step-badges");
  wrap.innerHTML = "";
  series.forEach((s) => {
    const e = legendEntryFor(s.value);
    const clk = pointClock(s);
    const div = document.createElement("div");
    div.className = "sb";
    div.innerHTML =
      `<div class="sb-time">${clk ? clk + " WIB" : stepLabel(s.offset_h)}</div>` +
      `<div class="sb-val">${Math.round(s.value)}</div>` +
      `<div><span class="dot" style="background:${s.colour || e.color}"></span>${s.category || e.category}</div>`;
    wrap.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Static UI: legend, banner, about, mode toggle
// ---------------------------------------------------------------------------
function renderLegend() {
  const ul = document.getElementById("legend-list");
  ul.innerHTML = "";
  let lower = 0;
  state.meta.legend.forEach((e) => {
    const li = document.createElement("li");
    const range = e.upper === null ? `${lower}+` : `${lower}–${e.upper}`;
    li.innerHTML =
      `<span class="swatch" style="background:${e.color}"></span>` +
      `<span class="legend-label"><span class="legend-id">${e.category}</span><span class="legend-en">${e.english}</span></span>` +
      `<span class="range">${range}</span>`;
    ul.appendChild(li);
    lower = (e.upper ?? lower) + 1;
  });
}

function renderBanner() {
  const b = document.getElementById("status-banner");
  if (b.classList.contains("is-empty")) {
    b.textContent = "";
    return;
  }
  if (isPending()) {
    b.className = "banner banner-pending";
    b.innerHTML = `<strong>SELECT DATE</strong> &mdash; choose a historical date, then press Show date to load the simulation`;
  } else {
    b.className = "banner banner-sim";
    b.innerHTML =
      `<strong>HISTORICAL SIMULATION</strong> &middot; modeled diurnal pattern for ${state.archiveDate || "selected date"} ` +
      `&middot; ${modeInfo(state.simulationMode).label} ` +
      `&middot; not a live measurement`;
  }
}

function renderAbout() {
  document.getElementById("about-disclaimers").innerHTML =
    state.meta.disclaimers.map((d) => `<li>${d}</li>`).join("");
  const footer = document.getElementById("footer-note");
  if (footer) footer.textContent = "";
}

function renderSimulationControls() {
  const raw = modeInfo("raw");
  const blend = modeInfo("blend_climatology");
  const rawBtn = document.getElementById("sim-raw");
  const blendBtn = document.getElementById("sim-blend");
  rawBtn.textContent = raw.label || "Tanpa klimatologi";
  blendBtn.textContent = blend.label || "Dengan klimatologi";
  rawBtn.classList.toggle("active", state.simulationMode === "raw");
  blendBtn.classList.toggle("active", state.simulationMode === "blend_climatology");
  const active = modeInfo(state.simulationMode);
  document.getElementById("simulation-note").textContent = active.description || "";
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("mode-current").classList.toggle("active", mode === "current");
  document.getElementById("mode-other").classList.toggle("active", mode === "other");
  show("panel-current", mode === "current");
  show("panel-other", mode === "other");
}

// ---------------------------------------------------------------------------
// Date picker (archive): load an already-built per-date file from the archive.
// Lazily fetched + cached; missing dates degrade to an inline message.
// ---------------------------------------------------------------------------
const archiveConfig = () => (state.meta && state.meta.archive) || DEFAULT_ARCHIVE;
const archivePath = (dateStr) =>
  archiveConfig().path_pattern.replace("{res}", state.resolution).replace("{date}", dateStr);
const climatologyPath = (dateStr) => {
  const pattern = (state.meta && state.meta.climatology_file_pattern) || "climatology_r7_{date}.json";
  return pattern ? `data/${pattern.replace("{date}", dateStr)}` : null;
};

// The backtest pipeline that produces the archive files (data/forecast_r{res}_{date}.json)
// sometimes emits the BARE cell map at the top level -- { h3_id: { slot_h: [series] } } --
// with no { model_status, anchor_date, slot_hours, horizons_h, cells } wrapper. cellsMap()
// only ever looks at state.forecast.cells, so an unwrapped file silently looks empty (every
// cell shows "Outside coverage"). Normalize both shapes here, the same way build_web_data.py's
// load_nb8_forecast() derives slot_hours/horizons_h from the raw cell data when meta is absent.
function normalizeArchiveForecast(raw, dateStr) {
  if (raw && typeof raw === "object" && raw.cells) return raw; // already wrapped - leave as-is
  const cells = raw || {};
  const firstCell = cells[Object.keys(cells)[0]] || {};
  const slot_hours = Object.keys(firstCell).map(Number).sort((a, b) => a - b);
  const firstSlot = firstCell[Object.keys(firstCell)[0]] || [];
  const horizons_h = firstSlot.map((p) => p.offset_h);
  return { model_status: "historical", anchor_date: dateStr, slot_hours, horizons_h, cells };
}

async function loadArchiveDate(dateStr) {
  const cache = state.archiveCache;
  if (cache.has(dateStr)) return cache.get(dateStr); // a forecast object, or null = known-missing
  try {
    const res = await fetch(archivePath(dateStr));
    if (!res.ok) { cache.set(dateStr, null); return null; }
    const raw = await res.json();
    const data = normalizeArchiveForecast(raw, dateStr);
    cache.set(dateStr, data);
    return data;
  } catch (e) {
    cache.set(dateStr, null);
    return null;
  }
}

async function loadClimatologyDate(dateStr) {
  if (!dateStr) return null;
  const cache = state.climatologyCache;
  if (cache.has(dateStr)) return cache.get(dateStr);
  const path = climatologyPath(dateStr);
  if (!path) return null;
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    const raw = await res.json();
    const data = raw && raw.cells ? raw.cells : raw;
    cache.set(dateStr, data);
    return data;
  } catch (e) {
    return null;
  }
}

// Re-derive everything that depends on "which forecast is loaded": the clock slot,
// the grid colouring, the banner, and the currently-selected cell's readout.
function refreshAfterForecastChange() {
  state.currentSlot = null;
  if (state.geoLayer) state.geoLayer.setStyle(styleForFeature);
  renderSimulationControls();
  renderBanner();
  if (state.selected) selectByCell(state.selected.h3id, state.selected.lat, state.selected.lng);
}

async function onArchiveDateChange(dateStr) {
  const hint = document.getElementById("date-hint");
  hint.classList.remove("warn");
  hint.textContent = "Loading…";
  const data = await loadArchiveDate(dateStr);
  if (!data) {
    hint.textContent = `No simulation saved for ${dateStr} — try a nearby date.`;
    hint.classList.add("warn");
    return; // keep showing whatever was loaded before (don't blank the map on a miss)
  }
  state.forecast = data;
  state.archiveDate = dateStr;
  let statusText = `Showing the historical simulation for ${dateStr}.`;
  let statusWarn = false;
  if (state.simulationMode === "blend_climatology") {
    const clim = await loadClimatologyDate(dateStr);
    if (!clim) {
      state.simulationMode = "raw";
      state.climatology = null;
      statusText = `Showing ${dateStr}; climatology overlay missing, so simulation without climatology is used.`;
      statusWarn = true;
    } else {
      state.climatology = clim;
    }
  } else {
    state.climatology = null;
  }
  hint.textContent = statusText;
  hint.classList.toggle("warn", statusWarn);
  renderAbout();
  refreshAfterForecastChange();
}

function confirmArchiveDate() {
  const input = document.getElementById("date-input");
  const hint = document.getElementById("date-hint");
  if (!input.value) {
    hint.textContent = "Choose a date first.";
    hint.classList.add("warn");
    return;
  }
  onArchiveDateChange(input.value);
}

// ---------------------------------------------------------------------------
// LandingHero controller - a thin entry layer over the existing map app.
// ---------------------------------------------------------------------------
function openAboutOverlay() {
  const overlay = document.getElementById("about-overlay");
  if (overlay) overlay.classList.remove("hidden");
}

function closeAboutOverlay() {
  const overlay = document.getElementById("about-overlay");
  if (overlay) overlay.classList.add("hidden");
}

function showLanding() {
  document.body.classList.add("landing-open");
  const landing = document.getElementById("landing");
  if (landing) landing.removeAttribute("aria-hidden");
}

function enterApp(options = {}) {
  document.body.classList.remove("landing-open");
  const landing = document.getElementById("landing");
  if (landing) landing.setAttribute("aria-hidden", "true");
  if (document.getElementById("layout").classList.contains("sidebar-collapsed")) {
    setSidebarCollapsed(false);
  }
  if (options.focusDate !== false) {
    window.setTimeout(() => {
      const dateInput = document.getElementById("date-input");
      if (dateInput) dateInput.focus({ preventScroll: true });
    }, 220);
  }
}

function renderLandingDashboard() {
  if (!state.meta) return;
  const arc = archiveConfig();
  const slotText = activeSlotHours().map((h) => pad2(h)).join(", ");
  document.getElementById("landing-archive-range").textContent = `${arc.start_date} to ${arc.end_date}`;
  document.getElementById("landing-cell-count").textContent = `${state.meta.n_cells} H3 cells`;
  document.getElementById("landing-slot-list").textContent = `${slotText} WIB`;
  document.getElementById("landing-mode-label").textContent = modeInfo(state.simulationMode).label;

  const strip = document.getElementById("landing-scale-strip");
  strip.innerHTML = "";
  state.meta.legend.forEach((entry) => {
    const segment = document.createElement("span");
    segment.title = `${entry.category} (${entry.english})`;
    segment.style.background = entry.color;
    strip.appendChild(segment);
  });
}

async function startLandingWithDate(dateStr) {
  const input = document.getElementById("date-input");
  if (input) input.value = dateStr;
  await onArchiveDateChange(dateStr);
  enterApp({ focusDate: false });
}

function wireLandingControls() {
  const start = document.getElementById("landing-start");
  const notes = document.getElementById("landing-about");
  const intro = document.getElementById("intro-btn");
  const firstDate = document.getElementById("landing-first-date");
  const latestDate = document.getElementById("landing-latest-date");
  const manualDate = document.getElementById("landing-manual-date");
  if (start) start.addEventListener("click", enterApp);
  if (notes) notes.addEventListener("click", openAboutOverlay);
  if (intro) intro.addEventListener("click", showLanding);
  if (firstDate) firstDate.addEventListener("click", () => startLandingWithDate(archiveConfig().start_date));
  if (latestDate) latestDate.addEventListener("click", () => startLandingWithDate(archiveConfig().end_date));
  if (manualDate) manualDate.addEventListener("click", enterApp);
}

function wireControls() {
  wireLandingControls();
  wireSidebarToggle();
  document.getElementById("date-confirm-btn").addEventListener("click", confirmArchiveDate);
  document.getElementById("sim-raw").addEventListener("click", () => setSimulationMode("raw"));
  document.getElementById("sim-blend").addEventListener("click", () => setSimulationMode("blend_climatology"));
  document.getElementById("date-input").addEventListener("change", (e) => {
    const hint = document.getElementById("date-hint");
    hint.classList.remove("warn");
    hint.textContent = `Selected ${e.target.value}. Press Show date to load the historical simulation.`;
  });
  document.getElementById("date-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmArchiveDate();
    }
  });

  document.getElementById("mode-current").addEventListener("click", () => setMode("current"));
  document.getElementById("mode-other").addEventListener("click", () => setMode("other"));

  const locateBtn = document.getElementById("locate-btn");
  const locateHint = document.getElementById("locate-hint");
  const setLocateHint = (msg, isErr) => {
    locateHint.textContent = msg;
    locateHint.classList.toggle("warn", !!isErr);
  };

  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setLocateHint("Geolocation isn't supported by this browser — use the Lat / lon option.", true);
      return;
    }
    const original = locateBtn.textContent;
    locateBtn.disabled = true;
    locateBtn.textContent = "Locating…";
    setLocateHint("Requesting your location…", false);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.disabled = false;
        locateBtn.textContent = original;
        const { latitude: lat, longitude: lng } = pos.coords;
        selectByLatLng(lat, lng); // resolves the hex cell + shows the (pending) readout
        const cell = h3.latLngToCell(lat, lng, state.resolution);
        if (state.h3ToLayer.has(cell)) {
          state.map.setView([lat, lng], Math.max(state.map.getZoom(), 13));
          setLocateHint("Showing the hex cell at your location.", false);
        } else {
          if (state.geoLayer) state.map.fitBounds(state.geoLayer.getBounds());
          setLocateHint("You're outside the Jakarta study grid — showing the covered area.", true);
        }
      },
      (err) => {
        locateBtn.disabled = false;
        locateBtn.textContent = original;
        const reason = { 1: "permission denied", 2: "position unavailable", 3: "request timed out" };
        let msg = "Couldn't get your location (" + (reason[err.code] || err.message) + ").";
        if (!window.isSecureContext) msg += " Location needs HTTPS or localhost.";
        msg += " Try the Lat / lon option.";
        setLocateHint(msg, true);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  document.getElementById("go-btn").addEventListener("click", () => {
    const lat = parseFloat(document.getElementById("lat-input").value);
    const lng = parseFloat(document.getElementById("lon-input").value);
    if (Number.isNaN(lat) || Number.isNaN(lng)) { alert("Enter a valid lat/lon."); return; }
    state.map.setView([lat, lng], Math.max(state.map.getZoom(), 12));
    selectByLatLng(lat, lng);
  });

  // About overlay
  const overlay = document.getElementById("about-overlay");
  const aboutBtn = document.getElementById("about-btn");
  if (aboutBtn) aboutBtn.addEventListener("click", openAboutOverlay);
  document.getElementById("about-close").addEventListener("click", closeAboutOverlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeAboutOverlay(); });
}

async function setSimulationMode(mode) {
  if (mode === state.simulationMode) return;
  if (mode === "blend_climatology" && state.archiveDate) {
    const clim = await loadClimatologyDate(state.archiveDate);
    if (!clim) {
      alert("Climatology overlay is not available for this date.");
      return;
    }
    state.climatology = clim;
  }
  if (mode === "raw") state.climatology = null;
  state.simulationMode = mode;
  renderSimulationControls();
  renderLandingDashboard();
  refreshAfterForecastChange();
}

function setSidebarCollapsed(collapsed) {
  const layout = document.getElementById("layout");
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  layout.classList.toggle("sidebar-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", collapsed ? "Expand side panel" : "Collapse side panel");
  toggle.title = collapsed ? "Expand side panel" : "Collapse side panel";
  sidebar.setAttribute("aria-hidden", String(collapsed));
  sidebar.inert = collapsed;
  if (collapsed && sidebar.contains(document.activeElement)) toggle.focus();
  requestAnimationFrame(() => state.map && state.map.invalidateSize());
  window.setTimeout(() => state.map && state.map.invalidateSize(), 260);
}

function wireSidebarToggle() {
  const toggle = document.getElementById("sidebar-toggle");
  if (!toggle) return;
  setSidebarCollapsed(false);
  toggle.addEventListener("click", () => {
    const collapsed = document.getElementById("layout").classList.contains("sidebar-collapsed");
    setSidebarCollapsed(!collapsed);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // meta first (it carries the resolution that names the other two files)
  const meta = await fetch("data/meta.json?v=simulation-mode-retry-2", { cache: "no-store" }).then((r) => r.json());
  state.meta = meta;
  state.resolution = meta.resolution;
  state.simulationMode = meta.default_simulation_mode || "raw";

  const geojson = await fetch(`data/hexes_r${meta.resolution}.geojson`).then((r) => r.json());
  state.forecast = null;
  state.currentSlot = null;
  const resLabel = document.getElementById("res-label");
  if (resLabel) resLabel.textContent = "r" + meta.resolution;

  const arc = archiveConfig();
  const dateInput = document.getElementById("date-input");
  dateInput.min = arc.start_date;
  dateInput.max = arc.end_date;
  dateInput.value = "";
  document.getElementById("date-hint").textContent =
    `Available historical dates: ${arc.start_date} to ${arc.end_date}.`;

  initMap();
  addGeoLayer(geojson);
  addGridMask();
  renderLegend();
  renderBanner();
  renderAbout();
  renderSimulationControls();
  renderLandingDashboard();
  wireControls();
  setMode("current");
}

boot().catch((e) => {
  console.error(e);
  alert("Failed to load web data. Run `python web/build_web_data.py` first, then serve the folder.");
});
