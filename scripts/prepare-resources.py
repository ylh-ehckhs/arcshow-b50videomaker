"""Prepare local runtime tools; never called by the application itself."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
URL = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip'
SHA256 = 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec'


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(stream.read()).hexdigest()


def models():
    for row in json.loads((ROOT / 'data/model-manifest.json').read_text(encoding='utf-8-sig')):
        file = ROOT / row['file']
        if not file.is_file() or file.stat().st_size != row['bytes'] or digest(file) != row['sha256']:
            raise RuntimeError('OCR model missing or checksum mismatch: ' + row['file'])
    print('OCR models: checksums OK')


def install_tools(source=None):
    dest = ROOT / 'resources/bin'
    dest.mkdir(parents=True, exist_ok=True)
    if source:
        source = Path(source).resolve()
        for name in ['ffmpeg.exe', 'ffprobe.exe']:
            original = source / name
            if not original.is_file():
                raise RuntimeError('Missing tool: ' + str(original))
            if original.resolve() != (dest / name).resolve():
                shutil.copy2(original, dest / name)
        print('Copied tools from selected local directory')
        return
    if all((dest / name).is_file() for name in ['ffmpeg.exe', 'ffprobe.exe']):
        print('Using existing local FFmpeg / FFprobe')
        return
    cache = ROOT / '.cache' / 'ffmpeg'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / 'ffmpeg-8.1.2-essentials_build.zip'
    if not archive.exists():
        print('Downloading pinned FFmpeg archive...', flush=True)
        request = urllib.request.Request(URL, headers={'User-Agent': 'arcshow-resource-helper/0.5.17'})
        with urllib.request.urlopen(request, timeout=120) as response:
            content = response.read()
        if hashlib.sha256(content).hexdigest() != SHA256:
            raise RuntimeError('FFmpeg archive checksum mismatch')
        archive.write_bytes(content)
    if digest(archive) != SHA256:
        raise RuntimeError('Cached FFmpeg archive checksum mismatch: ' + str(archive))
    with zipfile.ZipFile(archive) as z:
        for name in ['ffmpeg.exe', 'ffprobe.exe']:
            members = [m for m in z.namelist() if m.endswith('/bin/' + name)]
            if len(members) != 1:
                raise RuntimeError('Unexpected FFmpeg archive structure')
            (dest / name).write_bytes(z.read(members[0]))
        for member in z.namelist():
            # Copy notice files by basename only; never extract arbitrary paths.
            name = Path(member).name
            if name.lower() in ['license', 'license.txt', 'readme.txt']:
                (dest / name).write_bytes(z.read(member))
    (dest / 'source.json').write_text(json.dumps({'url': URL, 'sha256': SHA256}, indent=2) + '\n', encoding='utf-8')


def check_tools():
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if sys.platform == 'win32' else {}
    for name in ['ffmpeg', 'ffprobe']:
        file = ROOT / 'resources/bin' / (name + ('.exe' if sys.platform == 'win32' else ''))
        result = subprocess.run([str(file), '-version'], capture_output=True, text=True, check=True, **flags)
        print(result.stdout.splitlines()[0])
    ffmpeg = ROOT / 'resources/bin' / ('ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg')
    filters = subprocess.run([str(ffmpeg), '-hide_banner', '-filters'], capture_output=True, text=True, check=True, **flags).stdout
    for name in ['ebur128', 'gblur', 'loudnorm', 'afade', 'alimiter']:
        if name not in filters:
            raise RuntimeError('FFmpeg missing required filter: ' + name)
    encoders = subprocess.run([str(ffmpeg), '-hide_banner', '-encoders'], capture_output=True, text=True, check=True, **flags).stdout
    if 'libx264' not in encoders:
        raise RuntimeError('FFmpeg missing libx264')


def check_emoji():
    folder = ROOT / 'resources/emoji/apple'
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    for row in manifest['assets'].values():
        file = folder / 'images' / row['file']
        if not file.is_file() or digest(file) != row['sha256']:
            raise RuntimeError('Emoji missing or checksum mismatch: ' + row['file'] + '. Run npm run resources -- --emoji')
    print('Emoji artwork: all %s checksums OK' % manifest['glyphCount'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg-dir', help='Copy both tools from an existing local bin directory')
    parser.add_argument('--emoji', action='store_true', help='Prepare / check optional local Apple artwork; see docs/resources.md')
    parser.add_argument('--check-only', action='store_true', help='Do not install or download anything')
    args = parser.parse_args()
    models()
    if not args.check_only:
        install_tools(args.ffmpeg_dir)
        if args.emoji:
            subprocess.run([sys.executable, str(ROOT / 'scripts/prepare-comment-emoji.py')], check=True)
    check_tools()
    if args.emoji:
        check_emoji()
    print('Local resources ready. No runtime network access is needed.')


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
