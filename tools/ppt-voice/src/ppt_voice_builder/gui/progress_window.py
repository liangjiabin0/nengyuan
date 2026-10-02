import customtkinter as ctk


class ProgressWindow(ctk.CTkToplevel):
    def __init__(self, master: ctk.CTk) -> None:
        super().__init__(master)
        self.title("正在生成")
        self.geometry("460x150")
        self.label = ctk.CTkLabel(self, text="准备中…")
        self.label.pack(padx=24, pady=(28, 14), fill="x")
        self.bar = ctk.CTkProgressBar(self)
        self.bar.pack(padx=24, pady=8, fill="x")
        self.bar.set(0)

    def update_progress(self, message: str, current: int, total: int) -> None:
        self.label.configure(text=message)
        self.bar.set(current / total if total else 0)
