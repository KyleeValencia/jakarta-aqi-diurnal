from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]


class WebResilienceStaticTests(unittest.TestCase):
    def test_runtime_libraries_are_local(self):
        html = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertNotIn("cdn.jsdelivr.net", html)
        self.assertNotIn("unpkg.com", html)

        local_refs = re.findall(r'(?:href|src)="(vendor/[^"]+)"', html)
        self.assertEqual(len(local_refs), 6)
        for relative in local_refs:
            self.assertTrue((ROOT / relative).is_file(), relative)

    def test_leaflet_css_assets_are_complete(self):
        css_path = ROOT / "vendor" / "leaflet-1.9.4" / "leaflet.css"
        css = css_path.read_text(encoding="utf-8")
        image_refs = set(re.findall(r"url\(images/([^)]+)\)", css))
        self.assertEqual(
            image_refs,
            {
                "layers-2x.png",
                "layers.png",
                "marker-icon.png",
            },
        )
        runtime_images = image_refs | {"marker-icon-2x.png", "marker-shadow.png"}
        for image in runtime_images:
            self.assertTrue((css_path.parent / "images" / image).is_file(), image)

    def test_vendor_versions_and_licenses_are_recorded(self):
        notices = (ROOT / "vendor" / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        for version in ("5.3.3", "1.9.4", "4.4.1", "4.1.0"):
            self.assertIn(version, notices)
        for license_file in (
            "bootstrap-5.3.3/LICENSE",
            "leaflet-1.9.4/LICENSE",
            "chart.js-4.4.1/LICENSE.md",
            "h3-js-4.1.0/LICENSE",
            "h3-js-4.1.0/NOTICE",
        ):
            self.assertTrue((ROOT / "vendor" / license_file).is_file(), license_file)

    def test_date_failure_and_race_guards_are_present(self):
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn("function resetForecastState()", app)
        self.assertIn("dateLoadRequestId", app)
        self.assertIn("dateLoadController.abort()", app)
        self.assertIn('show("result-card", false)', app)
        self.assertIn("state.chart.destroy()", app)
        self.assertIn("state.geoLayer.setStyle(styleForFeature)", app)


if __name__ == "__main__":
    unittest.main()
