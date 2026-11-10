# Apple-friendly Blu-ray MP4

`apple-mp4.mjs` needs Node.js 20+ and ffmpeg/ffprobe on PATH, built with libbluray, libx264, AAC, idet and bwdif. No HandBrake or npm packages are used.

Keep `apple-mp4.mjs` and its companion `pgs-ocr.mjs` together in the same directory.

## Inspect first

Run in PowerShell from the directory containing the script:

```powershell
node .\apple-mp4.mjs inspect --source "D:\WAGNER LOHENGRIN" --output "D:\Converted\Wagner - Lohengrin.mp4" --plan "Lohengrin.plan.json" --title "Wagner - Lohengrin"
```

The source can be the disc root or its BDMV folder. The example structure with BDMV/PLAYLIST, CLIPINF, STREAM, index.bdmv and MovieObject.bdmv is supported. Keep the whole structure intact. The script does not decrypt protected discs or modify source files.

Inspection parses MPLS playback sequences, sums their trimmed durations, groups identical sequences, and nominates the longest distinct feature. ffprobe then inspects that playlist through libbluray, rather than selecting a large standalone M2TS. The report includes competing playlists, clip order, duration, video details, all audio tracks, the selected default audio stream, a retain/exclude decision and reason for every audio and subtitle stream, chapters, and the planned conversion. Three 300-frame samples are checked using idet. Inspection also reads the complete selected feature once without encoding to hash retained audio payloads for duplicate detection; this can take time on large or network sources.

Automatic selection is a heuristic: disc menus can encode artistic intent that duration cannot establish. Similar-length competing playlists, repeated clip ranges, uncertain interlace detection, and HDR/wide-gamut sources block encoding. Review the candidate list and original playback when needed. A disc containing multiple complete concerts or multiple discs needs one reviewed plan per desired performance/disc; the script does not join separate discs automatically.

Resolve a competing playlist or audio selection by inspecting again with a **new plan filename**:

```powershell
node .\apple-mp4.mjs inspect --source "D:\WAGNER LOHENGRIN" --output "D:\Converted\Wagner - Lohengrin.mp4" --plan "Lohengrin-reviewed.plan.json" --playlist 1 --audio 2
```

`--playlist` is the MPLS filename number; `--audio` chooses the default among retained useful tracks, using the global ffprobe stream index shown in the report; it does not limit the retained audio set. Known commentary and audio-description labels/dispositions are excluded from automatic audio selection. Among remaining tracks, useful channel count and lossless codecs receive preference. Missing labels cannot reliably distinguish commentary or different languages: review the report and use `--audio` when necessary. Commentary/audio-description tracks remain excluded even when named with `--audio`; that option must identify a useful retained track. If it names an exact duplicate, the retained equivalent becomes default.

For uncertain interlace evidence, inspect playback before using `--interlace progressive` or `--interlace interlaced`. Sampling can miss intermittent interlacing and cannot reliably resolve telecine or progressive material stored as interlaced. HDR needs a separate tone-mapping plan and is deliberately blocked.

## Encode the reviewed plan

```powershell
node .\apple-mp4.mjs encode --plan "Lohengrin.plan.json"
```

The settings are libx264, CRF 20, medium, 8-bit yuv420p and MP4/avc1 with faststart. Resolution stays at source size up to 1920×1080, with even dimensions and original aspect ratio. Frame timestamps are passed through; no target frame rate is imposed. When deinterlacing is selected, bwdif `send_frame` preserves the source frame rate (rather than doubling it to field rate).

All useful non-commentary/non-descriptive audio tracks become AAC-LC: 256 kb/s per stereo/mono track and 512 kb/s per multichannel track. Channel layouts are explicitly preserved where known, with sources above six channels downmixed to 5.1. Side-surround 5.0 and 5.1 sources are explicitly mapped to standard AAC 5.0/5.1, retaining all five/six channels (the side surround pair becomes the surround/back pair) for Apple compatibility. The existing main-audio ranking chooses the sole default retained track. Exact duplicates are removed only when full encoded-payload SHA-256 hashes, codec, channel layout, sample rate, timing, language, title and non-default dispositions agree; different languages, mixes, and codec representations are conservatively preserved. Matching labels alone never establish equivalence. All recognized text subtitle streams are converted to mov_text; styling is simplified. Language tags missing from ffprobe are recovered from primary-angle MPLS stream attributes where available. Audio and subtitle language/title metadata is explicitly mapped, with titles also stored as MP4 handler names. Source dispositions are explicitly passed to the muxer; audio default flags are replaced by the single main-track default, while subtitle default/forced flags are preserved. Other dispositions persist where MP4/ffmpeg can represent them. Because the MP4 muxer may enable a subtitle automatically when none was default, the script restores the intended subtitle enabled flags in the generated partial file before verification. This changes only track-header flag bytes; media offsets, faststart placement and chapter tracks are preserved. PGS/bitmap/interactive Blu-ray subtitles are omitted, never OCRed or burned in. Menus, secondary video, image subtitles and excluded audio tracks are omitted. Playlist entry marks become numbered chapters; source metadata is copied where MP4 supports it, with a supplied title override. Original chapter names generally are not present in MPLS marks.

CRF targets visual quality, not size: the final size and degree of reduction depend on source content. These settings aim for broad Apple compatibility; “Apple Certified” is a friendly label, not an official certification or a guarantee for every device/app version. Test a finished file in the Apple apps you use before deleting anything manually.

Version 2 requires a fresh inspection plan. Version-1 plans are rejected with instructions to inspect again; existing outputs and receipts remain untouched.

## Completion, reruns and recovery

The script encodes to `NAME.mp4.partial.mp4`, probes its H.264/AAC-LC format, frame rate, duration and dimensions, checks exact retained audio/subtitle counts, every AAC-LC codec and channel layout, every mov_text codec, language/title metadata and default/forced flags, then decodes the entire video, every audio track and every retained subtitle track with ffmpeg error checking. Only then is it promoted to the final name without replacing an existing file. A `NAME.mp4.verified.json` receipt records the plan hash and probe results. This verifies decoding with ffmpeg; it does not launch QuickTime or test a physical iPhone.

A rerun fully verifies an existing final output and skips it only when its receipt matches the exact plan. A playable output without a matching receipt is preserved and reported for review. Plan files also use exclusive creation. Never edit a reviewed plan casually; rerun inspection with a fresh name instead. Source playlist bytes and clip sizes/modification times are checked before encoding; this is a change detector, not a full multi-gigabyte content checksum.

Interrupted encodes are not resumed mid-file. Existing partial files block a retry; inspect or rename them yourself before restarting. Failed validation leaves the partial file intact. If a crash leaves a `.chapters.ffmeta` file, inspect/rename that generated sidecar before retrying too. Keep final MP4s, plans and verification receipts together. Completion promotion refuses an existing destination atomically: Windows uses the built-in Windows PowerShell and the two-argument .NET File.Move API; other platforms use an exclusive hard link followed by unlinking the partial, requiring hard-link support on that filesystem. Filesystem or sandbox restrictions fail safely and retain the completed partial. If encoding and verification finished but promotion failed, run `node apple-mp4.mjs finalize --plan "Opera.plan.json"` in an environment with permission to move those output files. Finalize verifies the entire partial again, checks any existing receipt belongs to that plan, and promotes without re-encoding or replacing a final output.

Do not run two encodes for the same output simultaneously. You can run separate reviewed plans one at a time for a collection. Tool locations can be specified with `--ffmpeg "C:\...\ffmpeg.exe" --ffprobe "C:\...\ffprobe.exe"` on either command.

Implementation references: [FFmpeg Blu-ray protocol](https://ffmpeg.org/ffmpeg-protocols.html#bluray), [idet and bwdif filters](https://ffmpeg.org/ffmpeg-filters.html), [libbluray MPLS parser layout](https://github.com/ShiftMediaProject/libbluray/blob/master/src/libbluray/bdnav/mpls_parse.c).

Track mapping reference: [FFmpeg metadata and dispositions](https://ffmpeg.org/ffmpeg.html), [stream hashing](https://ffmpeg.org/ffmpeg-formats.html#streamhash).

## Development checks

Run `npm test` (no npm installation step or packages required). Tests generate small synthetic media in an isolated temporary directory, exercise real ffmpeg/ffprobe conversions, and clean up that directory. They check MPLS trim/chapter parsing, track retention/exclusion, exact-payload deduplication, AAC channel limits, metadata/default/forced preservation, H.264 frame rate, full decoding, and rejection of invalid results. They do not replace inspection and verification of each real Blu-ray.

## Opt-in PGS OCR and lossless remux

PGS remains excluded from ordinary conversion. The explicit `ocr-subtitles` command can add a selected PGS language to an already verified MP4, with **no video or audio re-encoding**. It needs the original Blu-ray, its inspection plan, the converted MP4 and matching receipt, plus local [Subtitle Edit SeConv](https://github.com/SubtitleEdit/subtitleedit/releases) and [Tesseract](https://github.com/SubtitleEdit/subtitleedit/blob/main/docs/third-party-components.md). Install them normally or unpack portable copies; this script never downloads or installs OCR engines. For portable Tesseract, put its English model at `Tesseract/tessdata/eng.traineddata`; the official [tessdata_best model](https://github.com/tesseract-ocr/tessdata_best) favors accuracy. OCR stays local.

Prepare text and a review report:

```powershell
node .\apple-mp4.mjs ocr-subtitles --plan "Opera.plan.json" --language eng --seconv "D:\Tools\SeConv\seconv.exe" --tesseract-dir "D:\Tools\Tesseract" --workdir "D:\OCR\Opera" --prepare-only
```

The command selects a unique matching PGS track. If the language has multiple tracks, pass `--subtitle-index INDEX` using the stream index from inspection. Each play item's primary-angle MPLS language/PID attributes are checked, so a changed PID is not mistaken for another language. PGS is extracted from the original clips with original timestamps, rebased to the playlist's IN/OUT points, and joined on the feature timeline. The 32-bit SUP timestamp wrap is handled; captions crossing trims are clipped. Fully transparent objects are excluded from the visible cue count. No timing is inferred from OCR text or dialogue recognition.

`candidate.srt` and `review.json` appear in the work directory. The report records conservative automatic corrections (standalone `|` to `I`) and flags likely glyph, capitalization, and mixed-letter/digit mistakes. **These heuristics are not a substitute for proofreading.** Compare suspicious text with the original PGS images in Subtitle Edit, then save a **separate** reviewed SRT. Keep every cue and its timing; the command rejects missing, shifted, overlapping or empty cues. Styling may be simplified to MP4 text capabilities.

Mux the reviewed text:

```powershell
node .\apple-mp4.mjs ocr-subtitles --plan "Opera.plan.json" --language eng --seconv "D:\Tools\SeConv\seconv.exe" --tesseract-dir "D:\Tools\Tesseract" --workdir "D:\OCR\Opera" --reviewed-srt "D:\OCR\Opera\reviewed.srt" --output "D:\Converted\Opera - English.mp4"
```

Without `--prepare-only`, the command stops if text is flagged and no reviewed SRT was supplied; otherwise it can complete in one pass. A reviewed SRT means the caller has checked its text. Timings and counts are always checked against the PGS display events, with at most 3 ms of rounding tolerance.

The existing MP4 is preserved. The new file contains all existing video, audio, and text subtitles, plus a selectable, non-forced, non-default `mov_text` track labeled English (`eng`). Other languages use their ISO 639-2 label. Audio default flags, metadata and chapters are retained. Before promotion, the command compares SHA-256 hashes of **every copied video/audio payload**, fully decodes the new MP4, checks all codecs and metadata, compares chapters, and extracts the new subtitle back to SRT to verify every text and timing value. It creates a matching verification receipt and a standalone SRT next to the result.

Output paths must be new; using the original MP4 path is rejected. Partial files and conflicting existing outputs are preserved for inspection. A fingerprint-bound, SHA-256-checked work cache supports reruns without repeating extraction/OCR. Do not edit cache files; save text edits as a separate reviewed SRT. If a failed run leaves an unverified cache or partial remux, inspect/rename it or use a fresh work/output path. A different source, plan, language or track needs a different work directory.

## Optional hardcoded PGS encode

`burn-pgs` is an alternative encode path from a reviewed Blu-ray plan. **It needs no converted MP4 and no verification receipt.** It renders the selected normalized PGS images into the original video, using the same planned deinterlace/scale filters followed by one libx264 CRF 20 / medium / yuv420p encode. All retained audio comes from the original Blu-ray and is converted to AAC-LC by the same track pipeline as ordinary `encode`, including channel limits, bitrates, language/title metadata and default dispositions. Chapters, title/source metadata and retained text subtitles also use the ordinary conversion pipeline.

PGS burning is explicit, permanent and not switchable. It does not OCR and needs neither SeConv nor Tesseract. Ordinary `encode` still ignores PGS; `ocr-subtitles` still adds selectable text by modifying an existing verified MP4.

Inspect the exact command first:

```powershell
node .\apple-mp4.mjs burn-pgs --plan "Opera.plan.json" --language eng --workdir "D:\PGS\Opera" --output "D:\Converted\Opera - English burned.mp4" --prepare-only
```

Remove `--prepare-only` to encode. Use `--subtitle-index INDEX` if the language is ambiguous. The source fingerprint, reviewed-plan warnings, PGS cache hashes, no-overwrite checks, codec/track/chapter verification and full decode checks apply. Both encode paths use the same safe finalization code. A receipt binds a burned render to its plan, selected language and normalized PGS hash, so an ordinary encode or a different burn is not silently reused. If a completed partial needs promotion after a permissions failure, repeat the same burn command with `--finalize`; it fully verifies again before moving the file. Encoding interruptions still restart rather than resume mid-file.

The regression test runs the production burn operation with **no base MP4 or receipt**, original interlaced video, PCM stereo and 5.1 audio, source text subtitles and planned chapters. It verifies timed PGS appearance/clearing, progressive H.264 at the source frame rate, both AAC-LC tracks and their metadata/defaults, mov_text preservation, chapters, full decoding and render-identity no-overwrite checks. The burn and ordinary encode command settings are compared to ensure they share the same track/metadata pipeline. A long-chapter remux test guards against MP4 chapter timescale overflow when adding text subtitles.

### Relocated verified MP4s

Only `ocr-subtitles` accepts `--base-mp4 "D:\Archive\Opera.mp4" --base-receipt "D:\Plans\Opera.mp4.verified.json"` when the verified MP4 was moved. The receipt must belong to the same inspection plan and match the file size; codec, track and metadata checks still apply. A verified OCR-enhanced MP4 can also be the base for another OCR-remux operation, preserving its existing tracks. Adding a duplicate text language is rejected. `burn-pgs` rejects base-MP4 options because its video, audio, metadata and text tracks come directly from the reviewed Blu-ray source.
