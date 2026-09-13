package com.example.app;

/** JNI surface for the Speedy/Sonic stream (speedy_jni.cpp). */
final class SpeedyNative {
    private static boolean loaded = false;
    static synchronized boolean load() {
        if (loaded) return true;
        try { System.loadLibrary("speedyjni"); loaded = true; }
        catch (Throwable t) { android.util.Log.e("SpeedyNative", "load failed", t); }
        return loaded;
    }
    static native long create(int sampleRate, int channels);
    static native void destroy(long h);
    static native void setSpeed(long h, float speed);
    static native void setNonlinear(long h, boolean on);
    static native void setPitch(long h, float pitch);            // Sonic pitch shift (1 = unchanged)
    static native int writeFloat(long h, float[] interleaved, int frames);
    static native int readFloat(long h, float[] out, int maxFrames);
    static native int writeShort(long h, short[] interleaved, int frames);
    static native int readShort(long h, short[] out, int maxFrames);
    static native int available(long h);
    static native void flush(long h);
}
