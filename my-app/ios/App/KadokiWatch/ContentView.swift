// ContentView.swift — the watch title list.
//
// Rows show name · resume position (fresher of local/phone) · duration · size.
// Toolbar: manual sync (exchanges positions with the phone when reachable).
// Swipe a row left to delete (List .onDelete).
import SwiftUI
import UIKit
import WatchKit

struct ContentView: View {
    @ObservedObject var store = WatchTitleStore.shared
    @ObservedObject var conn = WatchConnectivityManager.shared
    @State private var pendingDelete: WatchTitle?

    var body: some View {
        NavigationStack {
            Group {
                if store.titles.isEmpty {
                    VStack(spacing: 8) {
                        Text("Kadoki")
                            .font(.headline)
                        Text("Send a title from Kadoki on iPhone (title editor → Send to Apple Watch).")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        if !conn.lastEvent.isEmpty {
                            Text(conn.lastEvent)
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .padding()
                } else {
                    List {
                        ForEach(store.titles) { t in
                            NavigationLink(value: t.id) {
                                HStack(spacing: 8) {
                                    if let cu = t.coverURL, let img = UIImage(contentsOfFile: cu.path) {
                                        Image(uiImage: img)
                                            .resizable()
                                            .scaledToFill()
                                            .frame(width: 38, height: 38)
                                            .clipShape(RoundedRectangle(cornerRadius: 7))
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(t.name).font(.body).lineLimit(2)
                                        Text(resumeLine(t))
                                            .font(.footnote)
                                            .foregroundStyle(Color(red: 0.72, green: 0.58, blue: 0.96))
                                        Text(metaLine(t))
                                            .font(.footnote)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                        .onDelete { idx in
                            // Confirm before removing — a swipe-delete nukes a
                            // multi-hundred-MB transfer that took a long time.
                            if let i = idx.first, i < store.titles.count {
                                pendingDelete = store.titles[i]
                            }
                        }
                        if !conn.lastEvent.isEmpty {
                            Text(conn.lastEvent)
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                                .listRowBackground(Color.clear)
                        }
                    }
                }
            }
            .navigationTitle("Kadoki")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        WatchConnectivityManager.shared.manualSync()
                        WKInterfaceDevice.current().play(.click)
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                }
            }
            .confirmationDialog(
                "Delete \"\(pendingDelete?.name ?? "")\" from the watch? Re-sending the audio takes a long time.",
                isPresented: Binding(get: { pendingDelete != nil },
                                     set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let t = pendingDelete { store.delete(t) }
                    pendingDelete = nil
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            }
            .navigationDestination(for: String.self) { id in
                if let t = store.titles.first(where: { $0.id == id }) {
                    PlayerView(title: t)
                }
            }
        }
        .onAppear { store.reload() }
    }

    // Resume spot: fresher of the local checkpoint and the phone-sent position
    // (the same rule the player's adoption uses), plus percent through.
    private func resumeLine(_ t: WatchTitle) -> String {
        let d = UserDefaults.standard
        let localPos = d.double(forKey: "pos_" + t.id)
        let localTs = d.double(forKey: "posTs_" + t.id)
        let phonePos = d.double(forKey: "phonePos_" + t.id)
        let phoneTs = d.double(forKey: "phonePosTs_" + t.id)
        var sec = localPos
        if phonePos > 0, phoneTs > localTs { sec = phonePos }
        guard sec > 0 else { return "at start" }
        var out = "at " + clock(sec)
        if t.durMs > 0 {
            out += " · " + String(Int((sec * 1000 / t.durMs * 100).rounded())) + "%"
        }
        return out
    }

    private func metaLine(_ t: WatchTitle) -> String {
        var bits: [String] = []
        if t.durMs > 0 {
            let m = Int(t.durMs / 60000)
            bits.append(m >= 60 ? "\(m / 60)h \(m % 60)m" : "\(m)m")
        }
        if t.sizeBytes > 0 {
            bits.append(String(format: "%.0f MB", Double(t.sizeBytes) / 1_048_576))
        }
        if t.audioURL == nil { bits.append("transferring…") }
        return bits.joined(separator: " · ")
    }

    private func clock(_ sec: Double) -> String {
        let t = Int(max(0, sec))
        let h = t / 3600, m = (t % 3600) / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
