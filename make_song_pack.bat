@echo off
setlocal EnableExtensions

if "%~1"=="" (
  echo.
  echo MP3 or WAV file should be dragged onto this BAT file.
  echo.
  pause
  exit /b 1
)

set "PY=%USERPROFILE%\anaconda3\envs\demucs\python.exe"
if not exist "%PY%" (
  echo Python environment not found:
  echo %PY%
  pause
  exit /b 1
)

set "SRC=%~f1"
set "NAME=%~n1"
set "WORK=%~dp1BandPracticeWork"
set "OUTDIR=%WORK%\separated"
set "PACKDIR=%WORK%\pack_%NAME%"
set "ZIP=%~dp1%NAME%_bandmix.zip"

echo.
echo [1/4] Separating into 6 stems...
"%PY%" -m demucs -n htdemucs_6s -o "%OUTDIR%" "%SRC%"
if errorlevel 1 goto :error

set "STEMDIR=%OUTDIR%\htdemucs_6s\%NAME%"
if not exist "%STEMDIR%\vocals.wav" goto :error

echo.
echo [2/4] Converting WAV stems to MP3...
for /f "usebackq delims=" %%F in (`"%PY%" -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"`) do set "FFMPEG=%%F"
if not exist "%FFMPEG%" goto :error

if exist "%PACKDIR%" rmdir /s /q "%PACKDIR%"
mkdir "%PACKDIR%"

for %%S in (vocals guitar bass drums piano other) do (
  echo   %%S
  "%FFMPEG%" -y -loglevel error -i "%STEMDIR%\%%S.wav" -codec:a libmp3lame -b:a 192k "%PACKDIR%\%%S.mp3"
  if errorlevel 1 goto :error
)

echo.
echo [3/4] Creating metadata...
powershell -NoProfile -Command "$o=[ordered]@{title='%NAME%';bpm=120;countBars=1}; $o | ConvertTo-Json | Set-Content -Encoding UTF8 '%PACKDIR%\metadata.json'"
if errorlevel 1 goto :error

echo.
echo [4/4] Creating ZIP song pack...
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%PACKDIR%\*' -DestinationPath '%ZIP%' -Force"
if errorlevel 1 goto :error

echo.
echo DONE
echo %ZIP%
echo.
echo Copy this ZIP to your Android phone and import it in Band Practice Mixer.
pause
exit /b 0

:error
echo.
echo ERROR: Song pack creation failed.
echo Please leave this window open and show the error to ChatGPT.
pause
exit /b 1
