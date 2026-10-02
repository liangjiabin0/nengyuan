@echo off
setlocal
set "ROOT=%~dp0"
set "PYTHONPATH=%ROOT%src;%ROOT%"
set "VENV=%ROOT%..\ppt-voice-venv\Scripts\python.exe"
if exist "%VENV%" (
  "%VENV%" -m ppt_voice_agent %*
  exit /b %ERRORLEVEL%
)
python -m ppt_voice_agent %*
