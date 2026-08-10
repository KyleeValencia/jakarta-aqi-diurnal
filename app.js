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

// The 5 hex cells containing an ISPU ground station (r7): the ONLY cells whose value
// is validated against a measurement. Every other cell is a covariate-driven estimate
// (see the AOA / honesty boundary). The optional toggle grades the grid into three
// tiers — these 5, the 175 inside the AOA, and the 110 that are extrapolation — using
// the in_aoa property the build attaches per cell. IDs from
// aqi_models.masking.station_node_mask (DKI1..DKI5); recompute if the grid/stations change.
const STATION_CELLS = new Set([
  "878c10799ffffff", "878c10792ffffff", "878c10703ffffff", "878c107a6ffffff", "878c10612ffffff",
]);

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
  blurUnvalidated: false, // ON => fade the 285 unvalidated cells, keep the 5 station cells sharp
  dateLoadRequestId: 0,
  dateLoadController: null,
  basemapLayer: null,
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
const DATE_GATED_BUTTON_IDS = [
  "mode-current", "mode-other", "locate-btn", "go-btn",
  "sim-raw", "sim-blend", "blur-toggle",
];
const DATE_GATED_CARD_IDS = [
  "location-card", "simulation-card", "display-card",
];

function hasLoadedSelectedDate() {
  const input = document.getElementById("date-input");
  return Boolean(
    state.archiveDate &&
    state.forecast &&
    input &&
    input.value === state.archiveDate
  );
}

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
function setBasemapUnavailable(unavailable) {
  const status = document.getElementById("basemap-status");
  if (status) status.classList.toggle("hidden", !unavailable);
}

function initMap() {
  const map = L.map("map").setView(JAKARTA_CENTER, 11);
  const basemap = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  });
  let basemapErrorTimer = null;
  basemap.on("tileerror", () => {
    window.clearTimeout(basemapErrorTimer);
    basemapErrorTimer = window.setTimeout(() => setBasemapUnavailable(true), 200);
  });
  basemap.on("tileload", () => {
    window.clearTimeout(basemapErrorTimer);
    setBasemapUnavailable(false);
  });
  basemap.addTo(map);
  state.basemapLayer = basemap;
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
  const id = feature.properties.h3_id;
  const series = diurnalSeriesForCell(id);
  const peak = peakForSeries(series);
  const idx = peak ? peak.value : null;
  const fillColor = idx === null ? state.meta.no_data_color : peak.colour || colorFor(idx);
  if (state.blurUnvalidated) {
    // Three tiers of evidence, not two. Distance from a monitor is NOT the criterion:
    // 149 cells sit >3 km from any station yet still fall inside the AOA, while 4 cells
    // within 3 km fall outside it. So key off in_aoa (feature-space applicability), and
    // fall back to the old station/non-station split on grids built before it existed.
    if (STATION_CELLS.has(id)) {
      // Measured: the only cells with ground truth. Crisp + bold edge.
      return { fillColor, fillOpacity: 0.8, color: "#111", weight: 2 };
    }
    if (feature.properties.in_aoa === true) {
      // Inside the AOA (175 cells): the model is interpolating, not guessing past its
      // training range. Keeps the category colour — the value is worth reading.
      return { fillColor, fillOpacity: 0.55, color: "#7d8794", weight: 0.4 };
    }
    // Extrapolation (110 cells), or an older grid with no in_aoa: DROP the category
    // colour entirely. Encoding this tier by opacity alone did not work — the fill
    // already carries the AQI category, so a faded green cell and a mid-strength blue
    // one looked alike and the tier signal was lost. Neutral grey makes it a difference
    // in KIND, readable at a glance, and is the honest render: a cell with no support
    // should not be painted a confident category colour.
    return { fillColor: "#aab2bb", fillOpacity: 0.28, color: "#6b7480", weight: 0.8, dashArray: "3 3" };
  }
  return { fillColor, fillOpacity: 0.4, color: "#5b6573", weight: 0.3 };
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
    fillOpacity: 0.5,
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
    ? `<br>Tanggal historis: ${state.archiveDate}`
    : "";
  document.getElementById("result-meta").innerHTML =
    `Sel <code>${h3id}</code>${coordTxt ? "<br>" + coordTxt : ""}${dateTxt}` +
    (onGrid ? "" : `<br><span class="warn">Di luar grid wilayah studi Jakarta.</span>`);

  // --- PENDING (coming-soon) state ---
  if (isPending()) {
    show("aqi-readout", false);
    show("forecast-section", false);
    show("peak-summary", false);
    show("aqi-pending", true);
    document.getElementById("pending-text").textContent = onGrid
      ? "Pilih tanggal historis lalu tekan Tampilkan tanggal untuk memuat simulasi sel ini."
      : "Lokasi ini di luar grid wilayah studi daratan Jakarta, jadi tidak punya AQI hasil simulasi.";
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
    badge.textContent = "Di luar cakupan";
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
  badge.textContent = `${peak.category || e.category}`;
  badge.style.background = peak.colour || e.color;
  renderPeakSummary(peak);
  renderChart(series);
  renderStepBadges(series);
}

// ---------------------------------------------------------------------------
// Forecast chart + step badges
// ---------------------------------------------------------------------------
const stepLabel = (offsetH) => (offsetH === 0 ? "Sekarang" : `+${offsetH}j`);

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
    `<strong>AQI puncak</strong> <span class="peak-time">${clk} WIB</span>` +
    ` &middot; ${Math.round(peak.value)} &middot; ${peak.category || e.category}`;
}

function renderChart(series) {
  // Heading reflects the actual step size + horizon span from the data (not hardcoded).
  const step = series.length > 1 && series[1].clock_h != null
    ? (series[1].clock_h - series[0].clock_h + 24) % 24
    : (series.length > 1 ? series[1].offset_h - series[0].offset_h : 0);
  const titleEl = document.getElementById("chart-title");
  if (titleEl) titleEl.textContent = step ? `Pola harian historis · slot ${step} jam` : "Pola historis";

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
              return `AQI ${Math.round(item.parsed.y)} — ${e.category}`;
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
      `<span class="legend-label"><span class="legend-id">${e.category}</span></span>` +
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
    b.innerHTML = `<strong>PILIH TANGGAL</strong> &mdash; pilih tanggal historis, lalu tekan Tampilkan tanggal untuk memuat simulasinya`;
  } else {
    b.className = "banner banner-sim";
    b.innerHTML =
      `<strong>SIMULASI HISTORIS</strong> &middot; pola harian hasil model untuk ${state.archiveDate || "tanggal terpilih"} ` +
      `&middot; ${modeInfo(state.simulationMode).label} ` +
      `&middot; bukan pengukuran langsung`;
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
  const note = document.getElementById("simulation-note");
  note.textContent = active.description || "";
  note.classList.remove("warn");
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("mode-current").classList.toggle("active", mode === "current");
  document.getElementById("mode-other").classList.toggle("active", mode === "other");
  show("panel-current", mode === "current");
  show("panel-other", mode === "other");
}

// Optional honesty view: fade the 285 covariate-estimate cells, keep the 5 validated
// station cells sharp. Off by default; toggled by the "Buramkan sel tak-tervalidasi" button.
function setBlurUnvalidated(on) {
  state.blurUnvalidated = on;
  const btn = document.getElementById("blur-toggle");
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
  if (state.geoLayer && !isPending()) {
    state.geoLayer.setStyle(styleForFeature);
    if (state.selectedLayer) highlight(state.selectedLayer); // re-assert the selection outline
  }
}

function syncHistoricalDateGate() {
  const locked = !hasLoadedSelectedDate();

  DATE_GATED_BUTTON_IDS.forEach((id) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = locked;
    button.classList.toggle("date-gated-control", locked);
    button.setAttribute("aria-disabled", String(locked));
  });

  DATE_GATED_CARD_IDS.forEach((id) => {
    const card = document.getElementById(id);
    if (!card) return;
    card.classList.toggle("date-locked", locked);
    card.setAttribute("aria-disabled", String(locked));
  });

  document.getElementById("date-card")
    .classList.toggle("date-required", locked);
  document.getElementById("date-required-badge")
    .classList.toggle("hidden", !locked);

  if (locked) {
    const arc = archiveConfig();
    const hint = document.getElementById("date-hint");
    hint.textContent =
      `Pilih dan muat tanggal historis (${arc.start_date} sampai ${arc.end_date}) ` +
      `untuk mengaktifkan kontrol di bawah.`;
    hint.classList.add("warn");
  }
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

async function loadArchiveDate(dateStr, signal) {
  const cache = state.archiveCache;
  if (cache.has(dateStr)) return cache.get(dateStr); // a forecast object, or null = known-missing
  try {
    const res = await fetch(archivePath(dateStr), { signal });
    if (!res.ok) {
      if (res.status === 404) cache.set(dateStr, null);
      return null;
    }
    const raw = await res.json();
    const data = normalizeArchiveForecast(raw, dateStr);
    cache.set(dateStr, data);
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return null;
  }
}

async function loadClimatologyDate(dateStr, signal) {
  if (!dateStr) return null;
  const cache = state.climatologyCache;
  if (cache.has(dateStr)) return cache.get(dateStr);
  const path = climatologyPath(dateStr);
  if (!path) return null;
  try {
    const res = await fetch(path, { signal });
    if (!res.ok) return null;
    const raw = await res.json();
    const data = raw && raw.cells ? raw.cells : raw;
    cache.set(dateStr, data);
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    return null;
  }
}

function resetForecastState() {
  state.forecast = null;
  state.archiveDate = null;
  state.climatology = null;
  state.currentSlot = null;

  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  show("result-card", false);
  show("aqi-readout", false);
  show("forecast-section", false);
  show("peak-summary", false);
  show("aqi-pending", false);
  document.getElementById("result-meta").textContent = "";
  document.getElementById("peak-summary").textContent = "";
  document.getElementById("step-badges").textContent = "";

  if (state.geoLayer) state.geoLayer.setStyle(styleForFeature);
  state.selectedLayer = null;
  renderSimulationControls();
  renderBanner();
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
  const requestId = ++state.dateLoadRequestId;
  if (state.dateLoadController) state.dateLoadController.abort();
  const controller = new AbortController();
  state.dateLoadController = controller;

  resetForecastState();
  syncHistoricalDateGate();
  hint.classList.remove("warn");
  hint.textContent = "Memuat…";

  try {
    const data = await loadArchiveDate(dateStr, controller.signal);
    if (requestId !== state.dateLoadRequestId || controller.signal.aborted) return false;

    if (!data) {
      resetForecastState();
      syncHistoricalDateGate();
      hint.textContent = `Tidak ada simulasi untuk ${dateStr}. Coba tanggal terdekat lainnya`;
      hint.classList.add("warn");
      return false;
    }

    let nextMode = state.simulationMode;
    let nextClimatology = null;
    let statusText = `Menampilkan simulasi historis untuk ${dateStr}.`;
    let statusWarn = false;
    if (nextMode === "blend_climatology") {
      const clim = await loadClimatologyDate(dateStr, controller.signal);
      if (requestId !== state.dateLoadRequestId || controller.signal.aborted) return false;
      if (!clim) {
        nextMode = "raw";
        statusText = `Menampilkan ${dateStr}. Lapisan klimatologi tidak ada, jadi yang dipakai simulasi tanpa klimatologi.`;
        statusWarn = true;
      } else {
        nextClimatology = clim;
      }
    }

    state.forecast = data;
    state.archiveDate = dateStr;
    state.simulationMode = nextMode;
    state.climatology = nextClimatology;
    hint.textContent = statusText;
    hint.classList.toggle("warn", statusWarn);
    renderAbout();
    refreshAfterForecastChange();
    syncHistoricalDateGate();
    return true;
  } catch (e) {
    if (e && e.name === "AbortError") return false;
    if (requestId === state.dateLoadRequestId) {
      resetForecastState();
      syncHistoricalDateGate();
      hint.textContent = `Gagal memuat simulasi untuk ${dateStr}. Coba lagi.`;
      hint.classList.add("warn");
    }
    return false;
  } finally {
    if (requestId === state.dateLoadRequestId) state.dateLoadController = null;
  }
}

function confirmArchiveDate() {
  const input = document.getElementById("date-input");
  const hint = document.getElementById("date-hint");
  if (!input.value) {
    hint.textContent = "Pilih tanggal dulu.";
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
  // Peta di-init dengan lebar 0 di belakang overlay landing; ukur ulang begitu
  // ia tampil. setSidebarCollapsed hanya memicu invalidateSize saat benar-benar
  // meng-uncollapse, yang TIDAK terjadi pada masuk-pertama normal. Meniru refresh
  // toggle sidebar supaya tile/sel mengisi kontainer penuh, bukan strip sempit.
  requestAnimationFrame(() => state.map && state.map.invalidateSize());
  window.setTimeout(() => state.map && state.map.invalidateSize(), 260);
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
  document.getElementById("landing-archive-range").textContent = `${arc.start_date} sampai ${arc.end_date}`;
  document.getElementById("landing-cell-count").textContent = `${state.meta.n_cells} sel H3`;
  document.getElementById("landing-slot-list").textContent = `${slotText} WIB`;
  document.getElementById("landing-mode-label").textContent = modeInfo(state.simulationMode).label;

  const strip = document.getElementById("landing-scale-strip");
  strip.innerHTML = "";
  state.meta.legend.forEach((entry) => {
    const segment = document.createElement("span");
    segment.title = `${entry.category}`;
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
  document.getElementById("blur-toggle").addEventListener("click", () => setBlurUnvalidated(!state.blurUnvalidated));
  document.getElementById("date-input").addEventListener("change", (e) => {
    const hint = document.getElementById("date-hint");
    syncHistoricalDateGate();
    if (!e.target.value) return;
    if (hasLoadedSelectedDate()) {
      hint.textContent = `Menampilkan simulasi historis untuk ${e.target.value}.`;
      hint.classList.remove("warn");
      return;
    }
    hint.textContent =
      `Tanggal ${e.target.value} dipilih. Tekan Tampilkan tanggal untuk memuatnya dan mengaktifkan kontrol di bawah.`;
    hint.classList.add("warn");
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
      setLocateHint("Browser ini tidak mendukung geolokasi. Pakai pilihan Lat / lon.", true);
      return;
    }
    const original = locateBtn.textContent;
    locateBtn.disabled = true;
    locateBtn.textContent = "Mencari…";
    setLocateHint("Meminta izin lokasi kamu…", false);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.disabled = false;
        locateBtn.textContent = original;
        const { latitude: lat, longitude: lng } = pos.coords;
        selectByLatLng(lat, lng); // resolves the hex cell + shows the (pending) readout
        const cell = h3.latLngToCell(lat, lng, state.resolution);
        if (state.h3ToLayer.has(cell)) {
          state.map.setView([lat, lng], Math.max(state.map.getZoom(), 13));
          setLocateHint("Menampilkan sel hex di lokasi kamu.", false);
        } else {
          if (state.geoLayer) state.map.fitBounds(state.geoLayer.getBounds());
          setLocateHint("Lokasi kamu di luar grid wilayah studi Jakarta. Yang ditampilkan area yang tercakup.", true);
        }
      },
      (err) => {
        locateBtn.disabled = false;
        locateBtn.textContent = original;
        const reason = { 1: "izin ditolak", 2: "posisi tidak tersedia", 3: "permintaan kehabisan waktu" };
        let msg = "Lokasi kamu tidak bisa diambil (" + (reason[err.code] || err.message) + ").";
        if (!window.isSecureContext) msg += " Fitur lokasi butuh HTTPS atau localhost.";
        msg += " Coba pakai pilihan Lat / lon.";
        setLocateHint(msg, true);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  document.getElementById("go-btn").addEventListener("click", () => {
    const lat = parseFloat(document.getElementById("lat-input").value);
    const lng = parseFloat(document.getElementById("lon-input").value);
    if (Number.isNaN(lat) || Number.isNaN(lng)) { alert("Masukkan lat/lon yang valid."); return; }
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
    const dateStr = state.archiveDate;
    const requestId = state.dateLoadRequestId;
    const clim = await loadClimatologyDate(dateStr);
    if (dateStr !== state.archiveDate || requestId !== state.dateLoadRequestId) return;
    if (!clim) {
      state.climatology = null;
      const note = document.getElementById("simulation-note");
      note.textContent = "Lapisan klimatologi tidak tersedia untuk tanggal ini. Yang aktif tetap simulasi model saja.";
      note.classList.add("warn");
      return;
    }
    state.climatology = clim;
  }
  if (mode === "raw") state.climatology = null;
  state.simulationMode = mode;
  renderSimulationControls();
  document.getElementById("simulation-note").classList.remove("warn");
  renderLandingDashboard();
  refreshAfterForecastChange();
}

function setSidebarCollapsed(collapsed) {
  const layout = document.getElementById("layout");
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  layout.classList.toggle("sidebar-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", collapsed ? "Buka panel samping" : "Tutup panel samping");
  toggle.title = collapsed ? "Buka panel samping" : "Tutup panel samping";
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
    `Tanggal historis yang tersedia: ${arc.start_date} sampai ${arc.end_date}.`;

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
  syncHistoricalDateGate();
}

boot().catch((e) => {
  console.error(e);
  alert("Gagal memuat data situs. Jalankan `python web/build_web_data.py` dulu, lalu layani foldernya.");
});
