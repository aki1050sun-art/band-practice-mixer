# PC song-pack workflow

1. On Windows, drag an MP3 or WAV file onto `make_song_pack.bat`.
2. The script runs `htdemucs_6s`, converts all six stems to 192 kbps MP3, and creates:
   `<song name>_bandmix.zip`
3. Copy that ZIP to Android (Google Drive, Quick Share, USB, etc.).
4. In Band Practice Mixer, choose **PCで作った曲パックを読み込む** and select the ZIP.
5. The app imports and saves the six stems locally. Subsequent playback uses **保存した曲** and does not re-run separation.

Expected PC prerequisites used by the script:
- `%USERPROFILE%\anaconda3\envs\demucs\python.exe`
- Demucs installed in that environment
- `imageio-ffmpeg` installed in that environment
