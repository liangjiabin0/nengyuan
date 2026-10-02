#!/usr/bin/env python3
"""Build a task-specific, auditable program package around the TDMG solvers."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
VENDOR_DIR = SCRIPT_DIR / "_vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))
sys.path.insert(0, str(SCRIPT_DIR))

import modular_dispatch as modular
import tdmg_opf as core


class PipelineError(ValueError):
    """Raised when a task package cannot be prepared safely."""


GENERATED_FILES = (
    "generated_dispatch.py",
    "normalized_input.json",
    "model_document.md",
    "task_manifest.json",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_record(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    return {
        "path": str(path),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
    }


def resolve_existing(value: Path | None, label: str) -> Path | None:
    if value is None:
        return None
    path = value.resolve()
    if not path.is_file():
        raise PipelineError(f"{label} does not exist: {path}")
    return path


def detect_mode(input_path: Path, requested: str) -> str:
    if requested != "auto":
        return requested
    if input_path.suffix.lower() != ".json":
        return "snapshot"
    data = json.loads(input_path.read_text(encoding="utf-8-sig"))
    return "scenario" if isinstance(data, dict) and isinstance(data.get("studies"), list) else "snapshot"


def snapshot_spec(
    input_path: Path,
    sidecar_path: Path | None,
    profiles_path: Path | None,
    results_dir: Path,
    dc: bool,
) -> tuple[dict[str, Any], list[str]]:
    case = core.load_power_case(input_path)
    config = core.load_optional_json(sidecar_path)
    working_case = copy.deepcopy(case)
    prepared, static_resources = core.resource_models.prepare_config(working_case, config)
    area_map, levels = core.build_area_map(working_case, prepared)
    added = core.add_resources(working_case, prepared)
    metadata = core.build_generator_metadata(working_case, added)
    core.apply_overrides(working_case, area_map, prepared.get("overrides", {}), metadata)
    profiles = core.load_optional_json(profiles_path)
    periods = core.period_definitions(profiles)
    resource_counts = Counter(str(item.get("resource_type", item.get("kind", "unknown"))) for item in prepared.get("resources", []))
    command = [
        sys.executable,
        "-u",
        str(SCRIPT_DIR / "tdmg_opf.py"),
        "solve",
        str(input_path),
        "--output",
        str(results_dir),
    ]
    if sidecar_path:
        command.extend(["--config", str(sidecar_path)])
    if profiles_path:
        command.extend(["--profiles", str(profiles_path)])
    if dc:
        command.append("--dc")
    spec = {
        "mode": "snapshot",
        "case": source_record(input_path),
        "sidecar": source_record(sidecar_path),
        "profiles": source_record(profiles_path),
        "network": {
            "format": input_path.suffix.lower(),
            "base_mva": float(case["baseMVA"]),
            "buses": int(case["bus"].shape[0]),
            "native_generators": int(case["gen"].shape[0]),
            "branches": int(case["branch"].shape[0]),
            "areas": sorted(set(area_map.values())),
            "levels": levels,
        },
        "model": {
            "dc_diagnostic": dc,
            "periods": [item["name"] for item in periods],
            "dynamic_resources": len(prepared.get("resources", [])),
            "static_resources": len(static_resources),
            "resource_types": dict(sorted(resource_counts.items())),
            "automatic_resource_constraints": len(prepared.get("resource_constraints", [])),
            "explicit_resource_couplings": len(prepared.get("resource_couplings", [])),
        },
    }
    return spec, command


def scenario_spec(input_path: Path, results_dir: Path) -> tuple[dict[str, Any], list[str]]:
    validation = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "modular_dispatch.py"), "validate", str(input_path)],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    if validation.returncode != 0:
        message = validation.stderr.strip() or validation.stdout.strip() or "unknown validation error"
        raise PipelineError(f"Scenario validation failed: {message}")
    data = json.loads(input_path.read_text(encoding="utf-8-sig"))
    studies = modular.validate_scenario_shape(data)
    study_rows = []
    for study in studies:
        scales = study.get("time_scales") or [{"name": "base", "step_minutes": 60}]
        study_rows.append(
            {
                "name": str(study["name"]),
                "scope": study.get("scope", "all"),
                "modules": modular.unique_modules(study.get("modules")),
                "time_scales": [
                    {
                        "name": str(scale.get("name", "base")),
                        "step_minutes": float(scale.get("step_minutes", 60)),
                        "parent": scale.get("parent"),
                    }
                    for scale in scales
                ],
            }
        )
    command = [
        sys.executable,
        "-u",
        str(SCRIPT_DIR / "modular_dispatch.py"),
        "run",
        str(input_path),
        "--output",
        str(results_dir),
    ]
    return {
        "mode": "scenario",
        "scenario": source_record(input_path),
        "model": {"schema_version": data.get("schema_version"), "studies": study_rows},
        "validation_output": validation.stdout.strip(),
    }, command


def model_document(spec: dict[str, Any], request: str, command: list[str]) -> str:
    mode = spec["mode"]
    lines = [
        "# 主配微协同优化任务模型说明",
        "",
        "## 任务",
        "",
        request or "基于输入文件边界条件完成主配微有功无功协同优化调度。",
        "",
        "## 执行方式",
        "",
        f"- 模式：`{mode}`",
        f"- 求解命令：`{' '.join(command)}`",
        "- 数学内核：平衡、正序、稳态 AC-OPF；若明确启用 DC，仅作为有功诊断。",
        "- 任务程序：`generated_dispatch.py`，负责调用通用求解内核、实时记录日志并整理交付状态。",
        "",
        "## 核心模型",
        "",
        "- 决策量：节点电压幅值/相角以及在线资源有功、无功；时序模块按需携带 SOC、爬坡和剩余电量状态。",
        "- 约束：节点 P/Q 平衡、资源 P/Q/能力边界、电压边界、支路两端 MVA 容量、变压器与相角边界，以及配置的资源耦合。",
        "- 目标：MATPOWER/PYPOWER 成本，并按场景叠加网损、父子计划跟踪等已启用模块。",
        "- 边界：范围切割必须使用等值电网、固定交换或孤岛模式；完整 AC/DC、三相不平衡、整数启停和 N-1 不在当前内核中。",
        "",
        "## 标准化输入摘要",
        "",
        "```json",
        json.dumps(spec, ensure_ascii=False, indent=2),
        "```",
        "",
        "## 验证与交付",
        "",
        "求解后检查成功状态、最终可行性、电压、支路容量、资源边界、耦合残差、时序状态及边界交换。详细结果位于 `results/`，完整标准输出和错误输出位于 `solve.log`。",
        "",
    ]
    return "\n".join(lines)


def generated_program(task: dict[str, Any], command: list[str]) -> str:
    template = r'''#!/usr/bin/env python3
"""Task-specific dispatch program generated by tdmg-acopf-dispatch."""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path


TASK_DIR = Path(__file__).resolve().parent
TASK = __TASK__
COMMAND = __COMMAND__


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def delivery_report(returncode: int) -> str:
    status = "成功" if returncode == 0 else "失败"
    summary_candidates = [
        TASK_DIR / "results" / "portfolio_summary.json",
        TASK_DIR / "results" / "summary.json",
    ]
    summary = next((path for path in summary_candidates if path.is_file()), None)
    lines = [
        "# 主配微协同优化计算交付报告",
        "",
        f"- 状态：{status}",
        f"- 请求：{TASK.get('request') or '基于输入文件边界条件完成协同优化调度'}",
        f"- 输入：`{TASK['input']}`",
        f"- 执行模式：`{TASK['mode']}`",
        f"- 返回码：`{returncode}`",
        "",
        "## 交付物",
        "",
        "- `generated_dispatch.py`：本任务可重复执行程序",
        "- `normalized_input.json`：标准化输入与模型摘要",
        "- `model_document.md`：模型、边界和验证说明",
        "- `solve.log`：完整求解过程",
        "- `task_manifest.json`：任务状态与文件清单",
        "- `results/`：调度、节点、支路、交换和状态结果",
    ]
    if summary:
        lines.extend(["", f"结果摘要：`{summary.relative_to(TASK_DIR)}`"])
    if returncode != 0:
        lines.extend(["", "求解失败，不能将结果称为最优；请从 `solve.log` 开始诊断输入和约束。"])
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    manifest_path = TASK_DIR / "task_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    manifest.update({"status": "running", "started_utc": started})
    write_json(manifest_path, manifest)
    print("[3/5] 启动任务专属程序并调用求解内核", flush=True)
    print("[command] " + " ".join(COMMAND), flush=True)
    environment = os.environ.copy()
    environment["PYTHONUTF8"] = "1"
    log_path = TASK_DIR / "solve.log"
    with log_path.open("w", encoding="utf-8") as log:
        log.write(f"started_utc={started}\n")
        log.write("command=" + " ".join(COMMAND) + "\n")
        process = subprocess.Popen(
            COMMAND,
            cwd=TASK_DIR,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        assert process.stdout is not None
        for line in process.stdout:
            log.write(line)
            log.flush()
            print("[solver] " + line.rstrip(), flush=True)
        returncode = process.wait()
    finished = dt.datetime.now(dt.timezone.utc).isoformat()
    (TASK_DIR / "delivery_report.md").write_text(delivery_report(returncode), encoding="utf-8-sig")
    manifest.update(
        {
            "status": "complete" if returncode == 0 else "failed",
            "returncode": returncode,
            "finished_utc": finished,
            "artifacts": sorted(path.name for path in TASK_DIR.iterdir()),
        }
    )
    write_json(manifest_path, manifest)
    print(f"[4/5] 求解{'成功' if returncode == 0 else '失败'}，返回码 {returncode}", flush=True)
    print("[5/5] 已生成日志、结果和交付报告", flush=True)
    return returncode


if __name__ == "__main__":
    raise SystemExit(main())
'''
    return template.replace("__TASK__", repr(task)).replace("__COMMAND__", repr(command))


def execute_prepare(args: argparse.Namespace) -> int:
    input_path = resolve_existing(args.input, "Input file")
    assert input_path is not None
    sidecar_path = resolve_existing(args.sidecar, "Sidecar")
    profiles_path = resolve_existing(args.profiles, "Profiles")
    output_dir = args.output.resolve()
    collisions = [name for name in GENERATED_FILES if (output_dir / name).exists()]
    if collisions and not args.force:
        raise PipelineError(
            "Output already contains generated task files: " + ", ".join(collisions) + ". Use a new directory or --force."
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    results_dir = output_dir / "results"
    mode = detect_mode(input_path, args.mode)
    print(f"[1/5] 已识别输入：{input_path.name}；执行模式：{mode}", flush=True)
    if mode == "scenario":
        if sidecar_path or profiles_path or args.dc:
            raise PipelineError("Scenario mode takes sidecar/profiles/DC settings from the scenario file.")
        spec, command = scenario_spec(input_path, results_dir)
    else:
        spec, command = snapshot_spec(input_path, sidecar_path, profiles_path, results_dir, args.dc)
    normalized = {
        "request": args.request,
        "input": str(input_path),
        "output": str(output_dir),
        **spec,
        "execution": {"command": command, "results_directory": str(results_dir)},
    }
    task = {
        "request": args.request,
        "input": str(input_path),
        "mode": mode,
        "output": str(output_dir),
    }
    (output_dir / "normalized_input.json").write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (output_dir / "model_document.md").write_text(
        model_document(spec, args.request, command), encoding="utf-8-sig"
    )
    (output_dir / "generated_dispatch.py").write_text(
        generated_program(task, command), encoding="utf-8"
    )
    manifest = {
        "status": "prepared",
        "request": args.request,
        "input": str(input_path),
        "mode": mode,
        "generated_program": str(output_dir / "generated_dispatch.py"),
        "run_command": [sys.executable, "-u", str(output_dir / "generated_dispatch.py")],
        "artifacts": list(GENERATED_FILES),
    }
    (output_dir / "task_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[2/5] 已生成任务程序和模型文档：{output_dir}", flush=True)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate an auditable task-specific dispatch program package.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare", help="Validate input and generate task-specific program/documents.")
    prepare.add_argument("input", type=Path, help="MATPOWER/PYPOWER/JSON case or schema-v2 scenario JSON.")
    prepare.add_argument("--output", type=Path, required=True, help="Task package directory.")
    prepare.add_argument("--sidecar", type=Path, help="Optional snapshot sidecar JSON.")
    prepare.add_argument("--profiles", type=Path, help="Optional independent snapshot profiles JSON.")
    prepare.add_argument("--request", default="", help="Original natural-language task request.")
    prepare.add_argument("--mode", choices=("auto", "snapshot", "scenario"), default="auto")
    prepare.add_argument("--dc", action="store_true", help="Generate an explicitly labeled active-power diagnostic.")
    prepare.add_argument("--force", action="store_true", help="Overwrite only the known generated task files.")
    prepare.set_defaults(func=execute_prepare)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return int(args.func(args))
    except (PipelineError, core.InputError, core.resource_models.ResourceError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        print(f"TASK ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
