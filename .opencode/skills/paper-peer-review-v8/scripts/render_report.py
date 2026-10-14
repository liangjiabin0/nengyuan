#!/usr/bin/env python3
"""Render a canonical peer-review JSON file as a standalone HTML report."""

from __future__ import annotations

import argparse
import html
import json
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

SEVERITIES = ("critical", "major", "moderate", "minor")
DECISIONS = ("accept", "minor_revision", "major_revision", "reject", "unable_to_assess")
CONFIDENCES = ("high", "medium", "low")
VERIFICATIONS = ("verified", "partially_verified", "unverified")

ZH = {
    "report": "论文审稿报告", "decision": "审稿结论", "confidence": "置信度", "summary": "论文概述",
    "strengths": "主要优点", "issues": "审稿问题", "priorities": "修改优先级", "disagreements": "审稿分歧",
    "lanes": "分项审稿结论", "limitations": "本次审稿的局限", "all": "全部", "search": "搜索问题、证据或修改要求…",
    "location": "位置", "evidence": "证据", "problem": "问题", "consequence": "影响", "root": "根因",
    "action": "最低充分修改", "acceptance": "验收标准", "reviewers": "审稿视角", "sources": "外部来源",
    "none": "无", "generated": "基于结构化审稿记录生成", "critical": "致命", "major": "重大",
    "moderate": "中等", "minor": "次要", "accept": "接收", "minor_revision": "小修",
    "major_revision": "大修", "reject": "拒稿", "unable_to_assess": "无法评估", "high": "高", "medium": "中",
    "low": "低", "verified": "已核验", "partially_verified": "部分核验", "unverified": "未核验",
    "target_venue": "目标场景", "paper_type": "论文类型", "review_depth": "审稿深度", "external_research": "外部检索",
    "review_date": "审稿日期", "issue_ids": "问题编号", "adjudication": "主审裁决", "general": "通用",
    "empirical": "实证研究", "quick": "快速", "standard": "标准", "deep": "深度", "off": "关闭", "on": "开启",
    "quote": "引文", "text": "文本", "table": "表格", "figure": "图", "equation": "公式", "calculation": "复算",
    "absence": "缺失项", "artifact": "研究产物", "external_source": "外部来源"
}
EN = {
    "report": "Peer Review Report", "decision": "Recommendation", "confidence": "Confidence", "summary": "Paper summary",
    "strengths": "Substantive strengths", "issues": "Review findings", "priorities": "Revision priorities",
    "disagreements": "Reviewer disagreements", "lanes": "Lane recommendations", "limitations": "Review limitations",
    "all": "All", "search": "Search findings, evidence, or actions…", "location": "Location", "evidence": "Evidence",
    "problem": "Problem", "consequence": "Consequence", "root": "Root cause", "action": "Minimum sufficient action",
    "acceptance": "Acceptance criteria", "reviewers": "Review lanes", "sources": "External sources", "none": "None",
    "generated": "Generated from a structured review record", "critical": "Critical", "major": "Major",
    "moderate": "Moderate", "minor": "Minor", "accept": "Accept", "minor_revision": "Minor revision",
    "major_revision": "Major revision", "reject": "Reject", "unable_to_assess": "Unable to assess", "high": "High",
    "medium": "Medium", "low": "Low", "verified": "Verified", "partially_verified": "Partially verified",
    "unverified": "Unverified", "target_venue": "Target venue", "paper_type": "Paper type", "review_depth": "Review depth",
    "external_research": "External research", "review_date": "Review date", "issue_ids": "Issue IDs",
    "adjudication": "Lead adjudication", "general": "General", "empirical": "Empirical", "quick": "Quick",
    "standard": "Standard", "deep": "Deep", "off": "Off", "on": "On", "quote": "Quote", "text": "Text",
    "table": "Table", "figure": "Figure", "equation": "Equation", "calculation": "Calculation", "absence": "Absence",
    "artifact": "Artifact", "external_source": "External source"
}


def labels(language: str) -> dict[str, str]:
    if language == "bilingual":
        return {key: f"{ZH[key]} / {EN[key]}" for key in EN}
    return ZH if language == "zh-CN" else EN


def esc(value: object) -> str:
    return html.escape("" if value is None else str(value), quote=True).replace("\n", "<br>")


def value_label(ui: dict[str, str], value: object) -> str:
    raw = str(value or "")
    return ui.get(raw, raw.replace("_", " ").title())


def safe_url(value: object) -> str | None:
    raw = str(value or "").strip()
    parsed = urlparse(raw)
    return raw if parsed.scheme in {"http", "https"} and parsed.netloc else None


def validate(data: object) -> list[str]:
    if not isinstance(data, dict):
        raise ValueError("report root must be an object")
    for key in ("metadata", "verdict"):
        if not isinstance(data.get(key), dict):
            raise ValueError(f"'{key}' must be an object")
    if not isinstance(data.get("summary"), str) or not data["summary"].strip():
        raise ValueError("'summary' must be a non-empty string")
    if not isinstance(data.get("issues"), list):
        raise ValueError("'issues' must be an array")

    warnings: list[str] = []
    if data["metadata"].get("review_language") not in {"zh-CN", "en", "bilingual"}:
        warnings.append("unknown review_language; using English interface labels")
    if data["verdict"].get("decision") not in DECISIONS:
        warnings.append("verdict.decision is not canonical")
    if data["verdict"].get("confidence") not in CONFIDENCES:
        warnings.append("verdict.confidence is not canonical")

    required = ("id", "title", "severity", "location", "evidence", "problem", "consequence",
                "required_action", "acceptance_criteria", "confidence", "verification_status")
    seen: set[str] = set()
    for index, issue in enumerate(data["issues"]):
        if not isinstance(issue, dict):
            raise ValueError(f"issues[{index}] must be an object")
        missing = [key for key in required if not str(issue.get(key, "")).strip()]
        if missing:
            raise ValueError(f"issues[{index}] is missing: {', '.join(missing)}")
        issue_id = str(issue["id"])
        if issue_id in seen:
            raise ValueError(f"duplicate issue id: {issue_id}")
        seen.add(issue_id)
        if issue["severity"] not in SEVERITIES:
            raise ValueError(f"issue {issue_id} has invalid severity")
        if issue["confidence"] not in CONFIDENCES:
            raise ValueError(f"issue {issue_id} has invalid confidence")
        if issue["verification_status"] not in VERIFICATIONS:
            raise ValueError(f"issue {issue_id} has invalid verification_status")
    return warnings


def cards(items: list, renderer, empty: str) -> str:
    return "".join(renderer(item) for item in items) if items else f'<p class="empty">{esc(empty)}</p>'


def render(data: dict) -> str:
    metadata, verdict, issues = data["metadata"], data["verdict"], data["issues"]
    ui = labels(str(metadata.get("review_language", "en")))
    title = str(metadata.get("paper_title") or metadata.get("source_file") or ui["report"])
    counts = Counter(issue["severity"] for issue in issues)

    chips = "".join(
        f'<span class="chip"><b>{esc(ui.get(key, key.replace("_", " ").title()))}</b> {esc(value_label(ui, metadata[key]))}</span>'
        for key in ("target_venue", "paper_type", "review_depth", "external_research", "review_date")
        if metadata.get(key) not in (None, "")
    )
    strengths = cards(data.get("strengths", []), lambda x:
        f'<article class="tile"><h3>{esc(x.get("title"))}</h3><p><b>{esc(ui["evidence"])}:</b> {esc(x.get("evidence"))}</p>'
        f'<p><b>{esc(ui["consequence"])}:</b> {esc(x.get("importance"))}</p></article>', ui["none"])

    findings: list[str] = []
    for item in issues:
        severity, verification = str(item["severity"]), str(item["verification_status"])
        reviewers = ", ".join(map(str, item.get("reviewers", []))) or ui["none"]
        source_links = []
        for source in item.get("external_sources", []):
            if isinstance(source, dict) and (url := safe_url(source.get("url"))):
                source_links.append(f'<a href="{esc(url)}" target="_blank" rel="noopener noreferrer">{esc(source.get("label") or url)}</a>')
        sources = f'<div><dt>{esc(ui["sources"])}</dt><dd>{" · ".join(source_links)}</dd></div>' if source_links else ""
        searchable = " ".join(str(item.get(k, "")) for k in
                              ("id", "title", "category", "location", "evidence", "problem", "consequence", "required_action")).lower()
        findings.append(f'''<article class="issue" data-severity="{esc(severity)}" data-search="{esc(searchable)}">
<div class="issue-head"><div><span class="badge severity-{esc(severity)}">{esc(value_label(ui, severity))}</span>
<span class="badge verify-{esc(verification)}">{esc(value_label(ui, verification))}</span></div><b>{esc(item["id"])}</b></div>
<h3>{esc(item["title"])}</h3><p class="muted"><b>{esc(ui["location"])}:</b> {esc(item["location"])}</p>
<details open><summary>{esc(ui["evidence"])} · {esc(value_label(ui, item.get("evidence_type", "text")))}</summary><p>{esc(item["evidence"])}</p></details>
<dl><div><dt>{esc(ui["problem"])}</dt><dd>{esc(item["problem"])}</dd></div>
<div><dt>{esc(ui["consequence"])}</dt><dd>{esc(item["consequence"])}</dd></div>
<div><dt>{esc(ui["root"])}</dt><dd>{esc(item.get("root_cause") or ui["none"])}</dd></div>
<div class="action"><dt>{esc(ui["action"])}</dt><dd>{esc(item["required_action"])}</dd></div>
<div class="action"><dt>{esc(ui["acceptance"])}</dt><dd>{esc(item["acceptance_criteria"])}</dd></div>
<div><dt>{esc(ui["confidence"])}</dt><dd>{esc(value_label(ui, item["confidence"]))}</dd></div>
<div><dt>{esc(ui["reviewers"])}</dt><dd>{esc(reviewers)}</dd></div>{sources}</dl></article>''')

    priorities = cards(data.get("revision_priorities", []), lambda x:
        f'<article class="priority"><span>{esc(x.get("priority"))}</span><div><h3>{esc(x.get("action"))}</h3>'
        f'<p><b>{esc(ui["issue_ids"])}:</b> {esc(", ".join(map(str, x.get("issue_ids", []))))}</p>'
        f'<p><b>{esc(ui["acceptance"])}:</b> {esc(x.get("acceptance_criteria"))}</p></div></article>', ui["none"])
    disagreements = cards(data.get("disagreements", []), lambda x:
        f'<article class="tile"><h3>{esc(x.get("topic"))}</h3><ul>{"".join("<li>" + esc(p) + "</li>" for p in x.get("positions", []))}</ul>'
        f'<p><b>{esc(ui["adjudication"])}:</b> {esc(x.get("adjudication"))}</p></article>', ui["none"])
    lanes = cards(data.get("reviewer_verdicts", []), lambda x:
        f'<article class="tile"><h3>{esc(x.get("reviewer"))}</h3><p><span class="badge">{esc(value_label(ui, x.get("decision")))}</span> · '
        f'{esc(value_label(ui, x.get("confidence")))}</p><p>{esc(x.get("rationale"))}</p></article>', ui["none"])
    limits = data.get("limitations_of_review", [])
    limitations = '<ul>' + ''.join('<li>' + esc(x) + '</li>' for x in limits) + '</ul>' if limits else f'<p class="empty">{esc(ui["none"])}</p>'
    buttons = [f'<button class="filter active" data-filter="all">{esc(ui["all"])} <span>{len(issues)}</span></button>']
    buttons += [f'<button class="filter" data-filter="{s}">{esc(value_label(ui, s))} <span>{counts[s]}</span></button>' for s in SEVERITIES]

    replacements = {
        "__LANG__": esc(metadata.get("review_language", "en")), "__TITLE__": esc(title), "__REPORT__": esc(ui["report"]),
        "__CHIPS__": chips, "__DECISION_LABEL__": esc(ui["decision"]), "__DECISION__": esc(value_label(ui, verdict.get("decision"))),
        "__CONFIDENCE__": esc(ui["confidence"]), "__CONFIDENCE_VALUE__": esc(value_label(ui, verdict.get("confidence"))),
        "__RATIONALE__": esc(verdict.get("rationale")), "__SUMMARY_LABEL__": esc(ui["summary"]), "__SUMMARY__": esc(data["summary"]),
        "__STRENGTHS_LABEL__": esc(ui["strengths"]), "__STRENGTHS__": strengths, "__ISSUES_LABEL__": esc(ui["issues"]),
        "__BUTTONS__": "".join(buttons), "__SEARCH__": esc(ui["search"]), "__FINDINGS__": "".join(findings),
        "__PRIORITIES_LABEL__": esc(ui["priorities"]), "__PRIORITIES__": priorities, "__DISAGREEMENTS_LABEL__": esc(ui["disagreements"]),
        "__DISAGREEMENTS__": disagreements, "__LANES_LABEL__": esc(ui["lanes"]), "__LANES__": lanes,
        "__LIMITATIONS_LABEL__": esc(ui["limitations"]), "__LIMITATIONS__": limitations, "__GENERATED__": esc(ui["generated"])
    }
    page = PAGE
    for token, value in replacements.items():
        page = page.replace(token, value)
    return page


PAGE = '''<!doctype html><html lang="__LANG__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__ — __REPORT__</title><style>
:root{--ink:#172126;--muted:#65747b;--paper:#f7f5ef;--card:#fff;--line:#d9dfdf;--accent:#315f72;--critical:#8f1d22;--major:#bc5a18;--moderate:#8a7114;--minor:#346678}*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 Inter,system-ui,"Segoe UI",sans-serif}.wrap{max-width:1100px;margin:auto;padding:44px 24px 80px}header{border-top:7px solid var(--accent);background:var(--card);padding:34px;border-radius:4px 4px 14px 14px;box-shadow:0 10px 34px #27434c14}.eyebrow{color:var(--accent);font-weight:800;letter-spacing:.08em;text-transform:uppercase}h1{font:700 clamp(30px,5vw,52px)/1.12 Georgia,serif;margin:.25em 0}h2{font:700 27px/1.2 Georgia,serif;margin:0 0 18px}h3{line-height:1.35;margin:8px 0 10px}.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.chip,.badge{display:inline-block;padding:4px 9px;border:1px solid var(--line);border-radius:999px;background:#f8faf9;font-size:12px}.verdict{margin-top:22px;padding:22px;border-left:5px solid var(--accent);background:#edf4f4;display:grid;gap:8px}.verdict strong{font-size:24px}.verdict p{margin:0}section{margin-top:36px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.tile,.priority{background:var(--card);border:1px solid var(--line);padding:18px;border-radius:12px}.toolbar{position:sticky;top:0;z-index:3;background:#f7f5eff2;backdrop-filter:blur(8px);padding:12px 0;display:flex;gap:8px;flex-wrap:wrap}button,input{font:inherit}.filter{border:1px solid var(--line);background:white;padding:8px 12px;border-radius:999px;cursor:pointer}.filter.active{background:var(--accent);color:white;border-color:var(--accent)}#search{min-width:250px;flex:1;border:1px solid var(--line);background:white;padding:9px 13px;border-radius:999px}.issue{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--major);padding:22px;margin:14px 0;border-radius:12px}.issue[data-severity=critical]{border-left-color:var(--critical)}.issue[data-severity=moderate]{border-left-color:var(--moderate)}.issue[data-severity=minor]{border-left-color:var(--minor)}.issue-head{display:flex;justify-content:space-between;gap:12px}.severity-critical{color:var(--critical)}.severity-major{color:var(--major)}.severity-moderate{color:var(--moderate)}.severity-minor{color:var(--minor)}.verify-unverified{border-style:dashed;color:var(--muted)}.muted,.empty{color:var(--muted)}details{background:#f8faf9;padding:10px 13px;border-radius:8px}summary{font-weight:750;cursor:pointer}dl{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}dl div{padding:11px 0;border-bottom:1px solid #edf0ef}dt{font-weight:800;color:var(--muted);font-size:12px;text-transform:uppercase}dd{margin:3px 0 0}dl .action{grid-column:1/-1;background:#fbf7ea;padding:12px;margin-top:7px;border:0;border-radius:8px}.priority{display:flex;gap:14px;margin:10px 0}.priority>span{width:36px;height:36px;display:grid;place-items:center;border-radius:50%;background:var(--accent);color:white;font-weight:800;flex:0 0 auto}.priority h3{margin:0}footer{margin-top:48px;color:var(--muted);font-size:12px;text-align:center}@media(max-width:650px){.wrap{padding:18px 12px 50px}header{padding:22px}dl{grid-template-columns:1fr}dl .action{grid-column:auto}}@media print{body{background:white}.wrap{max-width:none;padding:0}.toolbar{display:none}.issue{break-inside:avoid}header{box-shadow:none}}
</style></head><body><main class="wrap"><header><div class="eyebrow">__REPORT__</div><h1>__TITLE__</h1><div class="chips">__CHIPS__</div><div class="verdict"><span>__DECISION_LABEL__</span><strong>__DECISION__</strong><span>__CONFIDENCE__: __CONFIDENCE_VALUE__</span><p>__RATIONALE__</p></div></header>
<section><h2>__SUMMARY_LABEL__</h2><p>__SUMMARY__</p></section><section><h2>__STRENGTHS_LABEL__</h2><div class="grid">__STRENGTHS__</div></section>
<section><h2>__ISSUES_LABEL__</h2><div class="toolbar">__BUTTONS__<input id="search" type="search" placeholder="__SEARCH__" aria-label="__SEARCH__"></div><div id="issues">__FINDINGS__</div></section>
<section><h2>__PRIORITIES_LABEL__</h2>__PRIORITIES__</section><section><h2>__DISAGREEMENTS_LABEL__</h2><div class="grid">__DISAGREEMENTS__</div></section><section><h2>__LANES_LABEL__</h2><div class="grid">__LANES__</div></section><section><h2>__LIMITATIONS_LABEL__</h2>__LIMITATIONS__</section><footer>__GENERATED__</footer></main>
<script>const buttons=[...document.querySelectorAll('.filter')],cards=[...document.querySelectorAll('.issue')],search=document.querySelector('#search');let active='all';function apply(){const q=search.value.trim().toLowerCase();cards.forEach(c=>{c.hidden=!((active==='all'||c.dataset.severity===active)&&(!q||c.dataset.search.includes(q)))})}buttons.forEach(b=>b.addEventListener('click',()=>{buttons.forEach(x=>x.classList.remove('active'));b.classList.add('active');active=b.dataset.filter;apply()}));search.addEventListener('input',apply);</script></body></html>'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Canonical review JSON")
    parser.add_argument("--output", type=Path, help="Destination HTML")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    try:
        data = json.loads(args.input.read_text(encoding="utf-8-sig"))
        for warning in validate(data):
            print(f"warning: {warning}", file=sys.stderr)
        if args.validate_only:
            print(f"Valid report: {args.input}")
            return 0
        output = args.output or args.input.with_suffix(".html")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(render(data), encoding="utf-8")
        print(f"Rendered report: {output}")
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
