@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "PY=%ROOT%office-docs-venv\Scripts\python.exe"
if exist "%PY%" (
  "%PY%" "%ROOT%office-docs\run.py" %*
) else (
  python "%ROOT%office-docs\run.py" %*
)
exit /b %ERRORLEVEL%
