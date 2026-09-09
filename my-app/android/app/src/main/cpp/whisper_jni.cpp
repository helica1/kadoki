// whisper_jni.cpp — minimal JNI surface for com.example.app.WhisperEngine.
//
// One opaque handle wraps { whisper_context*, abort flag }. nFull() runs a
// blocking greedy transcription with token-level timestamps over a float PCM
// window (16 kHz mono); the Java side then walks segments/tokens through the
// granular getters and does UTF-8 token merging + cue segmentation itself.
// Times are whisper native units: centiseconds relative to the fed window.
#include <jni.h>
#include <string>
#include <cctype>
#include <android/log.h>
#include <atomic>
#include <cstdint>
#include <cstring>

#include "whisper.h"

#define LOG_TAG "whisperjni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

struct Ctx {
    whisper_context *w = nullptr;
    std::atomic<bool> abortFlag{false};
};

inline Ctx *ctxOf(jlong h) { return reinterpret_cast<Ctx *>(static_cast<intptr_t>(h)); }

bool abort_cb(void *ud) {
    return static_cast<std::atomic<bool> *>(ud)->load(std::memory_order_relaxed);
}

} // namespace

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_example_app_WhisperEngine_nInit(JNIEnv *env, jclass, jstring modelPath) {
    const char *path = env->GetStringUTFChars(modelPath, nullptr);
    if (!path) return 0;
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = false;
    // DTW token timestamps: alignment-head cross-attention → dynamic time
    // warping, much tighter than the default (decoder-probability heuristic)
    // token times. The aheads preset must match the model architecture —
    // pick it from the file name; unknown names keep the heuristic.
    {
        std::string name(path);
        for (auto &ch : name) ch = (char)tolower((unsigned char)ch);
        whisper_alignment_heads_preset preset = WHISPER_AHEADS_NONE;
        if (name.find("large-v3-turbo") != std::string::npos) preset = WHISPER_AHEADS_LARGE_V3_TURBO;
        else if (name.find("large-v3") != std::string::npos) preset = WHISPER_AHEADS_LARGE_V3;
        else if (name.find("large-v2") != std::string::npos) preset = WHISPER_AHEADS_LARGE_V2;
        else if (name.find("large-v1") != std::string::npos) preset = WHISPER_AHEADS_LARGE_V1;
        else if (name.find("medium.en") != std::string::npos) preset = WHISPER_AHEADS_MEDIUM_EN;
        else if (name.find("medium") != std::string::npos) preset = WHISPER_AHEADS_MEDIUM;
        else if (name.find("small.en") != std::string::npos) preset = WHISPER_AHEADS_SMALL_EN;
        else if (name.find("small") != std::string::npos) preset = WHISPER_AHEADS_SMALL;
        else if (name.find("base.en") != std::string::npos) preset = WHISPER_AHEADS_BASE_EN;
        else if (name.find("base") != std::string::npos) preset = WHISPER_AHEADS_BASE;
        else if (name.find("tiny.en") != std::string::npos) preset = WHISPER_AHEADS_TINY_EN;
        else if (name.find("tiny") != std::string::npos) preset = WHISPER_AHEADS_TINY;
        if (preset != WHISPER_AHEADS_NONE) {
            cp.dtw_token_timestamps = true;
            cp.dtw_aheads_preset = preset;
            LOGI("DTW token timestamps enabled (preset %d)", (int)preset);
        }
    }
    whisper_context *w = whisper_init_from_file_with_params(path, cp);
    env->ReleaseStringUTFChars(modelPath, path);
    if (!w) {
        LOGE("whisper_init failed");
        return 0;
    }
    Ctx *c = new Ctx();
    c->w = w;
    return static_cast<jlong>(reinterpret_cast<intptr_t>(c));
}

JNIEXPORT void JNICALL
Java_com_example_app_WhisperEngine_nFree(JNIEnv *, jclass, jlong h) {
    Ctx *c = ctxOf(h);
    if (!c) return;
    if (c->w) whisper_free(c->w);
    delete c;
}

JNIEXPORT void JNICALL
Java_com_example_app_WhisperEngine_nAbort(JNIEnv *, jclass, jlong h) {
    Ctx *c = ctxOf(h);
    if (c) c->abortFlag.store(true, std::memory_order_relaxed);
}

JNIEXPORT jint JNICALL
Java_com_example_app_WhisperEngine_nFull(JNIEnv *env, jclass, jlong h,
                                         jfloatArray pcm, jint nThreads) {
    Ctx *c = ctxOf(h);
    if (!c || !c->w) return -1;
    c->abortFlag.store(false, std::memory_order_relaxed);

    jsize n = env->GetArrayLength(pcm);
    if (n <= 0) return -2;
    jfloat *data = env->GetFloatArrayElements(pcm, nullptr);
    if (!data) return -3;

    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.language = "ja";
    p.translate = false;
    p.n_threads = nThreads > 0 ? nThreads : 4;
    p.no_context = true;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_special = false;
    p.print_timestamps = false;
    p.token_timestamps = true;
    p.suppress_blank = true;
    p.suppress_nst = true;
    p.abort_callback = abort_cb;
    p.abort_callback_user_data = &c->abortFlag;

    int ret = whisper_full(c->w, p, data, static_cast<int>(n));
    env->ReleaseFloatArrayElements(pcm, data, JNI_ABORT);
    if (c->abortFlag.load(std::memory_order_relaxed)) return -100; // aborted
    return ret; // 0 = ok
}

JNIEXPORT jint JNICALL
Java_com_example_app_WhisperEngine_nSegCount(JNIEnv *, jclass, jlong h) {
    Ctx *c = ctxOf(h);
    return (c && c->w) ? whisper_full_n_segments(c->w) : 0;
}

JNIEXPORT jlong JNICALL
Java_com_example_app_WhisperEngine_nSegT0(JNIEnv *, jclass, jlong h, jint i) {
    Ctx *c = ctxOf(h);
    return (c && c->w) ? whisper_full_get_segment_t0(c->w, i) : 0;
}

JNIEXPORT jlong JNICALL
Java_com_example_app_WhisperEngine_nSegT1(JNIEnv *, jclass, jlong h, jint i) {
    Ctx *c = ctxOf(h);
    return (c && c->w) ? whisper_full_get_segment_t1(c->w, i) : 0;
}

JNIEXPORT jint JNICALL
Java_com_example_app_WhisperEngine_nTokCount(JNIEnv *, jclass, jlong h, jint i) {
    Ctx *c = ctxOf(h);
    return (c && c->w) ? whisper_full_n_tokens(c->w, i) : 0;
}

// Token text bytes, or null for special tokens (id >= eot: [_BEG_], timestamps…).
JNIEXPORT jbyteArray JNICALL
Java_com_example_app_WhisperEngine_nTokBytes(JNIEnv *env, jclass, jlong h, jint i, jint j) {
    Ctx *c = ctxOf(h);
    if (!c || !c->w) return nullptr;
    whisper_token_data d = whisper_full_get_token_data(c->w, i, j);
    if (d.id >= whisper_token_eot(c->w)) return nullptr;
    const char *txt = whisper_full_get_token_text(c->w, i, j);
    if (!txt) return nullptr;
    jsize len = static_cast<jsize>(strlen(txt));
    jbyteArray out = env->NewByteArray(len);
    if (out && len > 0) env->SetByteArrayRegion(out, 0, len, reinterpret_cast<const jbyte *>(txt));
    return out;
}

// Token times: DTW (t_dtw = the token's aligned time, -1 when unavailable)
// wins over the heuristic t0/t1. A token spans from its own DTW time to the
// next token's DTW time (or the heuristic end for the last one).
JNIEXPORT jlong JNICALL
Java_com_example_app_WhisperEngine_nTokT0(JNIEnv *, jclass, jlong h, jint i, jint j) {
    Ctx *c = ctxOf(h);
    if (!c || !c->w) return 0;
    whisper_token_data d = whisper_full_get_token_data(c->w, i, j);
    return d.t_dtw >= 0 ? d.t_dtw : d.t0;
}

JNIEXPORT jlong JNICALL
Java_com_example_app_WhisperEngine_nTokT1(JNIEnv *, jclass, jlong h, jint i, jint j) {
    Ctx *c = ctxOf(h);
    if (!c || !c->w) return 0;
    whisper_token_data d = whisper_full_get_token_data(c->w, i, j);
    int n = whisper_full_n_tokens(c->w, i);
    for (int k = j + 1; k < n; k++) {
        whisper_token_data nx = whisper_full_get_token_data(c->w, i, k);
        if (nx.id >= whisper_token_eot(c->w)) continue;   // skip special/timestamp tokens
        if (nx.t_dtw >= 0) return (d.t_dtw >= 0 && nx.t_dtw < d.t_dtw) ? d.t1 : nx.t_dtw;
        break;
    }
    if (d.t_dtw >= 0) return (d.t1 > d.t_dtw) ? d.t1 : d.t_dtw + 5;   // last token: heuristic end (≥ 50 ms)
    return d.t1;
}

} // extern "C"
