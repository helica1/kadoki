// Kadoki mkv → mp4 remuxer (lossless stream copy via libavformat).
// Returns 0 on success; nonzero on failure with a reason in errbuf.
// Progress: cb(opaque, done_seconds, total_seconds) — cb may be NULL.
#ifndef KADOKI_REMUX_H
#define KADOKI_REMUX_H
#ifdef __cplusplus
extern "C" {
#endif
typedef void (*kadoki_remux_progress)(void *opaque, double doneSec, double totalSec);
int kadoki_remux(const char *src, const char *dst,
                 char *errbuf, int errlen,
                 kadoki_remux_progress cb, void *opaque);
#ifdef __cplusplus
}
#endif
#endif
