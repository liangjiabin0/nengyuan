@echo off
setlocal
set "ROOT=%~dp0"
set "PY=%ROOT%pdf2md-venv\Scripts\python.exe"
if not exist "%PY%" (
  echo pdf2md venv missing: %PY% 1>&2
  exit /b 1
)
"%PY%" "%ROOT%pdf2md\pdf_to_md.py" %*
