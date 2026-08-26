// KadokiLockWidget.swift — Lock Screen quick-launch widget.
//
// Static shortcut only: shows the Kadoki glyph, tapping opens the app (the
// app itself resumes wherever you left off — no data needs to be shared with
// this extension). No App Group, no TimelineProvider refresh loop; content
// never changes so there's nothing to keep in sync. (If a live "now playing"
// version is wanted later, mirror KadokiWatchWidgets/KadokiWidgets.swift's
// App Group snapshot pattern — group.com.helica1.yama already exists.)
import WidgetKit
import SwiftUI

struct KadokiLockEntry: TimelineEntry {
    let date: Date
}

struct KadokiLockProvider: TimelineProvider {
    func placeholder(in context: Context) -> KadokiLockEntry { KadokiLockEntry(date: Date()) }

    func getSnapshot(in context: Context, completion: @escaping (KadokiLockEntry) -> Void) {
        completion(KadokiLockEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<KadokiLockEntry>) -> Void) {
        // One entry, never reloads — there is no live content to refresh.
        completion(Timeline(entries: [KadokiLockEntry(date: Date())], policy: .never))
    }
}

struct KadokiLockWidgetView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular:
                Image(systemName: "book.fill")
                    .font(.system(size: 22))

            case .accessoryRectangular:
                HStack(spacing: 6) {
                    Image(systemName: "book.fill")
                    Text("Kadoki")
                        .font(.headline)
                }

            case .accessoryInline:
                Label("Kadoki", systemImage: "book.fill")

            default:
                Text("Kadoki")
            }
        }
        .containerBackground(for: .widget) { Color.clear }
    }
}

struct KadokiLockWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "KadokiLaunch", provider: KadokiLockProvider()) { _ in
            KadokiLockWidgetView()
        }
        .configurationDisplayName("Kadoki")
        .description("One tap to open Kadoki.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

@main
struct KadokiLockWidgetBundle: WidgetBundle {
    var body: some Widget {
        KadokiLockWidget()
    }
}
