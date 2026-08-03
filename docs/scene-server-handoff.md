# Handoff → image-server Claude Code: add a `scene` job type

**Audience:** the Claude Code instance that maintains the image-generation server
(Qwen prompt-writing + Flux Klein rendering, the `/jobs` HTTP service the phone
app talks to). You do NOT need the app's source — this defines exactly what the
app will send and what it expects back. Goal: add a new **`scene`** job that
illustrates a book CHAPTER (a few key moments), reusing the existing job pathway.

The app side is being built to match this contract; treat the shapes below as the
agreement. If a field name or flow is awkward on your side, say so and we'll
adjust on both ends before either is finalized.

---

## 1. The pathway as it works TODAY (character images) — for reference

The app submits jobs, polls, fetches PNGs, then deletes. Endpoints in use:

- `GET /health` → `{ ok:true, models:{…}, queue:{ queued:N, running:N } }`
- `POST /jobs` body `{ jobs:[ <job>, … ] }` →
  `{ ok:true, batch_id:"…", jobs:[ { id:"<serverJobId>" }, … ] }`
  (response `jobs[]` is parallel/in-order to the submitted `jobs[]`).
- `GET /jobs/{id}` → a job object (see result shape below).
- `GET /jobs?status=done&limit=200&since=<ISO8601>` → list of done jobs (catch-up poll).
- `GET /image/<ref>` (or a leading-slash path returned in a result) → PNG bytes.
- `DELETE /jobs/{id}` → app calls this once it has pulled every image (free server copy).
- Server prunes jobs after ~3 days; a `GET /jobs/{id}` 404 = "expired", the app treats it as terminal.

**Today's character job** (one entry in the `jobs[]` array):
```json
{
  "card":  "<the character's Japanese card text>",
  "style": "photoreal",
  "model": "klein9b",
  "scenes": 1,
  "size":  "896x1152",
  "modify": "(optional) regenerate instruction, e.g. 'add glasses'",
  "meta":  { "localId":"…", "titleId":"…", "charId":"…", "charName":"…", "attempt":1 }
}
```
Server: Qwen turns `card` into a Flux prompt → renders `scenes` image(s) → result.

**Result shape the app ingests** (`GET /jobs/{id}` or items from `?status=done`):
```json
{
  "id": "<serverJobId>",
  "status": "done",
  "meta": { …the meta echoed back… },
  "results": [
    { "scene": 1, "image_url": "/image/abc.png", "prompt": "…", "caption": "…", "error": null }
  ]
}
```
The app keys each image by `imgId = job.id + "_s" + scene`, fetches `image_url`
(or `file`) via `/image/…`, stores the PNG, and shows `caption` under it. `meta`
MUST be echoed back (the app routes results by it).

---

## 2. NEW: the `scene` job

Same endpoints, same poll/ingest/delete flow, same result shape. The job carries
`kind:"scene"` so you branch into the scene pipeline; **jobs with no `kind` (or
`kind:"character"`) keep today's behavior** (backward-compatible).

**Scene job the app will submit** (one entry in `jobs[]`):
```json
{
  "kind": "scene",
  "chapterText": "<the full text of one chapter>",
  "characters": [
    { "name":"…", "surface":"…", "reading":"…",
      "appearance":"<description from the character card>",
      "relationships":"…",
      "refImage": "(OPTIONAL) data:image/png;base64,…  the character's generated image" }
  ],
  "scenes": 3,
  "style": "photoreal",
  "size":  "896x1152",
  "meta":  { "localId":"…", "titleId":"…", "charId":"scene_<chapterIdx>", "chapterIdx":12, "attempt":1 }
}
```
Notes:
- `scenes` here means **how many distinct scene-moments to pick + render** (NOT
  variations of one prompt). ~2–3.
- `characters` = only the people relevant to this chapter (the app pre-filters).
  Use their `appearance` for visual consistency. `refImage` is optional (see §3).
- `meta.charId` is `"scene_<chapterIdx>"` — just an opaque routing key to the app;
  echo it back unchanged.

**What the server must do for `kind:"scene"`:**
1. **Qwen** reads `chapterText` (with `characters[]` as context). Pick `scenes`
   visually-strong, distinct moments from THIS chapter only. For each, decide
   which of the provided characters appear, and write ONE Flux prompt that bakes
   in their `appearance` so they match their character cards.
2. **Flux** renders ONE image per picked scene.
3. Return the standard result shape, **one `results[]` entry per scene**, each
   with `scene` (1..N), `image_url`/`file`, `prompt` (the Flux prompt used), and
   `caption` = a short human description of the scene (the app shows this under
   the image — Japanese is great, matches the rest of the UI).

So a character job = N variations of one subject; a scene job = N **different**
scenes from one chapter. Otherwise identical wiring.

---

## 3. Character consistency (the main quality lever)

- **Always**: fold each present character's `appearance` text into that scene's
  Flux prompt, so faces/outfits track the character cards.
- **Optional/if supported**: condition the render on the character's `refImage`
  (IP-adapter / img2img) for tighter likeness. **Question for you:** does the
  current Flux Klein setup support a reference image? If yes, the app can include
  `refImage` (base64) per character; if not, we drop it and rely on text. Tell us
  which so the app doesn't send large payloads you can't use.

(Composes with the anatomy-QA idea we discussed — if/when you add the Qwen
"no 3-arms" check + retry, run it on scene renders too.)

---

## 4. Constraints / correctness
- **No spoilers beyond the chapter:** instruct Qwen to draw ONLY on `chapterText`
  (no later-chapter knowledge). The app already only sends chapters the user has
  finished.
- **Idempotency / retries:** same as today — the app may re-poll; a 404 after
  `DELETE` (or 3-day prune) is terminal. Keep result `scene` indices stable so
  `imgId = id + "_s" + scene` stays consistent across re-fetches.
- **Batch size:** the app chunks submissions (~12 jobs/POST). A single scene job
  is one big `chapterText` — fine for Qwen's context (a chapter is ≪ the window).
- **Errors:** per-scene failures → `results[i].error` set (+ no `image_url`); the
  app skips those and can retry.

---

## 5. Open questions for you (server side)
1. **Reference images / IP-adapter** for character consistency — supported? (§3)
2. How does the server currently **dispatch** jobs — is there already a `type`/
   `kind` field, or do all jobs assume "character"? Confirm adding `kind:"scene"`
   is the right switch (or tell us the field you'd prefer).
3. Anything about `chapterText` size/encoding (very long chapters, Japanese) we
   should cap or pre-chunk on the app side?
4. Should scene-picking + rendering be **one** job (Qwen→Flux internally, returns
   N images) — assumed here — or would you rather the app make a Qwen "pick
   scenes" call first, then submit N plain image jobs? (One job is simpler for
   the app; your call based on your queue model.)

---

## 6. Acceptance test (end to end)
1. App sends a `scene` job (chapter text + 2–3 character cards), `scenes:3`.
2. `POST /jobs` returns `{ok:true, jobs:[{id}]}`.
3. `GET /jobs/{id}` eventually returns `status:"done"` with `results[0..2]`, each
   a distinct scene, `image_url` fetchable via `/image/…`, with a `caption` and a
   `prompt` that references the supplied characters' appearances.
4. The three images depict different chapter moments; recurring characters look
   consistent with their character-card images.

That's the whole contract. The app will: submit the scene job, poll, ingest each
`results[]` image under the chapter, and show them (with captions) on the
chapter's timeline card — reusing the existing image gallery. Confirm the shapes
(or propose tweaks) and we'll lock it on both sides.
