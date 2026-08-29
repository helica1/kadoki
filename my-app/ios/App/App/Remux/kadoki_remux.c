// Lossless mkv → mp4 remux: copies the H.264/H.265 video and AAC/AC3/etc.
// audio bitstreams into an MP4 container AVFoundation can open. No decoding,
// no quality change — disk-speed. Subtitle/attachment tracks are skipped
// (Kadoki uses external SRTs).
//
// DTS SYNTHESIS: Matroska stores presentation timestamps only; packets arrive
// in decode order with dts = AV_NOPTS_VALUE, and the mp4 muxer refuses that.
// For video we run a reorder buffer of depth D: hold D packets, and when one
// leaves the buffer its dts = the smallest pts still in the buffer (the
// classic pts→dts assignment; exact whenever D ≥ the stream's true reorder
// depth). Guards clamp dts ≤ its own pts and keep dts strictly monotonic, so
// even a pathological stream still muxes. Audio has no reordering: dts = pts.
#include "kadoki_remux.h"
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <string.h>

#define REORDER_DEPTH 6

static void set_err(char *errbuf, int errlen, const char *msg, int averr) {
    if (!errbuf || errlen <= 0) return;
    if (averr) {
        char av[128] = {0};
        av_strerror(averr, av, sizeof(av));
        snprintf(errbuf, errlen, "%s (%s)", msg, av);
    } else {
        snprintf(errbuf, errlen, "%s", msg);
    }
}

// Per-output-stream muxing state.
typedef struct {
    int is_video;
    AVStream *ist, *ost;
    // video reorder buffer
    AVPacket *q[REORDER_DEPTH + 1];
    int64_t pts_pool[REORDER_DEPTH + 1];   // multiset of pts currently buffered
    int qn;
    int64_t last_dts;                       // in OUTPUT timebase
    int has_last;
} StreamCtx;

static int64_t pool_pop_min(StreamCtx *s) {
    int mi = 0;
    for (int i = 1; i < s->qn; i++) if (s->pts_pool[i] < s->pts_pool[mi]) mi = i;
    int64_t v = s->pts_pool[mi];
    s->pts_pool[mi] = s->pts_pool[s->qn - 1];
    return v;
}

static int write_one(AVFormatContext *out, StreamCtx *s, AVPacket *pkt,
                     char *errbuf, int errlen) {
    // rescale into the muxer's timebase, then clamp
    av_packet_rescale_ts(pkt, s->ist->time_base, s->ost->time_base);
    if (pkt->dts == AV_NOPTS_VALUE)
        pkt->dts = (pkt->pts != AV_NOPTS_VALUE) ? pkt->pts
                 : (s->has_last ? s->last_dts + 1 : 0);
    if (pkt->pts != AV_NOPTS_VALUE && pkt->dts > pkt->pts) pkt->dts = pkt->pts;
    if (s->has_last && pkt->dts <= s->last_dts) pkt->dts = s->last_dts + 1;
    if (pkt->pts != AV_NOPTS_VALUE && pkt->pts < pkt->dts) pkt->pts = pkt->dts;
    s->last_dts = pkt->dts; s->has_last = 1;
    pkt->stream_index = s->ost->index;
    pkt->pos = -1;
    int ret = av_interleaved_write_frame(out, pkt);
    if (ret < 0) set_err(errbuf, errlen, "write failed", ret);
    return ret;
}

// Push a video packet through the reorder buffer; emits 0 or 1 packet.
static int push_video(AVFormatContext *out, StreamCtx *s, AVPacket *pkt,
                      char *errbuf, int errlen) {
    // dts already known (some sources have it) → bypass the buffer only if
    // the buffer is empty, to keep output ordering intact.
    if (pkt->dts != AV_NOPTS_VALUE && s->qn == 0)
        return write_one(out, s, pkt, errbuf, errlen);
    AVPacket *own = av_packet_alloc();
    av_packet_move_ref(own, pkt);
    s->q[s->qn] = own;
    s->pts_pool[s->qn] = (own->pts != AV_NOPTS_VALUE) ? own->pts : 0;
    s->qn++;
    if (s->qn <= REORDER_DEPTH) return 0;
    // pop the oldest packet; its dts = min pts in the buffer (input timebase)
    AVPacket *head = s->q[0];
    memmove(&s->q[0], &s->q[1], sizeof(s->q[0]) * (s->qn - 1));
    int64_t dts = pool_pop_min(s);
    s->qn--;
    head->dts = dts;
    int ret = write_one(out, s, head, errbuf, errlen);
    av_packet_free(&head);
    return ret;
}

static int flush_video(AVFormatContext *out, StreamCtx *s, char *errbuf, int errlen) {
    int ret = 0;
    while (s->qn > 0 && ret >= 0) {
        AVPacket *head = s->q[0];
        memmove(&s->q[0], &s->q[1], sizeof(s->q[0]) * (s->qn - 1));
        int64_t dts = pool_pop_min(s);
        s->qn--;
        head->dts = dts;
        ret = write_one(out, s, head, errbuf, errlen);
        av_packet_free(&head);
    }
    return ret;
}

int kadoki_remux(const char *src, const char *dst,
                 char *errbuf, int errlen,
                 kadoki_remux_progress cb, void *opaque) {
    AVFormatContext *in = NULL, *out = NULL;
    StreamCtx *sc = NULL;
    int *map = NULL;
    AVPacket *pkt = NULL;
    int ret = 0, i;
    av_log_set_level(AV_LOG_ERROR);

    if ((ret = avformat_open_input(&in, src, NULL, NULL)) < 0) {
        set_err(errbuf, errlen, "cannot open source", ret); goto fail;
    }
    if ((ret = avformat_find_stream_info(in, NULL)) < 0) {
        set_err(errbuf, errlen, "cannot read streams", ret); goto fail;
    }
    if ((ret = avformat_alloc_output_context2(&out, NULL, "mp4", dst)) < 0 || !out) {
        set_err(errbuf, errlen, "cannot create mp4", ret ? ret : AVERROR_UNKNOWN); goto fail;
    }
    // Allow FLAC/Opus-in-mp4 (standardized; ffmpeg still gates them).
    out->strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL;

    map = av_calloc(in->nb_streams, sizeof(int));
    sc = av_calloc(in->nb_streams, sizeof(StreamCtx));
    int out_idx = 0, have_video = 0;
    for (i = 0; i < (int)in->nb_streams; i++) {
        AVStream *is = in->streams[i];
        enum AVMediaType t = is->codecpar->codec_type;
        map[i] = -1;
        if (t != AVMEDIA_TYPE_VIDEO && t != AVMEDIA_TYPE_AUDIO) continue;
        // Cover-art "video" (attached pics) would become a broken track.
        if (is->disposition & AV_DISPOSITION_ATTACHED_PIC) continue;
        AVStream *os = avformat_new_stream(out, NULL);
        if (!os) { set_err(errbuf, errlen, "alloc stream failed", 0); ret = AVERROR(ENOMEM); goto fail; }
        if ((ret = avcodec_parameters_copy(os->codecpar, is->codecpar)) < 0) {
            set_err(errbuf, errlen, "copy codec params failed", ret); goto fail;
        }
        os->codecpar->codec_tag = 0;   // let the muxer pick the mp4 tag
        // Apple players refuse 'hev1' (the muxer's default HEVC sample entry);
        // 'hvc1' with the parameter sets in hvcC (Matroska CodecPrivate has
        // them) is the form AVFoundation plays.
        if (os->codecpar->codec_id == AV_CODEC_ID_HEVC)
            os->codecpar->codec_tag = MKTAG('h','v','c','1');
        os->time_base = is->time_base;
        StreamCtx *s = &sc[i];
        s->is_video = (t == AVMEDIA_TYPE_VIDEO);
        s->ist = is; s->ost = os; s->has_last = 0; s->qn = 0;
        if (s->is_video) have_video = 1;
        map[i] = out_idx++;
    }
    if (!have_video) { set_err(errbuf, errlen, "no video track found", 0); ret = -1; goto fail; }

    if (!(out->oformat->flags & AVFMT_NOFILE)) {
        if ((ret = avio_open(&out->pb, dst, AVIO_FLAG_WRITE)) < 0) {
            set_err(errbuf, errlen, "cannot write destination", ret); goto fail;
        }
    }
    if ((ret = avformat_write_header(out, NULL)) < 0) {
        // The classic failure: a codec mp4 can't carry (e.g. DTS audio).
        set_err(errbuf, errlen, "mp4 cannot carry a track (codec unsupported)", ret); goto fail;
    }

    double totalSec = (in->duration > 0) ? (double)in->duration / AV_TIME_BASE : 0;
    pkt = av_packet_alloc();
    double lastCb = -1;
    while (av_read_frame(in, pkt) >= 0) {
        if (pkt->stream_index >= (int)in->nb_streams || map[pkt->stream_index] < 0) {
            av_packet_unref(pkt); continue;
        }
        StreamCtx *s = &sc[pkt->stream_index];
        if (cb && pkt->pts != AV_NOPTS_VALUE && s->is_video) {
            double sec = pkt->pts * av_q2d(s->ist->time_base);
            if (sec - lastCb >= 2.0) { cb(opaque, sec, totalSec); lastCb = sec; }
        }
        if (s->is_video) ret = push_video(out, s, pkt, errbuf, errlen);
        else {
            if (pkt->dts == AV_NOPTS_VALUE) pkt->dts = pkt->pts;   // audio: no reorder
            ret = write_one(out, s, pkt, errbuf, errlen);
        }
        av_packet_unref(pkt);
        if (ret < 0) goto fail;
    }
    for (i = 0; i < (int)in->nb_streams; i++) {
        if (map[i] >= 0 && sc[i].is_video) {
            if ((ret = flush_video(out, &sc[i], errbuf, errlen)) < 0) goto fail;
        }
    }
    if ((ret = av_write_trailer(out)) < 0) { set_err(errbuf, errlen, "finalize failed", ret); goto fail; }
    ret = 0;
fail:
    if (pkt) av_packet_free(&pkt);
    if (sc) { for (i = 0; i < (int)(in ? in->nb_streams : 0); i++) for (int j = 0; j < sc[i].qn; j++) av_packet_free(&sc[i].q[j]); }
    av_freep(&sc);
    av_freep(&map);
    if (in) avformat_close_input(&in);
    if (out) {
        if (!(out->oformat->flags & AVFMT_NOFILE) && out->pb) avio_closep(&out->pb);
        avformat_free_context(out);
    }
    return ret == 0 ? 0 : (ret < 0 ? ret : -1);
}
