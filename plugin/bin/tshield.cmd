@echo off
rem Token Shield's Windows launcher (design.md D15): runs the tshield binary
rem built for this machine's architecture from bin\windows-<arch>\.
setlocal

set "arch=amd64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "arch=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "arch=arm64"

set "bin=%~dp0windows-%arch%\tshield.exe"
if not exist "%bin%" (
  echo tshield: no binary for windows-%arch% in %~dp0 1>&2
  exit /b 1
)
"%bin%" %*
exit /b %ERRORLEVEL%
