"""Minimal bundled entry point for dbt column lineage.

The VS Code extension consumes only colibri-manifest.json, so this deliberately
skips dbt-colibri's HTML dashboard and telemetry paths. PyInstaller turns this
module, dbt-colibri and sqlglot into one executable for the target OS/CPU.
"""

from __future__ import annotations

import argparse
import copy
import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from sqlglot import exp
from sqlglot.lineage import maybe_parse
from dbt_colibri.lineage_extractor.extractor import get_select_expressions
from dbt_colibri.lineage_extractor.extractor import DbtColumnLineageExtractor
from dbt_colibri.lineage_extractor.lineage import prepare_scope
from dbt_colibri.report.generator import DbtColibriReportGenerator
from dbt_colibri.utils.log import setup_logging


def scope_artifacts(
    manifest: dict[str, Any], catalog: dict[str, Any], node_ids: set[str] | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return an exact visible-subgraph view of dbt's artifacts.

    Filtering before DbtColumnLineageExtractor is constructed is the important
    performance boundary: hidden models are never handed to SQLGlot/Colibri,
    rather than merely being removed from the finished payload.
    """
    if node_ids is None:
        return manifest, catalog

    scoped_manifest = copy.deepcopy(manifest)
    for section in ("nodes", "sources"):
        scoped_manifest[section] = {
            node_id: node
            for node_id, node in manifest.get(section, {}).items()
            if node_id in node_ids
        }
        for node in scoped_manifest[section].values():
            depends_on = node.get("depends_on")
            if isinstance(depends_on, dict) and isinstance(depends_on.get("nodes"), list):
                depends_on["nodes"] = [related for related in depends_on["nodes"] if related in node_ids]
    for map_name in ("parent_map", "child_map"):
        scoped_manifest[map_name] = {
            node_id: [related for related in related_ids if related in node_ids]
            for node_id, related_ids in manifest.get(map_name, {}).items()
            if node_id in node_ids
        }

    scoped_catalog = copy.deepcopy(catalog)
    for section in ("nodes", "sources"):
        scoped_catalog[section] = {
            node_id: node
            for node_id, node in catalog.get(section, {}).items()
            if node_id in node_ids
        }
    return scoped_manifest, scoped_catalog


def _scope_result(result: dict[str, Any], node_ids: set[str] | None) -> dict[str, Any]:
    if node_ids is None:
        return result
    result["nodes"] = {
        node_id: node for node_id, node in result.get("nodes", {}).items()
        if node_id in node_ids
    }
    lineage = result.get("lineage") or {}
    lineage["edges"] = [
        edge for edge in lineage.get("edges", [])
        if edge.get("source") in node_ids and edge.get("target") in node_ids
    ]
    for direction in ("parents", "children"):
        lineage[direction] = {
            node_id: {
                column: [item for item in related if item.get("dbt_node") in node_ids]
                for column, related in columns.items()
            }
            for node_id, columns in lineage.get(direction, {}).items()
            if node_id in node_ids
        }
    result["lineage"] = lineage
    # The extension consumes nodes + lineage; dropping Colibri's redundant
    # hierarchy prevents hidden dependency placeholders leaking into the
    # temporary JSON without affecting column tracing.
    result["tree"] = {}
    return result


def _dialect(manifest: dict[str, Any]) -> str:
    adapter = manifest.get("metadata", {}).get("adapter_type")
    if not adapter:
        raise ValueError("adapter_type not found in manifest metadata")
    return "tsql" if adapter == "sqlserver" else adapter


def _relation_parts(node: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(node.get("database") or "").strip('"`'),
        str(node.get("schema") or "").strip('"`'),
        str(node.get("alias") or node.get("identifier") or node.get("name") or "").strip('"`'),
    )


def _catalog_columns(entry: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    return (entry or {}).get("columns") or {}


def _schema_for_parents(
    node_id: str,
    manifest: dict[str, Any],
    columns_by_id: dict[str, dict[str, dict[str, Any]]],
) -> dict[str, Any]:
    schema: dict[str, Any] = {}
    all_nodes = {**manifest.get("nodes", {}), **manifest.get("sources", {})}
    for parent_id in manifest.get("parent_map", {}).get(node_id, []):
        parent = all_nodes.get(parent_id)
        columns = columns_by_id.get(parent_id)
        if not parent or not columns:
            continue
        database, namespace, relation = _relation_parts(parent)
        if not relation:
            continue
        typed = {name.lower(): str(meta.get("type") or "UNKNOWN") for name, meta in columns.items()}
        if database and namespace:
            schema.setdefault(database, {}).setdefault(namespace, {})[relation] = typed
        elif namespace:
            schema.setdefault(namespace, {})[relation] = typed
        else:
            schema[relation] = typed
    return schema


def _infer_projection(
    node_id: str,
    node: dict[str, Any],
    manifest: dict[str, Any],
    columns_by_id: dict[str, dict[str, dict[str, Any]]],
    dialect: str,
) -> tuple[list[str], bool]:
    sql = node.get("compiled_code") or node.get("compiled_sql")
    if not sql or str(node.get("path") or "").endswith(".py"):
        return [], False
    try:
        parsed = maybe_parse(sql, dialect=dialect)
        schema = _schema_for_parents(node_id, manifest, columns_by_id)
        try:
            parsed, _ = prepare_scope(parsed, schema=schema, dialect=dialect)
        except Exception:
            # Explicit aliases/column names are still useful when qualification
            # fails; an unresolved star below keeps the result in UNKNOWN.
            pass
        names: list[str] = []
        complete = True
        for selected in get_select_expressions(parsed):
            if isinstance(selected, exp.Star) or any(isinstance(part, exp.Star) for part in selected.walk()):
                complete = False
                continue
            name = selected.alias_or_name or selected.output_name
            if not name:
                complete = False
                continue
            normalized = str(name).strip('"`').lower()
            if normalized and normalized not in names:
                names.append(normalized)
        return names, complete and bool(names)
    except Exception as error:
        logging.getLogger("colibri").warning("Could not infer projection for %s: %s", node_id, error)
        return [], False


def _type_matches(materialized: str, catalog_type: str) -> bool:
    expected = materialized.lower().replace("-", "_")
    actual = catalog_type.lower().replace("-", "_").replace(" ", "_")
    if expected == "incremental":
        return "table" in actual and "view" not in actual
    if expected == "table":
        return "table" in actual and "view" not in actual
    if expected == "view":
        return actual == "view" or actual.endswith("_view") and "materialized" not in actual
    if expected == "materialized_view":
        return "materialized" in actual and "view" in actual
    # Custom materializations do not have a portable information-schema type.
    return True


def _synthetic_catalog_entry(node_id: str, node: dict[str, Any], columns: list[str]) -> dict[str, Any]:
    database, namespace, relation = _relation_parts(node)
    return {
        "unique_id": node_id,
        "metadata": {
            "type": "CTE" if node.get("config", {}).get("materialized") == "ephemeral" else "INFERRED",
            "database": database,
            "schema": namespace,
            "name": relation,
        },
        "columns": {
            name: {"name": name, "type": "UNKNOWN", "index": index}
            for index, name in enumerate(columns, start=1)
        },
    }


def prepare_catalog(
    manifest: dict[str, Any], catalog: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, list[str]]]:
    """Infer logical projections, classify physical divergence, and augment
    catalog data for models (especially ephemerals) without physical rows."""
    augmented = copy.deepcopy(catalog)
    augmented.setdefault("nodes", {})
    augmented.setdefault("sources", {})
    columns_by_id: dict[str, dict[str, dict[str, Any]]] = {
        node_id: _catalog_columns(entry)
        for section in ("nodes", "sources")
        for node_id, entry in augmented.get(section, {}).items()
    }
    inspection = {key: [] for key in ("current", "divergent", "missing", "unknown", "ephemeral")}
    dialect = _dialect(manifest)

    models = {
        node_id: node
        for node_id, node in manifest.get("nodes", {}).items()
        if node.get("resource_type") in ("model", "snapshot")
    }
    pending = set(models)
    processed: set[str] = set()
    while pending:
        ready = sorted(
            node_id for node_id in pending
            if all(parent not in models or parent in processed
                   for parent in manifest.get("parent_map", {}).get(node_id, []))
        )
        if not ready:  # Defensive cycle fallback; dbt DAGs should be acyclic.
            ready = [sorted(pending)[0]]
        for node_id in ready:
            pending.remove(node_id)
            processed.add(node_id)
            node = models[node_id]
            inferred, complete = _infer_projection(node_id, node, manifest, columns_by_id, dialect)
            materialized = str(node.get("config", {}).get("materialized") or "view")
            actual = augmented["nodes"].get(node_id)

            if materialized == "ephemeral":
                inspection["ephemeral"].append(node_id)
                if complete:
                    synthetic = _synthetic_catalog_entry(node_id, node, inferred)
                    augmented["nodes"][node_id] = synthetic
                    columns_by_id[node_id] = synthetic["columns"]
                continue

            if not complete:
                inspection["unknown"].append(node_id)
                if not actual:
                    inspection["missing"].append(node_id)
                continue

            if not actual:
                inspection["missing"].append(node_id)
                synthetic = _synthetic_catalog_entry(node_id, node, inferred)
                augmented["nodes"][node_id] = synthetic
                columns_by_id[node_id] = synthetic["columns"]
                continue

            actual_names = {name.lower() for name in _catalog_columns(actual)}
            catalog_type = str((actual.get("metadata") or {}).get("type") or "")
            if actual_names != set(inferred) or not _type_matches(materialized, catalog_type):
                inspection["divergent"].append(node_id)
            else:
                inspection["current"].append(node_id)
            columns_by_id[node_id] = _catalog_columns(actual)

    return augmented, inspection


def generate(
    manifest: str, catalog: str, output_dir: str, node_ids_file: str | None = None
) -> None:
    setup_logging(logging.INFO)
    with open(manifest, encoding="utf-8") as handle:
        manifest_doc = json.load(handle)
    with open(catalog, encoding="utf-8") as handle:
        catalog_doc = json.load(handle)
    selected_node_ids = None
    if node_ids_file:
        with open(node_ids_file, encoding="utf-8") as handle:
            selected_node_ids = {str(node_id) for node_id in json.load(handle)}
    manifest_doc, catalog_doc = scope_artifacts(manifest_doc, catalog_doc, selected_node_ids)
    augmented_catalog, inspection = prepare_catalog(manifest_doc, catalog_doc)

    temporary_manifest = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
    temporary_catalog = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
    try:
        with temporary_manifest:
            json.dump(manifest_doc, temporary_manifest)
        with temporary_catalog:
            json.dump(augmented_catalog, temporary_catalog)
        extractor = DbtColumnLineageExtractor(temporary_manifest.name, temporary_catalog.name)
        generator = DbtColibriReportGenerator(
            extractor,
            light_mode=True,
            disable_telemetry=True,
        )
        result = generator.build_full_lineage()
    finally:
        os.unlink(temporary_manifest.name)
        os.unlink(temporary_catalog.name)

    result = _scope_result(result, selected_node_ids)
    result["dbtOpenLineageInspection"] = inspection

    # Parsing diagnostics are useful in the extension-host logs, but the
    # TypeScript payload extractor only consumes nodes + lineage.edges.
    errors = result.pop("errors", [])
    if errors:
        logging.getLogger("colibri").warning(
            "%d model(s) had SQL lineage parsing errors", len(errors)
        )

    target = Path(output_dir)
    target.mkdir(parents=True, exist_ok=True)
    with (target / "colibri-manifest.json").open("w", encoding="utf-8") as handle:
        json.dump(result, handle)


def main() -> None:
    parser = argparse.ArgumentParser(prog="lineage-engine")
    subcommands = parser.add_subparsers(dest="command", required=True)
    generate_parser = subcommands.add_parser("generate")
    generate_parser.add_argument("--manifest", required=True)
    generate_parser.add_argument("--catalog", required=True)
    generate_parser.add_argument("--output-dir", required=True)
    generate_parser.add_argument("--node-ids-file")
    # Kept for compatibility with the existing TypeScript runner. This entry
    # point is always light and telemetry-free regardless of the flags.
    generate_parser.add_argument("--light", action="store_true")
    generate_parser.add_argument("--disable-telemetry", action="store_true")
    args = parser.parse_args()

    if args.command == "generate":
        generate(args.manifest, args.catalog, args.output_dir, args.node_ids_file)


if __name__ == "__main__":
    main()
