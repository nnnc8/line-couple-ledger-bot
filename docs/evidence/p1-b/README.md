# P1-B mobile evidence

All browser captures use controlled API/LIFF fixtures. They are not physical-device or production write evidence. Viewports are CSS pixels; screenshots retain device scale 3 and full-page height. Next.js development indicators appear in the after captures.

## Baseline

Unchanged e332ff2 production build, empty normal form:

- [chromium 390](before/chromium-390-normal.png)
- [chromium 393](before/chromium-393-normal.png)
- [webkit 390](before/webkit-390-normal.png)
- [webkit 393](before/webkit-393-normal.png)

## P1-B states

| State | Chromium 390 × 844 | WebKit 393 × 852 |
| --- | --- | --- |
| Normal create committed | [image](chromium-iphone/normal-committed.png) | [image](webkit-393/normal-committed.png) |
| Submitting | [image](chromium-iphone/submitting.png) | [image](webkit-393/submitting.png) |
| Unknown after dropped response | [image](chromium-iphone/unknown.png) | [image](webkit-393/unknown.png) |
| Reload recovery | [image](chromium-iphone/reload-recovery.png) | [image](webkit-393/reload-recovery.png) |
| Committed plus failed refresh | [image](chromium-iphone/committed-read-failed.png) | [image](webkit-393/committed-read-failed.png) |
| Correction editing exact historical shares | [image](chromium-iphone/correction-draft.png) | [image](webkit-393/correction-draft.png) |
| Correction committed | [image](chromium-iphone/correction.png) | [image](webkit-393/correction.png) |
| Correction plus failed refresh | [image](chromium-iphone/correction-read-failed.png) | [image](webkit-393/correction-read-failed.png) |
| Different actor; stored detail hidden | [image](chromium-iphone/identity-mismatch.png) | [image](webkit-393/identity-mismatch.png) |
| Recovery A before URL B | [image](chromium-iphone/scope-mismatch.png) | [image](webkit-393/scope-mismatch.png) |

The full CI artifact also includes Chromium 393 × 852 and WebKit 390 × 844, all scenario recordings, storage measurements and request timing samples. Artifact retention is 14 days; the images and videos linked here are retained in Git.

## Videos

- [Normal create (Chromium 390)](videos/normal-create.webm)
- [Commit, dropped response, reload, exact replay (Chromium 390)](videos/drop-reload-replay.webm)

## Raw measurements

See [metrics](metrics/) and [file checksums](sha256.json). See [implementation report](../../p1-b-write-outcome-truth.md) for methods, counts and physical-device limitations.
