@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
if not exist "%ROOT%build\openTEPES_esopt.exe" (
  echo SES-IESP solver is missing under tools\ses-iesp-esopt\build. 1>&2
  exit /b 1
)
set "GUROBI_DLL=%SES_IESP_GUROBI_DLL%"
if not defined GUROBI_DLL (
  for %%F in ("%ROOT%..\mgplan-venv\Lib\site-packages\gurobipy\gurobi*.dll") do (
    if exist "%%~fF" set "GUROBI_DLL=%%~fF"
  )
)
if not defined GUROBI_DLL (
  echo Gurobi runtime DLL was not found. Run npm run mgplan:install or set SES_IESP_GUROBI_DLL. 1>&2
  exit /b 1
)
pushd "%ROOT%build"
"%ROOT%build\openTEPES_esopt.exe" --dir "%ROOT%." --lib "%GUROBI_DLL%" %*
set "CODE=%ERRORLEVEL%"
popd
exit /b %CODE%
