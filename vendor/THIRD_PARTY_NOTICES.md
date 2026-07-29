# Vendored runtime libraries

These files are local runtime copies sourced from the corresponding official npm packages.

| Library | Version | Runtime files | License |
|---|---:|---|---|
| Bootstrap | 5.3.3 | `bootstrap-5.3.3/css/bootstrap.min.css`, `bootstrap-5.3.3/js/bootstrap.bundle.min.js` | MIT; see `bootstrap-5.3.3/LICENSE` |
| Leaflet | 1.9.4 | `leaflet-1.9.4/leaflet.css`, `leaflet-1.9.4/leaflet.js`, and `leaflet-1.9.4/images/` | BSD-2-Clause; see `leaflet-1.9.4/LICENSE` |
| Chart.js | 4.4.1 | `chart.js-4.4.1/chart.umd.js` | MIT; see `chart.js-4.4.1/LICENSE.md` |
| h3-js | 4.1.0 | `h3-js-4.1.0/h3-js.umd.js` | Apache-2.0; see `h3-js-4.1.0/LICENSE` and `h3-js-4.1.0/NOTICE` |

Each directory also retains the package's `package.json` as machine-readable version and provenance metadata. The packages were acquired with `npm pack <package>@<version>`.
