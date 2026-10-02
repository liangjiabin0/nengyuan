import json
from pathlib import Path
from typing import Annotated

import typer

from ppt_voice_builder.config.loader import load_settings
from ppt_voice_builder.domain.errors import PptVoiceError
from ppt_voice_builder.workflow.orchestrator import WorkflowOrchestrator

app = typer.Typer(help="PPT 智能配音交付工具", no_args_is_help=True)
voice_app = typer.Typer(help="创建、试听和确认百炼音色", no_args_is_help=True)
app.add_typer(voice_app, name="voice")


def _orchestrator(config: Path) -> WorkflowOrchestrator:
    settings = load_settings(config)
    return WorkflowOrchestrator(
        settings,
        config_root=config.expanduser().resolve().parent,
        progress=lambda message, current, total: typer.echo(f"[{current}/{total}] {message}"),
    )


def _print_preflight(report) -> None:  # type: ignore[no-untyped-def]
    typer.echo(f"总页数：{report.slide_count}")
    typer.echo(f"空备注页：{list(report.empty_note_slides) or '无'}")
    typer.echo(f"备注字符数：{report.character_count}")
    typer.echo(f"预计费用：{report.estimated_cost_yuan} 元（仅估算）")


@app.command()
def check(
    input_pptx: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    config: Annotated[Path, typer.Option("--config", "-c")] = Path("config.yaml"),
) -> None:
    """只读取 PPT 并检查备注与估算费用，不调用收费接口。"""
    try:
        _print_preflight(_orchestrator(config).check(input_pptx))
    except (PptVoiceError, ValueError, OSError) as exc:
        typer.echo(f"错误：{exc}", err=True)
        raise typer.Exit(1) from exc


@app.command()
def build(
    input_pptx: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    dry_run: Annotated[bool, typer.Option("--dry-run")] = False,
    config: Annotated[Path, typer.Option("--config", "-c")] = Path("config.yaml"),
) -> None:
    """生成逐页音频、嵌入副本并验证输出。"""
    try:
        result = _orchestrator(config).build(input_pptx, dry_run=dry_run)
        _print_preflight(result.preflight)
        if result.dry_run:
            typer.echo("dry-run 完成：未调用百炼，未修改 PPT。")
        else:
            typer.echo(f"输出：{result.output_path}")
            typer.echo(f"报告：{result.report_path}")
    except (PptVoiceError, ValueError, OSError) as exc:
        typer.echo(f"错误：{exc}", err=True)
        raise typer.Exit(1) from exc


@app.command()
def resume(
    manifest_path: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    config: Annotated[Path, typer.Option("--config", "-c")] = Path("config.yaml"),
) -> None:
    """从 manifest 所记录的源文件继续构建。"""
    result = _orchestrator(config).resume(manifest_path)
    typer.echo(f"输出：{result.output_path}")


@app.command()
def inspect(
    output_pptx: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    config: Annotated[Path, typer.Option("--config", "-c")] = Path("config.yaml"),
) -> None:
    """使用独立 PowerPoint 实例检查音频和翻页设置。"""
    result = _orchestrator(config).inspect(output_pptx)
    typer.echo(json.dumps({"valid": result.valid, "errors": result.errors}, ensure_ascii=False))
    if not result.valid:
        raise typer.Exit(1)


@voice_app.command("create")
def voice_create(
    prefix: Annotated[str, typer.Option(help="不超过 10 位的字母数字前缀")] = "pptvoice",
    config: Annotated[Path, typer.Option("--config", "-c")] = Path("config.yaml"),
) -> None:
    """调用百炼声音设计并保存本地试听文件。"""
    voice_id, preview = _orchestrator(config).create_voice(prefix)
    typer.echo(f"voice_id：{voice_id}")
    typer.echo(f"试听文件：{preview}")


@voice_app.command("preview")
def voice_preview(
    config: Annotated[Path, typer.Option("--config", "-c")] = Path("config.yaml"),
) -> None:
    """用系统默认播放器播放最近生成的试听文件。"""
    typer.echo(f"正在播放：{_orchestrator(config).preview_voice()}")


@voice_app.command("confirm")
def voice_confirm(
    voice_id: Annotated[str, typer.Argument()],
    config: Annotated[Path, typer.Option("--config", "-c")] = Path("config.yaml"),
) -> None:
    """确认最近生成的音色并保存到本地私密配置。"""
    typer.echo(f"已保存：{_orchestrator(config).confirm_voice(voice_id)}")


@voice_app.command("list-local")
def voice_list_local(
    config: Annotated[Path, typer.Option("--config", "-c")] = Path("config.yaml"),
) -> None:
    """列出本机已确认音色（voice_id 脱敏）。"""
    typer.echo(json.dumps(_orchestrator(config).list_voices(), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    app()
