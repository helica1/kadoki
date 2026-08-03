// KadokiWidgets.swift — watch-face complications for Kadoki.
//
// Families: circular (progress ring), corner (percent + title label),
// rectangular (title · position · progress bar), inline (one line).
// Data comes from the App Group snapshot the watch app writes on every
// pause/load/checkpoint (group.com.helica1.yama: wTitle/wPos/wDur/wUpdated).
// Tapping any complication launches the Kadoki watch app.
import WidgetKit
import SwiftUI

private let APP_GROUP = "group.com.helica1.yama"

struct KadokiEntry: TimelineEntry {
    let date: Date
    let title: String
    let posSec: Double
    let durSec: Double

    var pct: Double { durSec > 0 ? min(1, max(0, posSec / durSec)) : 0 }

    static func current() -> KadokiEntry {
        let g = UserDefaults(suiteName: APP_GROUP)
        return KadokiEntry(
            date: Date(),
            title: g?.string(forKey: "wTitle") ?? "",
            posSec: g?.double(forKey: "wPos") ?? 0,
            durSec: g?.double(forKey: "wDur") ?? 0
        )
    }

    static let placeholder = KadokiEntry(date: Date(), title: "Kadoki", posSec: 5400, durSec: 33000)
}

struct KadokiProvider: TimelineProvider {
    func placeholder(in context: Context) -> KadokiEntry { .placeholder }

    func getSnapshot(in context: Context, completion: @escaping (KadokiEntry) -> Void) {
        completion(context.isPreview ? .placeholder : .current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<KadokiEntry>) -> Void) {
        // Single entry; the app explicitly reloads on pause/load, and we ask
        // for a periodic refresh as a fallback.
        completion(Timeline(entries: [.current()],
                            policy: .after(Date().addingTimeInterval(15 * 60))))
    }
}

struct KadokiWidgetView: View {
    let entry: KadokiEntry
    @Environment(\.widgetFamily) private var family

    private let accent = Color(red: 0.72, green: 0.58, blue: 0.96)

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                Gauge(value: entry.pct) {
                    Text("語")
                        .font(.system(size: 12, weight: .bold))
                } currentValueLabel: {
                    Text("\(Int((entry.pct * 100).rounded()))")
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                }
                .gaugeStyle(.accessoryCircular)
                .tint(accent)

            case .accessoryCorner:
                Text("\(Int((entry.pct * 100).rounded()))%")
                    .font(.system(size: 15, weight: .bold, design: .rounded))
                    .foregroundStyle(accent)
                    .widgetLabel {
                        Text(entry.title.isEmpty ? "Kadoki" : entry.title)
                    }

            case .accessoryRectangular:
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.title.isEmpty ? "Kadoki" : entry.title)
                        .font(.headline)
                        .lineLimit(1)
                    Text(clock(entry.posSec) + (entry.durSec > 0 ? " · \(Int((entry.pct * 100).rounded()))%" : ""))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ProgressView(value: entry.pct)
                        .tint(accent)
                }

            case .accessoryInline:
                Text(entry.title.isEmpty ? "Kadoki" : "\(entry.title) · \(clock(entry.posSec))")

            default:
                Text("Kadoki")
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }

    private func clock(_ sec: Double) -> String {
        let t = Int(max(0, sec))
        let h = t / 3600, m = (t % 3600) / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

struct KadokiWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KadokiProgress", provider: KadokiProvider()) { entry in
            KadokiWidgetView(entry: entry)
        }
        .configurationDisplayName("Kadoki")
        .description("Current audiobook and progress.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
    }
}

@main
struct KadokiWidgetBundle: WidgetBundle {
    var body: some Widget {
        KadokiWidget()
    }
}
