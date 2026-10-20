# Third-party components and references

The application source uses MIT (see LICENSE). This does not replace third-party licenses.

| Component | Source / version | License and distribution |
| --- | --- | --- |
| Electron | https://github.com/electron/electron · 33.3.0 | MIT plus Chromium notices. Locally generated portable packages retain LICENSE.electron and LICENSES.chromium.html. |
| ONNX Runtime | https://github.com/microsoft/onnxruntime · Node 1.20.1 | MIT. Installed through npm; retain package notices. |
| esbuild | https://github.com/evanw/esbuild · 0.21.5 | MIT, development build tool. |
| PP-OCR / RapidOCR | https://github.com/RapidAI/RapidOCR and https://github.com/PaddlePaddle/PaddleOCR | Apache-2.0. A fixed model/dictionary snapshot is committed. Hashes: data/model-manifest.json. License: licenses/RapidOCR-APACHE-2.0.txt. Distribution source: https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2/onnx/ . Local filenames are application aliases. |
| Best30 Studio OCR adaptation | Local Best30 Studio source; package-declared author DeepSeek Harness | Package-declared MIT. Recognition/parsing subset is under vendor/ocr; the application adds its own adapter, worker and UI. No private project or images are needed to build. |
| Emoji data / mapping | https://github.com/iamcal/emoji-data · emoji-datasource-apple 3.0.0 and 16.0.0 | Data/library: MIT, Copyright (c) 2013 Cal Henderson. Upstream notices are in resources/emoji/apple/. Apple artwork remains Copyright Apple Inc.; the data package MIT license does not relicense images. |
| FFmpeg / FFprobe | https://ffmpeg.org/ · optional https://www.gyan.dev/ffmpeg/builds/ | Separate executable tools, not committed. The helper downloads a pinned archive locally. libx264 builds are GPL-enabled; see https://ffmpeg.org/legal.html and the selected build's notices before redistributing binaries. |

## Apple artwork

The public source contains only mappings, provenance, hashes and data notices. PNGs, archives and portable packages are excluded from Git. The local preparation script does not establish public/commercial redistribution rights. Do not treat the image set as MIT artwork. The selected appearance is described as Apple artwork, not an officially verified OnePlus / ColorOS font.

## Arcaea and media

Arcaea is a game by lowiro. Names, chart information, artwork, songs and recordings remain the property of their rights holders. This is an unofficial utility. The source contains no character illustrations, gameplay recordings, unlock videos, song audio, background images or original player screenshots. The song table is a manually maintained community snapshot, not an official data feed.

The tutorial contains anonymized score metadata and media references only. Supply media you have permission to use. MIT does not grant rights to game media or resulting videos.

## References

- Workflow: https://github.com/Nick-bit233/mai-gen-videob50 · MIT, Copyright (c) 2024 Nickbit.
- README organization: https://github.com/CialloKing/ba-click-fx .

No affiliation or endorsement is implied. The application does not include an online downloader or game account login.
