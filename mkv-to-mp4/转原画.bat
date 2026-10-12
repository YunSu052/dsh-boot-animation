@echo off
chcp 65001 >nul 2>nul
title 转 MP4 - 原画
setlocal enabledelayedexpansion

set "HERE=%~dp0"
set "CONVERT=%HERE%convert.mjs"

rem ---------- 定位 node ----------
set "NODE="
where node >nul 2>nul
if %errorlevel%==0 set "NODE=node"
if not defined NODE if exist "%HERE%node.exe" set "NODE=%HERE%node.exe"

if not defined NODE (
  echo.
  echo   [错误] 找不到 node.exe
  echo   办法一：安装 Node.js 后重新打开本窗口（推荐）
  echo     winget install --id OpenJS.NodeJS.LTS -e
  echo   办法二：下载免安装版，把 node.exe 复制到本文件旁边
  echo     下载地址 https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "%CONVERT%" (
  echo   [错误] 找不到 convert.mjs
  echo   期望位置: %CONVERT%
  pause
  exit /b 1
)

set /a N=0
set "ARGS="

rem ====== 有参数 = 拖拽模式；无参数 = 双击弹选择框 ======
if not "%~1"=="" goto drag
goto pick

:drag
if "%~1"=="" goto run
set /a N+=1
set "ARGS=!ARGS! "%~f1""
shift
goto drag

:pick
set "LIST=%TEMP%\mp4opt-sel.txt"
if exist "%LIST%" del "%LIST%" >nul 2>nul
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='选择要处理的视频'; $d.Filter='视频文件|*.mkv;*.webm;*.mp4;*.m4v;*.mov;*.avi|所有文件|*.*'; $d.Multiselect=$true; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ [IO.File]::WriteAllLines('%LIST%', $d.FileNames, (New-Object System.Text.UTF8Encoding($false))) }"
if not exist "%LIST%" (
  echo.
  echo   已取消（没有选择文件）。
  echo.
  pause
  exit /b 0
)
for /f "usebackq delims=" %%F in ("%LIST%") do (
  set /a N+=1
  set "ARGS=!ARGS! "%%~fF""
)
del "%LIST%" >nul 2>nul

:run
if not defined ARGS (
  echo.
  echo   没有可处理的文件。
  echo.
  pause
  exit /b 0
)

"%NODE%" "%CONVERT%" !ARGS! --orig -y

echo.
echo ============================================================
echo   处理完毕：共 !N! 个文件
echo ============================================================
echo.
echo   输出：<名字>-原画.mp4（保持原分辨率，画质优先）
echo   原文件都没有被改动。
echo.
pause
exit /b 0
