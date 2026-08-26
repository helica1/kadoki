// WatchKaraoke.swift — cue lookup + karaoke text rendering + cues.json
// loading, shared between WatchPlayer/PlayerView (local playback) and
// LiveSessionModel/LiveView (Phase B: mirrors phone playback). Pulled out
// here rather than duplicated so both views compute cue position and
// word-fill identically.
import Foundation
import UIKit

enum WatchKaraoke {
    // Binary search: index of the cue containing (or last starting before) ms.
    static func cueIndex(atMs ms: Double, in cues: [WatchCue]) -> Int? {
        guard !cues.isEmpty else { return nil }
        var lo = 0, hi = cues.count - 1, best = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if cues[mid].s <= ms { best = mid; lo = mid + 1 } else { hi = mid - 1 }
        }
        return best >= 0 ? best : nil
    }

    // Word-by-word fill: read tokens in accent, the token being spoken in
    // bright white, upcoming text dimmed. Token spans/times come from the
    // transferred word timings (UTF-16 offsets, cue-relative ms).
    static func karaokeText(cue: WatchCue, relMs: Double) -> AttributedString {
        let ns = NSMutableAttributedString(string: cue.text)
        let full = NSRange(location: 0, length: ns.length)
        guard let w = cue.w, !w.isEmpty else {
            ns.addAttribute(.foregroundColor, value: UIColor.white, range: full)
            return AttributedString(ns)
        }
        let dim = UIColor.white.withAlphaComponent(0.38)
        let fill = UIColor(red: 0.72, green: 0.58, blue: 0.96, alpha: 1)
        let hot = UIColor.white
        ns.addAttribute(.foregroundColor, value: dim, range: full)
        var i = 0
        while i + 3 < w.count {
            let off = Int(w[i]), len = Int(w[i + 1])
            let ts = w[i + 2], te = w[i + 3]
            i += 4
            guard off >= 0, len > 0, off + len <= ns.length else { continue }
            let r = NSRange(location: off, length: len)
            if relMs >= te {
                ns.addAttribute(.foregroundColor, value: fill, range: r)
            } else if relMs >= ts {
                ns.addAttribute(.foregroundColor, value: hot, range: r)
            }
        }
        return AttributedString(ns)
    }

    // Parse a title's cues.json straight off disk (no WatchPlayer instance
    // needed) — used by LiveSessionModel for a title that may not be the one
    // currently loaded into local playback.
    static func loadCues(titleId: String) -> [WatchCue] {
        let url = WatchTitleStore.titleDir(titleId).appendingPathComponent("cues.json")
        guard let data = try? Data(contentsOf: url),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        var out: [WatchCue] = []
        out.reserveCapacity(arr.count)
        for o in arr {
            let s = (o["s"] as? Double) ?? Double((o["s"] as? Int) ?? -1)
            let e = (o["e"] as? Double) ?? Double((o["e"] as? Int) ?? -1)
            guard s >= 0, e >= s, let text = o["text"] as? String, !text.isEmpty else { continue }
            var w: [Double]? = nil
            if let raw = o["w"] as? [Any], !raw.isEmpty, raw.count % 4 == 0 {
                w = raw.compactMap { ($0 as? Double) ?? Double(($0 as? Int) ?? 0) }
            }
            out.append(WatchCue(s: s, e: e, text: text, w: w))
        }
        out.sort { $0.s < $1.s }
        return out
    }

    // Title display name from meta.json (falls back to the id).
    static func titleName(titleId: String) -> String {
        let url = WatchTitleStore.titleDir(titleId).appendingPathComponent("meta.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = obj["name"] as? String, !name.isEmpty else { return titleId }
        return name
    }
}
