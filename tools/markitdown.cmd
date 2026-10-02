@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "PY=%ROOT%markitdown-venv\Scripts\python.exe"
set "REQ=%ROOT%markitdown\requirements.txt"
if not exist "%PY%" (
  echo [markitdown] creating venv %ROOT%markitdown-venv 1>&2
  python -m venv "%ROOT%markitdown-venv"
  if errorlevel 1 (
    echo [markitdown] python -m venv failed 1>&2
    exit /b 1
  )
  "%PY%" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r "%REQ%"
  if errorlevel 1 (
    "%PY%" -m pip install -r "%REQ%"
    if errorlevel 1 exit /b 1
  )
)
"%PY%" -m markitdown %*
