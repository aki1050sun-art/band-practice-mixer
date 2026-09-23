@echo off
setlocal EnableExtensions EnableDelayedExpansion

if "%~1"=="" (
  echo.
  echo MP3 or WAV file should be dragged onto this BAT file.
  echo.
  pause
  exit /b 1
)

set "PY=%USERPROFILE%\anaconda3\envs\demucs\python.exe"
set "FFMPEG=%USERPROFILE%\anaconda3\envs\demucs\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"

if not exist "%PY%" (
  echo Python environment not found:
  echo %PY%
  pause
  exit /b 1
)

if not exist "%FFMPEG%" (
  echo FFmpeg not found:
  echo %FFMPEG%
  pause
  exit /b 1
)

set "SRC=%~f1"
set "NAME=%~n1"
set "WORK=%~dp1BandPracticeWork"
set "OUTDIR=%WORK%\separated"
set "PACKDIR=%WORK%\pack_%NAME%"
set "CLEANWAV=%WORK%\input_clean.wav"

echo.
echo ==========================================
echo Band Practice Mixer - Song Pack Maker v3
echo ==========================================
echo.
echo Source file:
echo %SRC%
echo.

set "TITLE=%NAME%"
set /p "TITLE_INPUT=Song title [Enter = %NAME%]: "
if not "%TITLE_INPUT%"=="" set "TITLE=%TITLE_INPUT%"

if not exist "%WORK%" mkdir "%WORK%"

echo.
echo [0/6] Preparing audio...
"%FFMPEG%" -y -loglevel error -i "%SRC%" -ar 44100 -ac 2 -c:a pcm_s16le "%CLEANWAV%"
if errorlevel 1 goto :error

echo.
echo Estimating BPM...
set "AUTOBPM="
for /f "delims=" %%B in ('"%PY%" -c "import wave,numpy as np; p=r'%CLEANWAV%'; w=wave.open(p,'rb'); fs=w.getframerate(); ch=w.getnchannels(); x=np.frombuffer(w.readframes(w.getnframes()),dtype=np.int16).reshape(-1,ch).mean(1).astype(np.float32); hop=max(1,fs//200); n=(len(x)//hop)*hop; e=np.abs(x[:n]).reshape(-1,hop).mean(1); e=np.maximum(0,np.diff(e,prepend=e[0])); e=e-e.mean(); nf=1<<(2*len(e)-1).bit_length(); f=np.fft.rfft(e,nf); ac=np.fft.irfft(f*np.conj(f))[:len(e)]; lo=int(200*60/200); hi=min(len(ac)-1,int(200*60/60)); lag=lo+int(np.argmax(ac[lo:hi+1])); print(int(round(60*200/lag)))"') do set "AUTOBPM=%%B"

if "%AUTOBPM%"=="" set "AUTOBPM=120"
echo Estimated BPM: %AUTOBPM%
set "BPM=%AUTOBPM%"
set /p "BPM_INPUT=BPM [Enter = estimated %AUTOBPM%]: "
if not "%BPM_INPUT%"=="" set "BPM=%BPM_INPUT%"

echo.
echo Title : %TITLE%
echo BPM   : %BPM%
echo.

echo [1/6] Separating into 6 stems...
"%PY%" -m demucs -n htdemucs_6s -o "%OUTDIR%" "%CLEANWAV%"
if errorlevel 1 goto :error

set "STEMDIR=%OUTDIR%\htdemucs_6s\input_clean"
if not exist "%STEMDIR%\vocals.wav" goto :error

echo.
echo [2/6] Converting WAV stems to MP3...
if exist "%PACKDIR%" rmdir /s /q "%PACKDIR%"
mkdir "%PACKDIR%"

for %%S in (vocals guitar bass drums piano other) do (
  echo   %%S
  "%FFMPEG%" -y -loglevel error -i "%STEMDIR%\%%S.wav" -codec:a libmp3lame -b:a 192k "%PACKDIR%\%%S.mp3"
  if errorlevel 1 goto :error
)

echo.
echo [3/6] Creating metadata...
set "PACK_TITLE=%TITLE%"
set "PACK_BPM=%BPM%"
powershell -NoProfile -Command "$o=[ordered]@{title=$env:PACK_TITLE;bpm=[int]$env:PACK_BPM;countBars=1}; $o | ConvertTo-Json | Set-Content -Encoding UTF8 '%PACKDIR%\metadata.json'"
if errorlevel 1 goto :error

echo.
echo [4/6] Choosing ZIP file name...
set "SAFE_TITLE=%TITLE%"
for %%C in (^< ^> ^: ^" ^/ ^\ ^| ^? ^*) do set "SAFE_TITLE=!SAFE_TITLE:%%C=_!"
if "%SAFE_TITLE%"=="" set "SAFE_TITLE=%NAME%"
set "ZIP=%~dp1%SAFE_TITLE%_bandmix.zip"

echo.
echo [5/6] Creating ZIP song pack...
if exist "%ZIP%" del /q "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%PACKDIR%\*' -DestinationPath '%ZIP%' -Force"
if errorlevel 1 goto :error

echo.
echo [6/6] DONE
echo Title: %TITLE%
echo BPM  : %BPM%
echo ZIP  : %ZIP%
echo.
echo Copy this ZIP to Google Drive manually, then download it on Android.
echo.
pause
exit /b 0

:error
echo.
echo ERROR: Song pack creation failed.
echo Please leave this window open and show the error to ChatGPT.
pause
exit /b 1
