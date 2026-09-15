@echo off
setlocal
pushd "%~dp0.." || exit /b 1
where py >nul 2>nul
if errorlevel 1 (
    echo Please install Python 3.10+ with the Windows Python launcher.
    popd
    exit /b 1
)
if not exist "build\venv-windows\Scripts\python.exe" (
    py -3 -m venv "build\venv-windows"
    if errorlevel 1 goto :failed
)
"build\venv-windows\Scripts\python.exe" -m pip install -e ".[build]"
if errorlevel 1 goto :failed
"build\venv-windows\Scripts\python.exe" scripts\build_windows.py %*
if errorlevel 1 goto :failed
popd
exit /b 0
:failed
echo Windows build failed. See the error above.
popd
exit /b 1
