# Kadoki — Local Qwen (OpenAI-compatible) text-AI backend

Option to route all text AI (chapter processing, character extraction/deep-dive, session summary, segmentation, image prompts) to a **local Qwen server** instead of the Anthropic API, via a pref toggle. Grounded in a 4-agent code audit (2026-06-13).

## Verdict: HIGH feasibility
All text AI funnels through **one seam** — `window.ai.request()` (`ai.js:327–381`), branched at `sendOnce` (`ai.js:349–356`). Cost/usage/model are already abstracted. **The risk is NOT context size — it's structured-JSON reliability + Qwen's thinking mode.**

## Context / gating — the worry is a non-issue
Real max per-chapter request, from the actual caps:
- text `INPUT_CAP=60000` (`ai-processor.js:22`, tail-kept) + synopsis `SYNOPSIS_CAP=4000` (`:30`) + compact char DB `PROMPT_CAP=4000` (`ai-characters.js:21`) + unresolved 15×200=3000 (`ai-processor.js:563`) + system ~2500 + separators ~1500 ≈ **75,000 chars**.
- @1.2 tok/char (app's own estimate, `ai-processor.js:195`) ≈ 90k; @1.5 conservative ≈ 112k input; + `MAX_TOKENS=8000` output → **~98k–120k tokens per chapter.**
- **Fits 128k with headroom; fits 260k luxuriously. No Haiku-style fallback needed.** Chapter gating (`MERGE_MIN_JP=5000`/`SPLIT_MAX_JP=30000`/`TARGET_JP=12000`, `ai-chunks.js:30–32`) + running synopsis already bound it.
- **Only exception:** one-time **segmentation** `MAX_SEG_CHARS=180000` (`ai-chunks.js:36`) ≈ 216k–270k tok — can exceed 260k. But it already degrades to the rule-based map on any failure (`ai-chunks.js:560–561, 623`); just lower its cap (or `MAX_SEG_WINDOWS`, `:35`) for the local route.

## The 4 call sites
| Feature | Loc | JSON schema | Streams | Input |
|---|---|---|---|---|
| Chapter processing | `ai-processor.js:755` | YES (7-field nested, **critical**, 3-retry-then-abort) | no | ~70–75k chars |
| Segmentation | `ai-chunks.js:586/595` | YES (simple) — LOW risk, falls back to rule map | no | up to 180k chars |
| Character deep-dive | `ai-characters-ui.js:396` | no (plain text) | YES (`onText`) | ≤60k chars + `cache_control` |
| Session summary | `ai-summary.js:292` | no (plain text) | YES (`onText`) | ≤20k chars |

## Design
**Prefs (~`ai.js:13–16`, load in the `ready` IIFE `ai.js:59–82`):** `AI_BACKEND` (`'anthropic'`|`'openai-compat'`), `AI_BACKEND_URL` (e.g. `http://192.168.1.50:8000`), `AI_BACKEND_MODEL`.

**Branch (`ai.js:349–356`):** `if (_backend==='openai-compat') return await requestOpenAI(opts, body);` — reuse the `body` already built at `ai.js:331–342`.

**`requestOpenAI(opts, body)` adapter (mirrors `requestStream` `ai.js:459–480`):**
- System → `messages.unshift({role:'system', content: body.system})`.
- **Content flatten (load-bearing):** `messages[].content` may be a string OR a block array (char-deep sends an array w/ `cache_control`, `ai-characters-ui.js:403–409`). Join blocks → string and **drop `cache_control`** (Anthropic-only).
- Auth `Authorization: Bearer <key>`; drop `anthropic-version` / `anthropic-dangerous-direct-browser-access`. Endpoint `${_backendUrl}/v1/chat/completions`.
- Response: text = `choices[0].delta.content`; end = `data: [DONE]`; usage = final-chunk `usage.prompt_tokens`/`completion_tokens` (add `stream_options:{include_usage:true}`); refusal = `finish_reason==='content_filter'` → reuse "model declined".

**STRUCTURED OUTPUT (the bulk of the work) — do all three:**
1. `response_format:{type:'json_schema', json_schema:{name:'response', schema, strict:true}}` (vLLM guided-decoding / recent llama.cpp / Ollama honor it; vLLM also `extra_body:{guided_json:schema}`, Ollama native `format:<schema>`).
2. **Also inject the schema into the prompt** ("Return ONLY JSON matching … no markdown/prose") — for servers that don't strictly enforce.
3. **Validate-and-retry** in `requestOpenAI` for schema calls: `JSON.parse` → on fail strip ```` ```json ```` fences + prose, extract first balanced `{…}`, re-parse → if still bad and `opts.retryable`, re-ask once. Chapter site already has a 3-retry loop; segmentation needs nothing (graceful `return null`).
- For the two JSON sites prefer **non-streaming** (`stream:false`); keep streaming for the two `onText` text sites.

**Cost=0 + label:** `priceFor` (`ai.js:115–119`) falls back to *sonnet* pricing for unknown models → would invent fake $. Force `costUsd=0` for local; record usage under `qwen-local` so the ledger still counts tokens. Update `estimateCostUsd` UI hints to "local / $0".

**Global toggle for v1** (matches the ask). Per-feature routing (chapter on Claude for JSON determinism, summary/char-deep on Qwen) is a clean later add via `modelFor` (`ai.js:84–89`).

## Build order
- **S0 — smoke test (~1h):** one hardcoded free-text `POST /v1/chat/completions` from the device to the server. **Proves reachability/cleartext/ATS — the real unknown, not the code.**
- **S1 — adapter + global toggle (~½ day):** prefs + `requestOpenAI` + content flatten + Bearer + branch + cost=0/`qwen-local` + **disable Qwen thinking**. Plain-text features work end-to-end.
- **S2 — structured output + validate-retry (~½ day, bulk):** schema→`response_format` + prompt-inject + JSON repair + one re-ask; wire into chapter + segmentation.
- **S3 — polish (~½ day):** `include_usage`, `[DONE]`, optional per-feature routing, "local $0" UI, raise the watchdog (below).

## Gotchas
1. **Qwen3 thinking mode is ON by default** → a `<think>…</think>` prefix pollutes summaries and breaks `JSON.parse`. Disable: vLLM `chat_template_kwargs:{enable_thinking:false}` / `/no_think` / Ollama equivalent. **The single most likely "returns garbage" cause.**
2. **Cleartext/ATS — currently localhost-only.** `network_security_config.xml` permits cleartext for only `localhost`/`127.0.0.1`/`10.0.2.2`; iOS `Info.plist` has **no** ATS exception. **A LAN-PC server (`192.168.x.x`) is BLOCKED on both platforms** (CapacitorHttp respects the Android config). Fix = add the PC subnet to `network_security_config.xml` + `NSAllowsLocalNetworking`/`NSExceptionDomains` in iOS `Info.plist`. **NOTE:** there is no existing image-gen LAN module to inherit this from yet (image-gen is still a plan) — but it's the *same* config both features need, so set it up once.
3. **Highest JSON-risk = chapter (`ai-processor.js:755`).** Segmentation is LOW risk (falls back to rule map). char-deep + summary are plain text.
4. **`priceFor` fake-cost** for unknown models → force 0.
5. **Japanese quality:** Qwen3 strong at JP, but Opus/Sonnet better at nuanced literary JP (char psychology, synopsis prose); chapter extraction is format-driven = lower stakes. A/B one real chapter.
6. **Won't translate:** `cache_control` prompt caching (drop it — $0 anyway, but a local GPU re-encodes the full ~112k-tok prompt each call = latency); adaptive tier `modelFor` collapses to one local model.
7. **15s first-byte watchdog** (`ai.js:386–389`) is too aggressive for a local ~100k-tok prompt that takes >15s to first token → false abort + pointless native fallback. Raise it (or disable native fallback) for the local backend.

Relevant files: `ai.js` (seam 349–356, body 331–342, native bridge 267–290, pricing 20–24/115–119, watchdog 386–389), `ai-processor.js` (chapter 755–766, caps 22/29/30), `ai-chunks.js` (segmentation 562–624, caps 30–36), `ai-characters-ui.js` (char-deep + cache_control 396–409), `ai-summary.js:292`, plus `android/app/src/main/res/xml/network_security_config.xml` + `my-app/ios/App/App/Info.plist`.
