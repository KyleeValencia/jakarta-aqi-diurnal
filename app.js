/* Jakarta AQI - static front-end (r7, NB8 contract).
 *
 * Consumes three static files from web/data (produced by build_web_data.py):
 *   meta.json           - resolution, model_status, anchor_date, slot_hours, horizons, legend, disclaimers
 *   forecast_r{R}.json  - { model_status, anchor_date, slot_hours, horizons_h,
 *                           cells: { h3_id: { slot_h: [ {offset_h, value, category, colour} ] } } }
 *                         (slot_h = a fixed clock slot; the page shows the slot nearest "now"
 *                          in WIB. A legacy flat { h3_id: [ series ] } is still accepted.)
 *   hexes_r{R}.geojson  - hex-cell polygons (+ h3_id, center_lat/lon)
 *
 * AQI scale, category and colour all come from meta (exported from aqi_models.physics),
 * so nothing about the scale is hardcoded here.
 *
 * Two states, driven by meta.model_status:
 *   "pending_retrain" - coming-soon: map + location tools work, but per-cell values
 *                       show an honest "awaiting model output" message.
 *   "live"            - real forecasts shown (value, category, diurnal chart).
 */

const JAKARTA_CENTER = [-6.2, 106.84];
const state = {
  meta: null,
  forecast: null,
  resolution: 7,
  h3ToLayer: new Map(),
  geoLayer: null,
  maskLayer: null,
  selectedLayer: null,
  locationMarker: null,
  chart: null,
  currentSlot: null, // the diurnal clock slot nearest "now" (null for legacy flat data)
  mode: "current", // "current" | "other"
};

const isPending = () => !state.meta || state.meta.model_status === "pending_retrain";
const cellsMap = () => (state.forecast && state.forecast.cells) || {};
const show = (id, on) => document.getElementById(id).classList.toggle("hidden", !on);

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

// ---------------------------------------------------------------------------
// Diurnal clock-slice: the forecast carries every fixed clock slot; the page
// shows the slot nearest the user's current WIB time (current + next-3, weather-
// forecast style). The data's slots are WIB clock hours, so "now" is WIB too.
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, "0");
const nowHourWIB = () => (new Date().getUTCHours() + 7) % 24; // WIB = UTC+7
const circDist = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };

function nearestSlot(hour) {
  const slots = (state.meta && state.meta.slot_hours) || [];
  if (!slots.length) return null;
  return slots.reduce((best, s) => (circDist(s, hour) < circDist(best, hour) ? s : best), slots[0]);
}

// The current-slot series for a cell. Accepts the slot-keyed shape
// { slot_h: [series] } and the legacy flat [series] (returned as-is).
function seriesForCell(h3id) {
  const cell = cellsMap()[h3id];
  if (!cell) return null;
  if (Array.isArray(cell)) return cell;                       // legacy flat (single anchor)
  const slot = state.currentSlot != null ? state.currentSlot : nearestSlot(nowHourWIB());
  return cell[String(slot)] || cell[Object.keys(cell)[0]] || null;
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
  const series = seriesForCell(feature.properties.h3_id);
  const idx = series ? series[0].value : null;
  return {
    fillColor: idx === null ? state.meta.no_data_color : series[0].colour || colorFor(idx),
    fillOpacity: 0.6,
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
    layer.setStyle({ color: "#111", weight: 2.5, fillOpacity: isPending() ? 0.45 : 0.8 });
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
  show("result-card", true);
  const layer = state.h3ToLayer.get(h3id) || null;
  const onGrid = layer !== null;
  highlight(layer);
  if (layer) state.map.panTo(layer.getBounds().getCenter());

  const coordTxt = lat != null ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : "";
  document.getElementById("result-meta").innerHTML =
    `Cell <code>${h3id}</code>${coordTxt ? "<br>" + coordTxt : ""}` +
    (onGrid ? "" : `<br><span class="warn">Outside the Jakarta study grid.</span>`);

  // --- PENDING (coming-soon) state ---
  if (isPending()) {
    show("aqi-readout", false);
    show("forecast-section", false);
    show("aqi-pending", true);
    document.getElementById("pending-text").textContent = onGrid
      ? state.meta.model_note
      : "This location is outside the Jakarta mainland study grid, so it has no forecast cell.";
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }

  // --- LIVE state ---
  show("aqi-pending", false);
  const series = seriesForCell(h3id);
  if (!series) {
    show("aqi-readout", true);
    show("forecast-section", false);
    document.getElementById("aqi-value").textContent = "—";
    const badge = document.getElementById("aqi-badge");
    badge.textContent = "Outside coverage";
    badge.style.background = state.meta.no_data_color;
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }
  show("aqi-readout", true);
  show("forecast-section", true);
  const now = series[0];
  const e = legendEntryFor(now.value);
  document.getElementById("aqi-value").textContent = Math.round(now.value);
  const badge = document.getElementById("aqi-badge");
  badge.textContent = `${now.category || e.category} · ${e.english}`;
  badge.style.background = now.colour || e.color;
  renderChart(series);
  renderStepBadges(series);
}

// ---------------------------------------------------------------------------
// Forecast chart + step badges
// ---------------------------------------------------------------------------
const stepLabel = (offsetH) => (offsetH === 0 ? "Now" : `+${offsetH}h`);

// Absolute time of the current slot's anchor: new shape = anchor_date + slot hour;
// legacy = meta.anchor_ts. Returns null if neither is available.
function stepBase() {
  if (state.meta.anchor_date && state.currentSlot != null) {
    const d = new Date(String(state.meta.anchor_date) + "T00:00:00");
    if (!isNaN(d.getTime())) return new Date(d.getTime() + state.currentSlot * 3600 * 1000);
  }
  if (state.meta.anchor_ts) {
    const d = new Date(String(state.meta.anchor_ts).replace(" ", "T"));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function stepClock(offsetH) {
  const base = stepBase();
  if (!base) return "";
  const t = new Date(base.getTime() + offsetH * 3600 * 1000);
  return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function renderChart(series) {
  const labels = series.map((s) => {
    const clk = stepClock(s.offset_h);
    return clk ? `${stepLabel(s.offset_h)}\n${clk}` : stepLabel(s.offset_h);
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
        y: { beginAtZero: true, suggestedMax: 150, title: { display: true, text: "ISPU index" } },
        x: { ticks: { maxRotation: 0, autoSkip: false } },
      },
    },
  });
}

function renderStepBadges(series) {
  const wrap = document.getElementById("step-badges");
  wrap.innerHTML = "";
  series.forEach((s) => {
    const e = legendEntryFor(s.value);
    const clk = stepClock(s.offset_h);
    const div = document.createElement("div");
    div.className = "sb";
    div.innerHTML =
      `<div class="sb-time">${stepLabel(s.offset_h)}${clk ? " · " + clk : ""}</div>` +
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
      `<span>${e.category} <em>(${e.english})</em></span>` +
      `<span class="range">${range}</span>`;
    ul.appendChild(li);
    lower = (e.upper ?? lower) + 1;
  });
}

function renderBanner() {
  const b = document.getElementById("status-banner");
  if (isPending()) {
    b.className = "banner banner-pending";
    b.innerHTML = `<strong>PREVIEW</strong> &mdash; ${state.meta.model_note}`;
  } else {
    b.className = "banner banner-live";
    const anchorTxt = state.meta.anchor_date
      ? `${state.meta.anchor_date}${state.currentSlot != null ? " " + pad2(state.currentSlot) + ":00" : ""}`
      : (state.meta.anchor_ts || "—");
    b.innerHTML = `Live forecast &middot; anchor ${anchorTxt} (WIB)`;
  }
}

function renderAbout() {
  document.getElementById("about-disclaimers").innerHTML =
    state.meta.disclaimers.map((d) => `<li>${d}</li>`).join("");
  const tail = isPending()
    ? "forecast pending re-train"
    : `${state.meta.n_forecast_cells} cells forecast`;
  document.getElementById("footer-note").textContent =
    `${state.meta.n_cells} hex cells · resolution r${state.resolution} · ${tail}`;
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("mode-current").classList.toggle("active", mode === "current");
  document.getElementById("mode-other").classList.toggle("active", mode === "other");
  show("panel-current", mode === "current");
  show("panel-other", mode === "other");
}

function wireControls() {
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
  document.getElementById("about-btn").addEventListener("click", () => overlay.classList.remove("hidden"));
  document.getElementById("about-close").addEventListener("click", () => overlay.classList.add("hidden"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.add("hidden"); });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // meta first (it carries the resolution that names the other two files)
  const meta = await fetch("data/meta.json").then((r) => r.json());
  state.meta = meta;
  state.resolution = meta.resolution;

  const [forecast, geojson] = await Promise.all([
    fetch(`data/forecast_r${meta.resolution}.json`).then((r) => r.json()),
    fetch(`data/hexes_r${meta.resolution}.geojson`).then((r) => r.json()),
  ]);
  state.forecast = forecast;
  state.currentSlot = (meta.slot_hours && meta.slot_hours.length) ? nearestSlot(nowHourWIB()) : null;
  document.getElementById("res-label").textContent = "r" + meta.resolution;

  initMap();
  addGeoLayer(geojson);
  addGridMask();
  renderLegend();
  renderBanner();
  renderAbout();
  wireControls();
  setMode("current");
}

boot().catch((e) => {
  console.error(e);
  alert("Failed to load web data. Run `python web/build_web_data.py` first, then serve the folder.");
});
