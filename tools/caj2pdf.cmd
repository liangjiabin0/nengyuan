@echo off
setlocal
set "ROOT=%~dp0"
set "PATH=%ROOT%;%PATH%"
"%ROOT%caj2pdf-venv\Scripts\python.exe" "%ROOT%caj2pdf-fresh\caj2pdf-master\caj2pdf" %*
