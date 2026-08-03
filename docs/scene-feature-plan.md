# Scene feature plan (2026-06-17)

Status: **planning** (app side not built; server `scene` job to be coordinated separately).

Illustrate a CHAPTER with a few AI-picked "scenes," shown on that chapter's
Dynamic-Timeline card. Per chapter: the app sends the **chapter text + the
character cards for the characters in that chapter** to the Mac/PC server; the
server's Qwen reads the chapter, picks ~2–3 visually-strong moments, writes a
Flux prompt for each (incorporating the supplied character appearances for
consistency), Flux renders them, and the app ingests + displays them — reusing
the existing character-image gallery (view / swipe / pinch-crop / delete).

It's the character-image pipeline at chapter granularity. Most of the
intelligence is server-side (the `scene` job); the app side is thin.

---

## 1. The reuse trick — scenes are "images under a chapter pseudo-character"

`ai-images.js` already keys all image storage + UI by `(titleId, charId)`:
`getImages`, `deleteImage`, `recropImage`, `buildImageStrip` (the swipe-carousel
gallery + pinch-crop lightbox), `setCaption`, and the cross-device `mergeIndexBlob`
(union + tombstones). If a chapter's scenes are stored under a **synthetic charId
`scene_<chapterIdx>`** in the very same `AICHAR_IMGIDX_V1_<titleId>` index, then:

- `buildImageStrip(titleId, 'scene_<chapterIdx>', {...})` → the scene gallery, free.
- delete / recrop / caption / the new fullscreen viewer → all work unchanged.
- **Sync is free**: the image union-merge already iterates every char key, so
  `scene_*` buckets sync (with tombstones) exactly like character buckets.

So the only genuinely-new app code is: a per-chapter **trigger** that builds the
payload + submits a `scene` job, and a **scene strip** on the timeline chapter
card. Everything downstream is existing machinery.

(Keep the `scene_` prefix distinct so character UIs that enumerate `idx.chars`
can filter them out where appropriate, e.g. the Characters screen shows people,
not scenes.)

---

## 2. App side

### Trigger (on the Dynamic Timeline chapter card — ai-timeline.js)
- A **"✦ illustrate this chapter"** button on each chapter card, and/or auto for
  newly-read chapters (see §5 gating). On-demand first (compute-cheap, explicit);
  auto behind a pref later.
- Gated on the chapter being **read/complete** (reuse the timeline's existing
  read-frontier / chapter-completion gate) — never illustrate ahead (spoilers).
- Shows progress via the existing image "pending" status; the scene strip fills
  in as renders arrive (same poll/ingest loop as character images).

### Payload (what the app sends)
`{ kind:'scene', titleId, chapterIdx, chapterText, characters:[…], count, style, size }`
- **chapterText**: the chapter's text. Source it from the chunk map / cue range
  for the chapter (`ai-chunks` already holds per-chapter text). A full chapter
  fits the local Qwen context comfortably (~100k tok ≪ 128k/260k).
- **characters**: the character cards for the people in this chapter — `{ name,
  surface, reading, appearance/description, relationships }` from `AICHAR_V2`.
  Selection: prefer characters the app already associates with the chapter; if
  that association isn't tracked, send the characters known **up to** this
  chapter and let Qwen pick which actually appear. (Decision in §6.)
  - Optional, for visual consistency: also include each character's **generated
    image** (base64) as a reference (IP-adapter/img2img) — server-capability +
    payload-size dependent; see §4 and §6.
- count (≈2–3), style/size: reuse the existing image prefs.

### Submit / ingest (reuse ai-images.js)
- Submit via the existing `POST /jobs` path with `kind:'scene'` (the job carries
  `meta:{ titleId, charId:'scene_<chapterIdx>', chapterIdx }` so results route
  back into the scene bucket exactly like character results route to a char).
- Poll + ingest are the existing `sync`/`pollPending`/`ingestJob` — `ingestJob`
  already writes the returned image under `meta.charId` into the index, so a
  `scene_<chapterIdx>` charId just works. Each returned image keeps its
  server-written `caption` (the scene description) — shown by the gallery.

### Storage
- No new store: the `scene_<chapterIdx>` bucket lives in the existing
  `AICHAR_IMGIDX_V1_<titleId>` index + `AICHAR_IMG_V1_<titleId>_<imgId>` blobs.
- Carries `modTs` + tombstones like character images → crop/delete propagate +
  union-merge on sync, all for free.

### Display
- The timeline chapter card renders `buildImageStrip(titleId,
  'scene_<chapterIdx>', { interactive:true, onChange })` → swipe carousel,
  fullscreen tap-to-open, pinch-to-crop, delete — identical to character images.

---

## 3. Server-side `scene` job (coordinate separately — the PC/Mac console)

Input (from the app): `{ kind:'scene', chapterText, characters:[{name, appearance,
…}], count, style, size, meta:{ titleId, charId:'scene_<chapterIdx>', chapterIdx } }`.

Server pipeline:
1. **Qwen**: read `chapterText`; pick `count` visually-strong, spoiler-safe-within-
   the-chapter moments; for each, identify which of the supplied `characters`
   appear, and write a Flux prompt that bakes in their `appearance` (so the
   people look like their character cards). Return a structured caption per scene.
2. **Flux (Klein)**: render each prompt. (Optional: condition on the supplied
   character reference image via IP-adapter/img2img for tighter consistency.)
3. Return results on the SAME pathway the app already polls (`GET /jobs?status=done`
   → `GET /image/…`), one image per scene, each with `caption` (+ optionally
   `charactersPresent`, `prompt`).

The app is agnostic to how the server does this — it submits the payload and
ingests images, same as character jobs.

---

## 4. Character consistency (the main quality lever)

Scenes look generic unless the people match their cards. Two levels:
- **Text**: include each present character's `appearance` in the scene prompt
  (Qwen does this from the supplied character cards). Cheap, always do it.
- **Visual**: pass the character's generated image as a reference
  (IP-adapter/img2img) so the rendered face/outfit matches. Higher fidelity;
  depends on the server's Flux setup supporting reference conditioning, and
  inflates the payload (base64 images). Decide per server capability (§6).

Composes with the deferred Qwen **anatomy QA** (3-arm check + retry) — run it on
scene renders too.

---

## 5. Spoiler / read gating
- Only illustrate chapters the user has **read/completed** (reuse the timeline's
  read-frontier gate — the same signal that drives chapter summaries).
- Within a chapter, Qwen is told to draw only from the chapter text (no
  later-chapter knowledge), so a scene can't spoil ahead.

## 6. Open decisions (confirm before building app side)
1. **Trigger**: on-demand button only (safer) vs auto for read chapters (magical, more compute). Lean on-demand first.
2. **Scene count**: 2 or 3 per chapter.
3. **Character selection for the payload**: does the app already tag which
   characters appear per chapter (so we send just those), or send
   known-up-to-here and let Qwen filter? (Affects payload size + accuracy.)
4. **Reference images**: send character image(s) for visual consistency
   (IP-adapter) or text-appearance only? (Server capability + payload size.)
5. **Caption**: keep the server's per-scene caption; render via the existing
   (now card-sized) caption element.

## 7. Build order (when greenlit)
1. App: scene bucket plumbing (`scene_<chapterIdx>` charId helpers) — trivial, reuses ai-images.
2. App: timeline chapter-card trigger (gated) + payload builder (chapter text + character cards).
3. App: scene strip on the chapter card (reuse buildImageStrip) + ingest wiring.
4. Server (other console): the `scene` job (Qwen scene-pick + Flux render + the agreed I/O contract).
5. Review (never-lose-place is N/A here; focus = correct gating, no spoiler-ahead, sync of scene buckets) + cap sync.

Nothing here is built yet. The image viewer reuse (gallery/crop/delete/sync) is
already in place, so step 1–3 are small once the §6 decisions + the §3 contract
are fixed with the server side.
