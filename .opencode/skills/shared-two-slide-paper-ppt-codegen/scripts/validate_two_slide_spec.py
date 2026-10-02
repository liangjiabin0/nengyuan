import json
import re
import sys
from pathlib import Path


FORBIDDEN_VISIBLE_PATTERNS = (
    r"图、?公式和流程按.*组合",
    r"论文图与表格数据共同支撑",
    r"论文结果",
    r"公式来源",
    r"来源[：:]",
    r"未运行作者代码",
    r"根据论文",
    r"此处放置",
    r"用于补充版面",
)


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def visible_strings(value, path="root"):
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"evidenceRef", "sourcePath", "templatePptx", "paperTitle", "doi", "latex", "methodGraphPath", "methodModelPath", "assetPath"}:
                continue
            yield from visible_strings(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from visible_strings(child, f"{path}[{index}]")
    elif isinstance(value, str):
        yield path, value


def summary_text(slide: dict) -> str:
    runs = slide.get("summaryRuns")
    if not isinstance(runs, list) or not runs:
        fail("each slide requires non-empty summaryRuns")
    if any(not isinstance(run, dict) or not run.get("text") for run in runs):
        fail("every summary run requires text")
    return "".join(run["text"] for run in runs)


def validate_chart(chart: dict, location: str) -> None:
    categories = chart.get("categories", [])
    series = chart.get("series", [])
    if not categories or not series:
        fail(f"{location} chart requires categories and series")
    for item in series:
        values = item.get("values", [])
        if len(values) != len(categories) or not all(isinstance(value, (int, float)) for value in values):
            fail(f"{location} chart series must contain one numeric value per category")
    for key in ("xTitle", "yTitle", "evidenceRef"):
        if not chart.get(key):
            fail(f"{location} chart missing {key}")
    if not all(isinstance(chart.get(key), (int, float)) for key in ("yMin", "yMax", "yMajorUnit")):
        fail(f"{location} chart requires numeric yMin, yMax, and yMajorUnit")
    if chart["yMax"] <= chart["yMin"] or chart["yMajorUnit"] <= 0:
        fail(f"{location} chart axis bounds and major unit are invalid")


def validate_table(table: dict, location: str) -> None:
    headers = table.get("headers", [])
    rows = table.get("rows", [])
    if not headers or not rows:
        fail(f"{location} table requires headers and rows")
    if any(len(row) != len(headers) for row in rows):
        fail(f"{location} table row width mismatch")


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: validate_two_slide_spec.py <spec.json>")
    path = Path(sys.argv[1])
    if not path.is_file():
        fail(f"spec not found: {path}")
    spec = json.loads(path.read_text(encoding="utf-8"))
    for key in ("meta", "slide1", "slide2"):
        if key not in spec:
            fail(f"missing top-level key: {key}")
    paper_type = spec["meta"].get("paperType")
    if paper_type not in {"planning", "forecasting"}:
        fail("meta.paperType must be planning or forecasting")
    method_path_key = "methodModelPath" if paper_type == "planning" else "methodGraphPath"
    if not spec["slide1"].get(method_path_key):
        fail(f"slide1 requires {method_path_key} for {paper_type}")

    for slide_key in ("slide1", "slide2"):
        slide = spec[slide_key]
        if not slide.get("title"):
            fail(f"{slide_key} requires title")
        summary = summary_text(slide)
        if len(summary) > 150 or summary.count("\n") > 1:
            fail(f"{slide_key} summary must fit within two lines")

    for location, text in visible_strings({"slide1": spec["slide1"], "slide2": spec["slide2"]}):
        for pattern in FORBIDDEN_VISIBLE_PATTERNS:
            if re.search(pattern, text, flags=re.IGNORECASE):
                fail(f"backstage/source wording is not allowed at {location}: {text}")

    panels = spec["slide1"].get("panels", [])
    if not 1 <= len(panels) <= 3:
        fail("slide1 requires one to three panels")
    formulas = spec["slide1"].get("formulas", [])
    formula_ids = {formula.get("id") for formula in formulas}
    if None in formula_ids or len(formula_ids) != len(formulas):
        fail("formula ids must be non-empty and unique")
    for formula in formulas:
        if not formula.get("latex") or not formula.get("evidenceRef"):
            fail("each formula requires latex and evidenceRef")
    for panel in panels:
        if not panel.get("title") or not panel.get("conclusion") or not panel.get("evidenceRef"):
            fail("every slide1 panel requires title, conclusion, and evidenceRef")
        for formula_id in panel.get("formulaIds", []):
            if formula_id not in formula_ids:
                fail(f"unknown formula id: {formula_id}")

    modules = spec["slide2"].get("resultModules")
    if modules is not None:
        if not isinstance(modules, list) or len(modules) != 3:
            fail("slide2.resultModules requires exactly three thematic modules")
        for module_index, module in enumerate(modules):
            for key in ("title", "conclusion", "evidenceRef"):
                if not module.get(key):
                    fail(f"resultModules[{module_index}] missing {key}")
            visuals = module.get("visuals")
            if not isinstance(visuals, list) or not visuals:
                fail(f"resultModules[{module_index}] needs at least one visual")
            for visual_index, visual in enumerate(visuals):
                location = f"resultModules[{module_index}].visuals[{visual_index}]"
                visual_type = visual.get("type")
                if visual_type not in {"chart", "table", "diagram", "source-figure", "metrics"}:
                    fail(f"{location}.type is invalid")
                if not visual.get("evidenceRef"):
                    fail(f"{location} missing evidenceRef")
                if visual_type == "chart":
                    validate_chart(visual, location)
                elif visual_type == "table":
                    validate_table(visual, location)
                elif visual_type == "source-figure" and not visual.get("assetPath"):
                    fail(f"{location} source-figure requires assetPath")
                elif visual_type == "diagram" and not visual.get("description"):
                    fail(f"{location} diagram requires description")
                elif visual_type == "metrics" and not visual.get("values"):
                    fail(f"{location} metrics requires values")
        print("PASS: two-slide spec and visible-language gate validated")
        return

    charts = spec["slide2"].get("charts", [])
    if not 1 <= len(charts) <= 3:
        fail("slide2 requires one to three chart modules")
    for chart in charts:
        validate_chart(chart, chart.get("title", "legacy chart"))
        for key in ("conclusion",):
            if not chart.get(key):
                fail(f"chart missing {key}")

    third = spec["slide2"].get("thirdModule")
    if len(charts) < 3 and not third:
        fail("slide2 requires three parallel modules; provide thirdModule")
    if third:
        if third.get("type") not in {"table", "chart", "figure"}:
            fail("thirdModule.type must be table, chart, or figure")
        for key in ("title", "conclusion", "evidenceRef"):
            if not third.get(key):
                fail(f"thirdModule missing {key}")
        if third["type"] == "table":
            validate_table(third, "thirdModule")

    print("PASS: two-slide spec and visible-language gate validated")


if __name__ == "__main__":
    main()
