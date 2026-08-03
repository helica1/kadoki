# Kadoki — Local Image Generation (app-side integration plan)

Backend = **ComfyUI running Ideogram 4 (NF4) on the user's RTX 3090 PC, reached over the LAN.**
PC setup is a separate runbook: `docs/comfyui-ideogram4-pc-setup.md` (hand it to Claude Code on the PC).
All app files: `my-app/www/`. New module: `my-app/www/ai-images.js`.

## 1. Model decision
**Ideogram 4 (NF4)** — chosen by the user after hands-on tests (excellent character art; better than the agents' reputation-based read suggested). Runs on the 3090 via ComfyUI; NF4 is the "fits-24 GB" build. No hosted content filter is involved (ComfyUI has no safety checker; we never use Ideogram's hosted "magic prompt" upsampling, which would route through their policied API — drive raw prompts only).
- **License caveat:** Ideogram 4 weights are **non-commercial**. Fine for personal/local use; a real consideration only if the image feature is ever shipped commercially. Keep the **checkpoint filename a config value** so swapping to a commercial-OK engine (FLUX.1-schnell Apache-2.0, or SDXL OpenRAIL++) later is a one-line change, not a rewrite.

## 2. Backend (see runbook for full setup)
- ComfyUI launched `--listen 0.0.0.0 --port 8188 --enable-cors-header "*"`, firewall TCP 8188 (Private profile only), LAN-only.
- Drive via HTTP API: `POST /prompt` (queue) → poll `GET /history/{id}` → `GET /view?filename=...` (PNG bytes).
- **Skip the `/ws` progress socket** — it's cleartext `ws://` (mixed-content blocked in the webview) and CapacitorHttp does not proxy WebSockets. Poll `/history`.

## 3. Reaching the PC from the phone — 4 layers, fix ALL or it silently fails
1. **CapacitorHttp plugin** — `capacitor.config`: `{ plugins: { CapacitorHttp: { enabled: true } } }`. Monkey-patches `window.fetch`/XHR onto the native HTTP stack → kills both CORS and mixed-content; the app's existing `fetch()` style keeps working unchanged.
2. **Android cleartext** — scoped `res/xml/network_security_config.xml` permitting cleartext for **just the PC's LAN IP/subnet** (Play-safe; don't blanket-allow), referenced from `AndroidManifest`.
3. **iOS ATS** — `NSAppTransportSecurity → NSAllowsLocalNetworking = true` in `Info.plist` (narrow RFC-1918 exception; not `NSAllowsArbitraryLoads`).
4. **iOS 14+ Local Network Privacy** — add `NSLocalNetworkUsageDescription` string or first connect silently fails.

## 4. New module `ai-images.js` (closure pattern like ai-processor.js / ai-characters.js)
```
window.aiImages = {
  generatePortrait(titleId, charId, rec),
  generateScene(titleId, idx, event, chapterText),
  getPortrait(titleId, charId),  getScene(titleId, idx, eventIdx)
}
```
Constants: `PORTRAIT_PREFIX='AICHAR_PORTRAIT_V1_'`, `SCENE_PREFIX='AICHAP_SCENE_V1_'`, `COMFY` base URL from a pref (`localStorage COMFY_URL`; blank = feature OFF → see §6).

**ComfyUI client** (port the researched code): `submit(graph)` POSTs `{prompt, client_id}` to `/prompt` (throw on populated `node_errors`); `waitForImage(id)` polls `/history/{id}` until `outputs[node].images[0]`; `fetchPngDataUrl({filename,subfolder,type})` GETs `/view?...` → `blob()` → `FileReader.readAsDataURL` → `data:image/png;base64,...`.
**The `buildGraph` node-id map (positive / negative / sampler-seed / loader / SaveImage) must come from the PC runbook §7 export — do not hard-code the example ids.** Sampler settings depend on the Ideogram 4 template the runbook produces.

**Claude prompt builder** — reuse the existing Anthropic call site (`window.ai.request`, ai.js:327–381; used by ai-processor.js:755–764). Auto-records usage+cost (`recordUsage`:375, `addCost`:379) — no extra accounting. Only this Claude call costs money; ComfyUI is free.
```
const r = await window.ai.request({
  feature: 'portrait',            // or 'scene-illustration'
  titleId, model: chapterModel(), // or claude-haiku-4-5 to keep this small call cheap
  system: IMAGE_PROMPT_SYSTEM,    // "turn a character/scene into a diffusion prompt; dark literary register OK"
  maxTokens: 600,
  outputSchema: { type:'object', additionalProperties:false,
    properties:{ positive:{type:'string'}, negative:{type:'string'} }, required:['positive','negative'] },
  messages: [{ role:'user', content: contextString }],
});
const { positive, negative } = JSON.parse(r.text);
```
Portrait context from `rec.surface / rec.appearance / rec.personality / rec.role`; scene context from `event.title / event.description` + chapter text.

**Storage** (`blobStore.set/get`, blob-store.js:91–95; values are strings, base64 data URIs):
- portrait → `AICHAR_PORTRAIT_V1_<titleId>_<charId>`
- scene → `AICHAP_SCENE_V1_<titleId>_<idx>_<eventIdx>`
Persist base64 to IndexedDB and bind `<img src>` on demand — **don't keep many base64 PNGs in the DOM** (~33% larger than binary, lives in JS memory). Same storage-only pattern as `AIDEEP_V1` (ai-characters-ui.js:369).

## 5. UI wiring (real call sites)
- **Character popup** — `ai-characters-ui.js` `openCharPopup()` (487–570): add `wirePortrait(rec, titleId, host)` after the role-chip block (after line 540, before `deepHost` at 541), modeled on `wireDeepDive` (434–460). If `getPortrait` returns a dataUri → render `<img>`; else a "Generate portrait" button → `generatePortrait` → swap in `<img>`. Add "Regenerate" (new seed).
- **Characters screen** — `ai-characters-screen.js` `buildCard()` (136–233): thumbnail `<img>` after the role chip (line 160), before the chapter-link section (190).
- **Timeline chapter card** — `generateScene(titleId, idx, event, chapterText)`; render the scene `<img>` on the card.
- **Red-dot "new art"** — reuse the existing AI red-dot convention: set a per-title "unseen art" flag on completion, clear on open.

## 6. Shipping limitation (be honest)
A LAN/self-hosted backend works for the dev on his Wi-Fi but **arbitrary TestFlight/App-Store users cannot reach his PC**. **Gate the feature behind the `COMFY_URL` pref** (a dev/power-user setting) so the App Store build behaves as if it doesn't exist for normal users. Future product paths: (a) host an authenticated **HTTPS** GPU endpoint (also removes the §3 cleartext hacks, but adds cost + moderation ownership), or (b) on-device generation (Core ML / SDXL — slow on a phone, big download). And remember the non-commercial weights (§1).

## 7. Build order (smallest first)
- **S0** — Backend smoke test (the PC runbook): ComfyUI + Ideogram 4 NF4 returns a PNG over the LAN via the HTTP API.
- **S1** — One hardcoded round-trip: wire Capacitor (§3); `ai-images.js` with a hard-coded `COMFY_URL` + hard-coded prompt; one "Generate" button in `openCharPopup()` round-trips an image into a character card via `blobStore` + `<img>`. Proves the pipe.
- **S2** — Claude prompt-gen: replace the hard-coded prompt with the `window.ai.request({feature:'portrait', outputSchema:{positive,negative}})` builder.
- **S3** — Scene art on the timeline card from `event` + chapter text → `AICHAP_SCENE_V1_`.
- **S4** — Polish: regenerate-with-seed, red-dot "new art", Characters-screen thumbnails, the `COMFY_URL` pref + feature gate, blobStore memory hygiene, loading spinners.

After any `www/` edit: `npx cap sync android` **and** `npx cap sync ios` before installing.
