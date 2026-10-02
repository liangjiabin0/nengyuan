@echo off
setlocal
set "ROOT=%~dp0"
if not defined ESOPT_ROOT set "ESOPT_ROOT=%ROOT%"
set "PYTHONPATH=%ROOT%esopt_bridge;%PYTHONPATH%"
set "PY=%ROOT%..\esopt-venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" -m esopt_agent %*
