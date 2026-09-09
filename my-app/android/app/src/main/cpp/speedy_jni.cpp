// JNI for the Speedy shim over Sonic (see ios/App/App/KadokiReadEngine.swift
// for the same pipeline on iOS). Public sonic* names come from soniclib.c
// (the Speedy shim); sonic.c itself is compiled -DSONIC_INTERNAL so its
// functions are the sonicInt* originals the shim calls.
#include <jni.h>
#include <android/log.h>
#include "sonic2.h"

#define TAG "SpeedyJNI"

extern "C" {

JNIEXPORT jlong JNICALL
Java_com_example_app_SpeedyNative_create(JNIEnv*, jclass, jint sampleRate, jint channels) {
    sonicStream st = sonicCreateStream(sampleRate, channels);
    if (!st) { __android_log_print(ANDROID_LOG_ERROR, TAG, "sonicCreateStream failed"); return 0; }
    sonicIntSetQuality(st, 0);
    return (jlong)(intptr_t)st;
}

JNIEXPORT void JNICALL
Java_com_example_app_SpeedyNative_destroy(JNIEnv*, jclass, jlong h) {
    if (h) sonicDestroyStream((sonicStream)(intptr_t)h);
}

JNIEXPORT void JNICALL
Java_com_example_app_SpeedyNative_setSpeed(JNIEnv*, jclass, jlong h, jfloat speed) {
    if (h) sonicSetSpeed((sonicStream)(intptr_t)h, speed);
}

JNIEXPORT void JNICALL
Java_com_example_app_SpeedyNative_setNonlinear(JNIEnv*, jclass, jlong h, jboolean on) {
    if (h) sonicEnableNonlinearSpeedup((sonicStream)(intptr_t)h, on ? 1.0f : 0.0f);
}

// frames = samples per channel; buffer is interleaved 16-bit PCM.
JNIEXPORT jint JNICALL
Java_com_example_app_SpeedyNative_writeShort(JNIEnv* env, jclass, jlong h, jshortArray arr, jint frames) {
    if (!h || !arr || frames <= 0) return 0;
    jshort* p = (jshort*)env->GetPrimitiveArrayCritical(arr, nullptr);
    if (!p) return 0;
    int r = sonicWriteShortToStream((sonicStream)(intptr_t)h, p, frames);
    env->ReleasePrimitiveArrayCritical(arr, p, JNI_ABORT);
    return r;
}

JNIEXPORT jint JNICALL
Java_com_example_app_SpeedyNative_readShort(JNIEnv* env, jclass, jlong h, jshortArray arr, jint maxFrames) {
    if (!h || !arr || maxFrames <= 0) return 0;
    jshort* p = (jshort*)env->GetPrimitiveArrayCritical(arr, nullptr);
    if (!p) return 0;
    int got = sonicReadShortFromStream((sonicStream)(intptr_t)h, p, maxFrames);
    env->ReleasePrimitiveArrayCritical(arr, p, 0);
    return got;
}

JNIEXPORT jint JNICALL
Java_com_example_app_SpeedyNative_available(JNIEnv*, jclass, jlong h) {
    return h ? sonicIntSamplesAvailable((sonicStream)(intptr_t)h) : 0;
}

JNIEXPORT void JNICALL
Java_com_example_app_SpeedyNative_flush(JNIEnv*, jclass, jlong h) {
    if (h) sonicFlushStream((sonicStream)(intptr_t)h);
}

} // extern "C"
