# ComfyUI + Ideogram 4 (NF4) — PC Setup Runbook for Claude Code

**You are Claude Code running on the user's Windows/Linux PC with an NVIDIA RTX 3090 (24 GB).**
Your job: stand up a **local ComfyUI** server running **Ideogram 4 (NF4 quant)**, reachable over the **LAN**, and prove it end-to-end with the HTTP API. This server will be called by the user's phone app ("Kadoki", a Capacitor reading app) to generate character portraits and scene illustrations from novels. Generation must run **fully locally** — never route prompts through any hosted/cloud image API.

## Operating rules (read first)
1. **This model is new (Ideogram 4 = Ideogram's first open-weights release, ~June 2026).** Do **not** trust the exact filenames/node names/folders in this doc as gospel — they were captured from research and may have changed. **Verify the current specifics** from the authoritative sources below before downloading, and adapt:
   - ComfyUI day-0 blog: https://blog.comfy.org/p/ideogram-4-day-0-support-in-comfyui
   - Custom nodes README: https://github.com/ideogram-oss/ComfyUI-Ideogram4
   - ComfyUI repackaged weights (model card + file list): https://huggingface.co/Comfy-Org/Ideogram-4
   - Official first-party quant (gated): https://huggingface.co/ideogram-ai/ideogram-4-nf4
2. **Stop at the first failed step.** Don't paper over an error to reach the end — diagnose, fix, then continue. Report what you did.
3. **Don't guess paths or IPs.** Detect them. Print every value the user/app will need.
4. **License note (state to the user, don't block on it):** the Ideogram 4 *weights* are non-commercial. Fine for personal/local use. Only a concern if the image feature is ever shipped commercially.
5. **Success = the smoke test in §8 writes a real PNG via the HTTP API, and you report the values in §9.**

---

## 0. Preflight — detect the environment
Run and record:
- **OS / shell**: Windows (PowerShell) or Linux (bash)? Lead with the matching commands below.
- **GPU + driver**: `nvidia-smi` — confirm an RTX 3090 (24 GB) is visible and note the **driver + CUDA** version. If `nvidia-smi` fails, stop: the NVIDIA driver must be installed first.
- **Python**: need **3.11 or 3.12** (`python --version` / `py -0p` on Windows). ComfyUI portable bundles its own; a system Python works too. Avoid 3.13 unless the deps support it.
- **git**: `git --version` (install if missing).
- **Disk**: need **~40 GB free** (weights + venv). Check the target drive.

Report this table before proceeding.

---

## 1. Hugging Face access (the repos are GATED)
The Ideogram 4 weight repos require accepting a license + an auth token.
1. Tell the user to open the repo in a browser and click **"Agree and access"** while signed in:
   - https://huggingface.co/ideogram-ai/ideogram-4-nf4 (and/or https://huggingface.co/Comfy-Org/Ideogram-4)
2. Install the CLI and log in:
   ```
   pip install -U "huggingface_hub[cli]"
   hf auth login        # paste a token from https://huggingface.co/settings/tokens (read scope)
   ```
   (Older versions: `huggingface-cli login`.)
3. Verify access: `hf auth whoami` succeeds, and you can see the file list of the gated repo. If download later 401/403s, the license wasn't accepted on that account — go back to step 1.

---

## 2. Install ComfyUI
Pick ONE:

**Option A — Windows portable (simplest on Windows):** download the latest **ComfyUI Windows portable** release from https://github.com/comfyanonymous/ComfyUI/releases, extract it, and use its bundled `python_embeded`. Update it (`update/update_comfyui.bat`) so you're on **≥ 0.24.0** (Ideogram 4 needs a recent build).

**Option B — git + venv (Windows or Linux):**
```
git clone https://github.com/comfyanonymous/ComfyUI
cd ComfyUI
python -m venv venv
# Windows:  venv\Scripts\activate     Linux:  source venv/bin/activate
# Install PyTorch matching the installed CUDA (check nvidia-smi). Example for CUDA 12.x:
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
```
Confirm the build is **≥ 0.24.0** (`git pull` if not). Do a bare launch once (`python main.py`) to confirm it starts and detects the 3090, then Ctrl-C.

---

## 3. Install the Ideogram 4 custom nodes
The Ideogram 4 model needs its custom nodes (Apache-2.0):
```
cd ComfyUI/custom_nodes
git clone https://github.com/ideogram-oss/ComfyUI-Ideogram4
cd ComfyUI-Ideogram4
# install its requirements into ComfyUI's python:
pip install -r requirements.txt      # (use python_embeded\python.exe -m pip ... for the portable build)
```
- **NF4 needs bitsandbytes**: `pip install -U bitsandbytes` (CUDA build; on Windows ensure a recent version with CUDA wheels). If the node's README specifies its own loader/deps for NF4, follow the README — it wins over this line.
- Restart ComfyUI and confirm the Ideogram 4 nodes register (they appear in the node menu / in `GET /object_info`). **Read the README's "node list" and any `example_workflows/` — you'll need the exact loader `class_type` names in §7.**

---

## 4. Download the Ideogram 4 weights (NF4) into the right folders
**Verify the current file set from the `Comfy-Org/Ideogram-4` model card / the node README first.** As of research, the ComfyUI path uses these separate files (names may differ — confirm):
- DiT (the model) — the **NF4** build, e.g. `ideogram4_*_nf4*.safetensors`  → `ComfyUI/models/diffusion_models/` (or `models/checkpoints/` — follow what the Ideogram4 loader node expects)
- `ideogram4_unconditional_*.safetensors` (the "unconditional" companion) → same folder as the DiT
- Text encoder — **Qwen3-VL-8B**, e.g. `qwen3vl_8b_fp8_scaled.safetensors` → `ComfyUI/models/text_encoders/`
- VAE — `flux2-vae.safetensors` (Flux-family VAE) → `ComfyUI/models/vae/`

Download with the CLI straight into ComfyUI's tree, e.g.:
```
hf download Comfy-Org/Ideogram-4 <exact-filename> --local-dir ComfyUI/models/diffusion_models
```
(Repeat per file into its correct folder. Prefer the **NF4** DiT for the 3090 — it's the "fits 24 GB" build. **Do not** use the FP8 DiT on a 3090: Ampere has no FP8 tensor cores, so FP8 is emulated/slow with little benefit. If NF4 quality disappoints, the upgrade path is a **Q4_K/Q5 GGUF** DiT via the `ComfyUI-GGUF` nodes — note this to the user but start with NF4.)

**VRAM sanity (3090/24 GB):** NF4 DiT (~5–6 GB) + Qwen3-VL-8B fp8 text encoder (~8 GB) + VAE → comfortably under 24 GB. After the first generation, run `nvidia-smi` and report peak VRAM + headroom.

---

## 5. Configure for LAN access
The phone (a different device on the same Wi-Fi) must reach this server, so bind to all interfaces and allow cross-origin:
- Launch flags (used in §6): `--listen 0.0.0.0 --port 8188 --enable-cors-header "*"`
- **Find and report the PC's LAN IP** (the app config needs it):
  - Windows: `ipconfig` → the IPv4 of the active adapter (e.g. `192.168.1.50`)
  - Linux: `ip addr` / `hostname -I`
- **Firewall** — allow inbound TCP **8188**:
  - Windows (admin PowerShell):
    ```
    New-NetFirewallRule -DisplayName "ComfyUI 8188" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8188 -Profile Private
    ```
    (Only the **Private** profile — don't expose it on public networks.)
  - Linux: `sudo ufw allow from 192.168.0.0/16 to any port 8188 proto tcp` (scope to the LAN subnet).
- **Security:** this is a plaintext-HTTP, unauthenticated server. Keep it **LAN-only** (the `Private` firewall profile / subnet scope above). Do **not** port-forward it to the internet.

---

## 6. Launch ComfyUI
```
# git/venv build:
python main.py --listen 0.0.0.0 --port 8188 --enable-cors-header "*"
# portable build: run_nvidia_gpu.bat after adding those flags to it
```
Confirm in the log: the 3090 is selected, the Ideogram 4 nodes loaded, and it's serving on `0.0.0.0:8188`. From the **PC's own browser** open `http://localhost:8188` and confirm the UI loads.

---

## 7. Build a working Ideogram 4 workflow + export API format
The app drives ComfyUI via the **API-format** graph and needs the **node-id map**. Produce it:
1. In the ComfyUI UI, load the **Ideogram 4 example/template workflow** (shipped in `custom_nodes/ComfyUI-Ideogram4/example_workflows/` or linked from the day-0 blog). It should chain: Ideogram4 **model/checkpoint loader** → text-encode(positive)/(negative) → sampler → VAE decode → **SaveImage**.
2. Set a simple test prompt and **Queue Prompt once** in the UI to confirm an image renders correctly with the downloaded weights. Fix any missing-file/node errors now.
3. **Enable dev mode** (Settings → "Enable Dev mode options") and **Save (API Format)** → save as `ComfyUI/ideogram4_api.json`.
4. Open `ideogram4_api.json` and record the **node-id → class_type** map. The app needs to know which node id is:
   - the **positive text-encode** node (where the prompt string goes),
   - the **negative text-encode** node,
   - the **sampler** node (seed / steps / cfg),
   - the **model/checkpoint loader** node (the weights filename),
   - the **SaveImage** node (the output).
   (Node ids are arbitrary integers chosen by the editor — they must be read off this file, not assumed.)

If you can't run the UI (headless box): read the node `NODE_CLASS_MAPPINGS` (in the custom node's `__init__.py`) and any `*_api.json` example to assemble a minimal API graph by hand, then validate it with the smoke test below (a populated `node_errors` in the `/prompt` response tells you what's wrong).

---

## 8. End-to-end API smoke test (the proof)
Save this as `ComfyUI/comfy_smoke.py` and run it with ComfyUI **already running** (§6). It loads the API graph from §7, injects a dark-literary test prompt (this is the real use case — a violent/grim novel scene that hosted APIs would over-refuse, which a local model renders fine), submits it over HTTP, polls, and saves the PNG.

```python
import json, sys, time, urllib.request, urllib.parse, uuid, os

COMFY = "http://127.0.0.1:8188"
API_JSON = "ideogram4_api.json"
TEST_PROMPT = ("a lone battle-worn soldier in scuffed tactical armor, grim determined face, "
               "standing amid the smoke and ruins of a war-torn city at dusk, cinematic, "
               "dramatic rim light, painterly, highly detailed character portrait")

def post(path, obj):
    data = json.dumps(obj).encode()
    r = urllib.request.urlopen(urllib.request.Request(COMFY+path, data=data,
        headers={"Content-Type":"application/json"}))
    return json.load(r)

def get(path):
    return json.load(urllib.request.urlopen(COMFY+path))

g = json.load(open(API_JSON, encoding="utf-8"))

# Find nodes by class_type (substring match is robust to custom names).
def find(*subs):
    for nid, node in g.items():
        ct = (node.get("class_type") or "").lower()
        if any(s in ct for s in subs): yield nid, node

# positive text-encode: prefer a node whose text input isn't obviously a negative.
text_nodes = [(nid, n) for nid, n in g.items()
              if any(k in (n.get("inputs") or {}) for k in ("text","prompt"))]
print("text-ish nodes:", [(nid, g[nid]["class_type"]) for nid,_ in text_nodes])
# Inject the test prompt into EVERY text node that looks positive; set negatives empty.
for nid, n in text_nodes:
    ins = n["inputs"]
    key = "text" if "text" in ins else "prompt"
    cur = str(ins.get(key,""))
    if any(w in cur.lower() for w in ("worst","low quality","bad","blurry","negative")):
        ins[key] = ""                      # negative -> clear
    else:
        ins[key] = TEST_PROMPT             # positive -> test prompt

# randomize a seed if a sampler exposes one
for nid, n in g.items():
    if "seed" in (n.get("inputs") or {}):
        n["inputs"]["seed"] = int(uuid.uuid4().int % (10**15))

client_id = str(uuid.uuid4())
resp = post("/prompt", {"prompt": g, "client_id": client_id})
if not resp.get("prompt_id"):
    print("QUEUE REJECTED — node_errors:", json.dumps(resp.get("node_errors"), indent=2)); sys.exit(1)
pid = resp["prompt_id"]; print("queued", pid)

img = None; t0 = time.time()
while time.time()-t0 < 600:
    h = get("/history/"+pid)
    out = h.get(pid,{}).get("outputs")
    if out:
        for nid, o in out.items():
            if o.get("images"):
                img = o["images"][0]; break
    if img: break
    time.sleep(1.5)
if not img:
    print("TIMEOUT — no image produced"); sys.exit(1)

q = urllib.parse.urlencode({"filename":img["filename"],"subfolder":img.get("subfolder",""),"type":img.get("type","output")})
raw = urllib.request.urlopen(COMFY+"/view?"+q).read()
open("smoke_test.png","wb").write(raw)
print("SUCCESS -> %s/comfy %s  (%d bytes) in %.1fs" % (os.getcwd(), "smoke_test.png", len(raw), time.time()-t0))
```
Run it: `python comfy_smoke.py`. Success = `smoke_test.png` exists and is a valid image. If `QUEUE REJECTED`, read `node_errors` — usually a wrong weights filename (§4) or a missing custom node (§3).

---

## 9. Report back to the user
Print a final block with exactly these, so the phone app can be configured:
- **LAN URL** the app should use: `http://<PC-LAN-IP>:8188` (from §5)
- **Node-id map** (from §7): which node id is the **positive prompt**, **negative prompt**, **sampler (seed)**, **loader (ckpt filename)**, **SaveImage**.
- **Weights filenames** actually downloaded + their folders (§4).
- **Peak VRAM** used and headroom on the 24 GB card (§4).
- **Generation time** for the smoke test, and the chosen **sampler/steps/cfg**.
- The path to `smoke_test.png` so the user can eyeball quality.
- Anything that deviated from this doc (different filenames/nodes/folders you discovered) — so the app side can be matched to reality.

---

### Appendix — keeping it running
- Re-launch any time with the §6 command. Consider a startup script / Task Scheduler entry so it's up when the user wants to read.
- The app reaches it only when the PC + phone are on the **same Wi-Fi** and ComfyUI is running. If the phone can't connect, re-check: ComfyUI launched with `--listen 0.0.0.0`, firewall rule (§5), and that both devices are on the same subnet.
