import copy
import unittest

from lineage_engine import _scope_result, prepare_catalog, scope_artifacts


def fixture(materialized="view", sql="select id, upper(name) as name from db.raw.people"):
    manifest = {
        "metadata": {"adapter_type": "duckdb"},
        "nodes": {
            "model.proj.people": {
                "name": "people_model",
                "resource_type": "model",
                "database": "db",
                "schema": "mart",
                "alias": "people_model",
                "compiled_code": sql,
                "config": {"materialized": materialized},
            }
        },
        "sources": {
            "source.proj.raw.people": {
                "name": "people",
                "identifier": "people",
                "resource_type": "source",
                "database": "db",
                "schema": "raw",
                "config": {},
            }
        },
        "parent_map": {"model.proj.people": ["source.proj.raw.people"]},
    }
    source = {
        "unique_id": "source.proj.raw.people",
        "metadata": {"type": "TABLE", "database": "db", "schema": "raw", "name": "people"},
        "columns": {
            "id": {"name": "id", "type": "INTEGER"},
            "name": {"name": "name", "type": "VARCHAR"},
        },
    }
    return manifest, {"nodes": {}, "sources": {"source.proj.raw.people": source}}


class PrepareCatalogTest(unittest.TestCase):
    def test_scopes_manifest_catalog_and_dependency_maps_before_parsing(self):
        manifest, catalog = fixture()
        manifest["nodes"]["model.proj.hidden"] = {
            "name": "hidden", "resource_type": "model", "compiled_code": "invalid sql ((("
        }
        catalog["nodes"]["model.proj.hidden"] = {"columns": {"secret": {"name": "secret"}}}
        manifest["parent_map"]["model.proj.hidden"] = ["model.proj.people"]
        manifest["child_map"] = {
            "source.proj.raw.people": ["model.proj.people"],
            "model.proj.people": ["model.proj.hidden"],
        }

        scoped_manifest, scoped_catalog = scope_artifacts(
            manifest, catalog, {"source.proj.raw.people", "model.proj.people"}
        )

        self.assertNotIn("model.proj.hidden", scoped_manifest["nodes"])
        self.assertNotIn("model.proj.hidden", scoped_catalog["nodes"])
        self.assertEqual(scoped_manifest["child_map"]["model.proj.people"], [])

    def test_removes_hidden_dependency_placeholders_from_output(self):
        result = {
            "nodes": {"model.visible": {}, "model.hidden": {}},
            "lineage": {
                "edges": [
                    {"source": "model.hidden", "target": "model.visible"},
                    {"source": "model.visible", "target": "model.visible"},
                ],
                "parents": {"model.visible": {}, "model.hidden": {}},
                "children": {"model.visible": {}, "model.hidden": {}},
            },
            "tree": {"model.hidden": {}},
        }

        scoped = _scope_result(result, {"model.visible"})

        self.assertEqual(set(scoped["nodes"]), {"model.visible"})
        self.assertEqual(len(scoped["lineage"]["edges"]), 1)
        self.assertEqual(scoped["tree"], {})

    def test_infers_missing_persistent_model(self):
        manifest, catalog = fixture()
        augmented, inspection = prepare_catalog(manifest, catalog)
        self.assertEqual(inspection["missing"], ["model.proj.people"])
        self.assertEqual(set(augmented["nodes"]["model.proj.people"]["columns"]), {"id", "name"})

    def test_detects_physical_schema_divergence(self):
        manifest, catalog = fixture()
        actual = copy.deepcopy(catalog["sources"]["source.proj.raw.people"])
        actual["unique_id"] = "model.proj.people"
        actual["metadata"].update({"type": "VIEW", "schema": "mart", "name": "people_model"})
        actual["columns"].pop("name")
        catalog["nodes"]["model.proj.people"] = actual

        _, inspection = prepare_catalog(manifest, catalog)

        self.assertEqual(inspection["divergent"], ["model.proj.people"])

    def test_infers_ephemeral_without_requiring_a_relation(self):
        manifest, catalog = fixture(materialized="ephemeral")
        augmented, inspection = prepare_catalog(manifest, catalog)
        self.assertEqual(inspection["ephemeral"], ["model.proj.people"])
        self.assertEqual(set(augmented["nodes"]["model.proj.people"]["columns"]), {"id", "name"})

    def test_marks_unexpandable_star_unknown_and_missing(self):
        manifest, catalog = fixture(sql="select * from db.raw.people")
        catalog["sources"] = {}
        _, inspection = prepare_catalog(manifest, catalog)
        self.assertEqual(inspection["unknown"], ["model.proj.people"])
        self.assertEqual(inspection["missing"], ["model.proj.people"])


if __name__ == "__main__":
    unittest.main()
