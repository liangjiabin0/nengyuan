import html
import json
import os
from pathlib import Path

from ppt_voice_builder.ppt.preflight import PreflightReport
from ppt_voice_builder.workflow.manifest import BuildManifest


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        temporary.write_text(content, encoding="utf-8", newline="\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def build_html_report(
    output_path: Path,
    manifest: BuildManifest,
    preflight: PreflightReport,
) -> Path:
    verification_data = manifest.verification or {}
    timing_values = verification_data.get("slide_timings", [])
    timings = timing_values if isinstance(timing_values, list) else []

    def transition_time(slide_index: int) -> float:
        return float(timings[slide_index - 1]) if slide_index <= len(timings) else 0.0

    rows = "".join(
        "<tr>"
        f"<td>{task.slide_index}</td><td>{html.escape(str(task.status))}</td>"
        f"<td>{task.duration_seconds or 0:.2f}</td>"
        f"<td>{transition_time(task.slide_index):.2f}</td>"
        f"<td>{html.escape(task.error_message or '')}</td>"
        "</tr>"
        for task in manifest.tasks
    )
    verification = html.escape(json.dumps(manifest.verification, ensure_ascii=False))
    retry_text = html.escape("\n".join(manifest.retries) or "无")
    document = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>PPT 配音生成报告</title>
<style>
body{{font-family:Segoe UI,Microsoft YaHei,sans-serif;max-width:960px;margin:36px auto}}
table{{border-collapse:collapse;width:100%}}
th,td{{border:1px solid #d1d5db;padding:8px;text-align:left}}
th,code{{background:#f3f4f6}}
</style></head>
<body><h1>PPT 智能配音生成报告</h1>
<p>模型：<code>{html.escape(manifest.model)}</code></p>
<p>音色：<code>{html.escape(manifest.masked_voice_id)}</code></p>
<ul><li>页数：{preflight.slide_count}</li><li>字符数：{preflight.character_count}</li>
<li>预计费用：¥{preflight.estimated_cost_yuan}（估算）</li>
<li>实际 API 调用：{manifest.api_calls}</li>
<li>缓存命中：{manifest.cache_hits}</li></ul>
<table><thead><tr><th>页</th><th>状态</th><th>音频时长（秒）</th>
<th>翻页时间（秒）</th><th>错误</th></tr></thead><tbody>{rows}</tbody></table>
<h2>PPT 验证</h2><p>{verification}</p>
<h2>失败与重试</h2><pre>{retry_text}</pre>
</body></html>"""
    _atomic_write(output_path, document)
    return output_path
