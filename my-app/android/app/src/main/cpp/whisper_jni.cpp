// whisper_jni.cpp — minimal JNI surface for com.example.app.WhisperEngine.
//
// One opaque handle wraps { whisper_context*, abort flag }. nFull() runs a
// blocking greedy transcription with token-level timestamps over a float PCM
// window (16 kHz mono); the Java side then walks segments/tokens through the
// granular getters and does UTF-8 token merging + cue segmentation itself.
// Times are whisper native units: centiseconds relative to the fed window.
#include <jni.h>
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

JNIEXPORT jlong JNICALL
Java_com_example_app_WhisperEngine_nTokT0(JNIEnv *, jclass, jlong h, jint i, jint j) {
    Ctx *c = ctxOf(h);
    return (c && c->w) ? whisper_full_get_token_data(c->w, i, j).t0 : 0;
}

JNIEXPORT jlong JNICALL
Java_com_example_app_WhisperEngine_nTokT1(JNIEnv *, jclass, jlong h, jint i, jint j) {
    Ctx *c = ctxOf(h);
    return (c && c->w) ? whisper_full_get_token_data(c->w, i, j).t1 : 0;
}

} // extern "C"
