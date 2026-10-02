@echo off
setlocal
for %%I in ("%~dp0..") do set "AI4ES_PROJECT_ROOT=%%~fI"
if not defined ESOPT_ROOT set "ESOPT_ROOT=%AI4ES_PROJECT_ROOT%\tools\esopt"
if not defined ESOPT_BRIDGE set "ESOPT_BRIDGE=%ESOPT_ROOT%\esopt_bridge"
if not defined ESOPT_NATIVE_ROOT set "ESOPT_NATIVE_ROOT=%ESOPT_ROOT%"
if not defined ESOPT_PYTHON set "ESOPT_PYTHON=%AI4ES_PROJECT_ROOT%\tools\esopt-venv\Scripts\python.exe"
if not exist "%ESOPT_PYTHON%" set "ESOPT_PYTHON=python"
if not exist "%ESOPT_BRIDGE%\esopt_agent" (
  echo ESOPT MCP bridge not found: %ESOPT_BRIDGE% 1>&2
  exit /b 1
)
set "PYTHONPATH=%ESOPT_BRIDGE%"
cd /d "%ESOPT_BRIDGE%"
"%ESOPT_PYTHON%" -u -m esopt_agent mcp
