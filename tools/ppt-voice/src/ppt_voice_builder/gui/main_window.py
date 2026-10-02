import os
import threading
from pathlib import Path
from tkinter import filedialog, messagebox

import customtkinter as ctk

from ppt_voice_builder.config.loader import load_settings
from ppt_voice_builder.gui.progress_window import ProgressWindow
from ppt_voice_builder.workflow.orchestrator import WorkflowOrchestrator


class MainWindow(ctk.CTk):
    def __init__(self) -> None:
        super().__init__()
        self.title("PPT智能配音交付工具")
        self.geometry("760x480")
        self.config_path = Path("config.yaml").resolve()
        self.ppt_path = ctk.StringVar()
        self.output_dir = ctk.StringVar(value=str((Path.cwd() / "output").resolve()))
        self.summary = ctk.StringVar(value="请选择 PPT 并先执行检查。")
        self._layout()

    def _layout(self) -> None:
        ctk.CTkLabel(self, text="PPT智能配音交付工具", font=("Microsoft YaHei", 24, "bold")).pack(
            padx=28, pady=(28, 20), anchor="w"
        )
        frame = ctk.CTkFrame(self)
        frame.pack(padx=28, pady=8, fill="both", expand=True)
        self._path_row(frame, "输入 PPT", self.ppt_path, self._select_ppt, 0)
        self._path_row(frame, "输出目录", self.output_dir, self._select_output, 1)
        ctk.CTkLabel(frame, textvariable=self.summary, justify="left").grid(
            row=2, column=0, columnspan=3, padx=16, pady=22, sticky="w"
        )
        buttons = ctk.CTkFrame(frame, fg_color="transparent")
        buttons.grid(row=3, column=0, columnspan=3, padx=16, pady=12, sticky="ew")
        ctk.CTkButton(buttons, text="创建并试听音色", command=self._create_voice).pack(
            side="left", padx=5
        )
        ctk.CTkButton(buttons, text="检查 PPT", command=self._check).pack(side="left", padx=5)
        ctk.CTkButton(buttons, text="开始生成", command=self._build).pack(side="left", padx=5)
        ctk.CTkButton(buttons, text="打开输出目录", command=self._open_output).pack(
            side="left", padx=5
        )
        frame.grid_columnconfigure(1, weight=1)

    @staticmethod
    def _path_row(master, label: str, variable: ctk.StringVar, command, row: int) -> None:  # type: ignore[no-untyped-def]
        ctk.CTkLabel(master, text=label).grid(row=row, column=0, padx=16, pady=12, sticky="w")
        ctk.CTkEntry(master, textvariable=variable).grid(
            row=row, column=1, padx=8, pady=12, sticky="ew"
        )
        ctk.CTkButton(master, text="选择", width=72, command=command).grid(
            row=row, column=2, padx=16, pady=12
        )

    def _select_ppt(self) -> None:
        value = filedialog.askopenfilename(filetypes=[("PowerPoint", "*.pptx")])
        if value:
            self.ppt_path.set(value)

    def _select_output(self) -> None:
        value = filedialog.askdirectory()
        if value:
            self.output_dir.set(value)

    def _orchestrator(self, progress=None) -> WorkflowOrchestrator:  # type: ignore[no-untyped-def]
        settings = load_settings(self.config_path)
        settings.project.output_dir = Path(self.output_dir.get()).resolve()
        return WorkflowOrchestrator(
            settings, config_root=self.config_path.parent, progress=progress
        )

    def _check(self) -> None:
        try:
            result = self._orchestrator().check(Path(self.ppt_path.get()))
            self.summary.set(
                f"页数：{result.slide_count}　字符数：{result.character_count}　"
                f"预计费用：¥{result.estimated_cost_yuan}（估算）"
            )
        except Exception as exc:
            messagebox.showerror("检查失败", str(exc))

    def _run_async(self, action) -> None:  # type: ignore[no-untyped-def]
        progress = ProgressWindow(self)

        def callback(message: str, current: int, total: int) -> None:
            self.after(0, progress.update_progress, message, current, total)

        def worker() -> None:
            try:
                value = action(callback)
                self.after(0, lambda: messagebox.showinfo("完成", str(value)))
            except Exception as exc:
                error_message = str(exc)
                self.after(0, lambda: messagebox.showerror("失败", error_message))
            finally:
                self.after(0, progress.destroy)

        threading.Thread(target=worker, daemon=True).start()

    def _create_voice(self) -> None:
        def action(callback):  # type: ignore[no-untyped-def]
            voice_id, path = self._orchestrator(callback).create_voice()
            os.startfile(path)
            return f"试听文件已播放。确认满意后运行：ppt-voice voice confirm {voice_id}"

        self._run_async(action)

    def _build(self) -> None:
        self._run_async(
            lambda callback: (
                self._orchestrator(callback).build(Path(self.ppt_path.get())).output_path
            )
        )

    def _open_output(self) -> None:
        path = Path(self.output_dir.get()).resolve()
        path.mkdir(parents=True, exist_ok=True)
        os.startfile(path)
