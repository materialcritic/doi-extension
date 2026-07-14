@echo off
REM Wrapper so Chrome's Native Messaging can spawn doi_host.py directly on
REM Windows (the manifest's "path" must point at an executable, and Windows
REM can't execute a bare .py file as a process the way macOS/Linux can via
REM the shebang line). Prefers the "py" launcher (bundled with python.org
REM installers) since it's more reliable at finding the right interpreter
REM than assuming "python" is on PATH.
setlocal
set SCRIPT_DIR=%~dp0
where py >nul 2>nul
if %ERRORLEVEL%==0 (
    py "%SCRIPT_DIR%doi_host.py" %*
) else (
    python "%SCRIPT_DIR%doi_host.py" %*
)
