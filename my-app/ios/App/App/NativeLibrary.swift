import SwiftUI
import UIKit
import WebKit

#if os(iOS)
/// Native iOS Library. native-library.js lists the titles with the web
/// library's own folder / filter / sort / series logic and runs every action
/// with the web library's own function (opening a title is the web
/// loadTitleFromLibrary path). Web sheets (Edit, Move, Stats, New title…)
/// cover the screen; this layer steps aside while they are up.
/// iOS 16+ (older systems keep the web library).
@available(iOS 16.0, *)
final class KadokiNativeLibrary: NSObject, WKScriptMessageHandler {
    private weak var hostVC: UIViewController?
    private let overlay = KadokiOverlay<LibraryRootView>()
    private let store = LibraryStore()

    static func userScript() -> WKUserScript {
        WKUserScript(source: "window.KADOKI_NATIVE_LIBRARY=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func install(in vc: UIViewController, webView: WKWebView) {
        hostVC = vc
        store.webView = webView
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: "kadokiNativeLibrary")
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let type = d["type"] as? String else { return }
        switch type {
        case "open":
            if let json = d["model"] as? String { store.load(json) }
            if let vc = hostVC { overlay.show(LibraryRootView(store: store), in: vc) }
        case "closed":
            overlay.hide()
        case "cover":
            let on = (d["on"] as? Bool) ?? false
            overlay.setCovered(on)
            if !on { store.refresh() }
        default:
            break
        }
    }
}

// MARK: - Model

struct LibKind: Hashable { let label: String; let color: String }

struct LibTitle: Identifiable, Hashable {
    let id: String
    let name: String
    let author: String
    let cover: UIImage?
    let kinds: [LibKind]
    let progress: Int
    let opened: String
    let meta: String
    let pinned: Bool
    let want: Bool
    let readingBook: Bool
    let canReadingBook: Bool
    let cloud: Bool
    let summary: [String]
    let tags: [String]
    let canSummarize: Bool

    static func == (a: LibTitle, b: LibTitle) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

struct LibGroup: Identifiable {
    let id: Int
    let series: String
    let titles: [LibTitle]
}

struct LibFolder: Identifiable { var id: String { name }; let name: String; let count: Int }
struct LibChoice: Hashable { let v: String; let l: String }

@available(iOS 16.0, *)
final class LibraryStore: ObservableObject {
    weak var webView: WKWebView?
    @Published var folder = ""
    @Published var folders: [LibFolder] = []
    @Published var pinned: [LibTitle] = []
    @Published var groups: [LibGroup] = []
    @Published var empty = ""
    @Published var view = "list"
    @Published var filter = "all"
    @Published var sort = "recent"
    @Published var filters: [LibChoice] = []
    @Published var sorts: [LibChoice] = []
    @Published var blurbLang = "ja"
    @Published var s: [String: String] = [:]

    private var images: [String: UIImage] = [:]

    func str(_ k: String, _ d: String) -> String { s[k].flatMap { $0.isEmpty ? nil : $0 } ?? d }

    private func image(_ uri: String) -> UIImage? {
        guard !uri.isEmpty else { return nil }
        let key = String(uri.suffix(64)) + "\(uri.count)"
        if let i = images[key] { return i }
        guard let comma = uri.firstIndex(of: ","), let data = Data(base64Encoded: String(uri[uri.index(after: comma)...])),
              let img = UIImage(data: data) else { return nil }
        images[key] = img
        return img
    }

    private func title(_ d: [String: Any]) -> LibTitle {
        LibTitle(id: d["id"] as? String ?? "", name: d["name"] as? String ?? "", author: d["author"] as? String ?? "",
                 cover: image(d["cover"] as? String ?? ""),
                 kinds: ((d["kinds"] as? [[String: Any]]) ?? []).map { LibKind(label: $0["l"] as? String ?? "", color: $0["c"] as? String ?? "") },
                 progress: d["progress"] as? Int ?? -1, opened: d["opened"] as? String ?? "",
                 meta: d["meta"] as? String ?? "", pinned: d["pinned"] as? Bool ?? false,
                 want: d["want"] as? Bool ?? false, readingBook: d["readingBook"] as? Bool ?? false,
                 canReadingBook: d["canReadingBook"] as? Bool ?? false, cloud: d["cloud"] as? Bool ?? false,
                 summary: d["summary"] as? [String] ?? [], tags: d["tags"] as? [String] ?? [],
                 canSummarize: d["canSummarize"] as? Bool ?? false)
    }

    func load(_ json: String) {
        guard let data = json.data(using: .utf8),
              let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        folder = d["folder"] as? String ?? ""
        folders = ((d["folders"] as? [[String: Any]]) ?? []).map { LibFolder(name: $0["name"] as? String ?? "", count: $0["count"] as? Int ?? 0) }
        pinned = ((d["pinned"] as? [[String: Any]]) ?? []).map(title)
        groups = ((d["groups"] as? [[String: Any]]) ?? []).enumerated().map { i, g in
            LibGroup(id: i, series: g["series"] as? String ?? "", titles: ((g["titles"] as? [[String: Any]]) ?? []).map(title))
        }
        empty = d["empty"] as? String ?? ""
        view = d["view"] as? String ?? "list"
        filter = d["filter"] as? String ?? "all"
        sort = d["sort"] as? String ?? "recent"
        let choices = { (k: String) in ((d[k] as? [[String: Any]]) ?? []).map { LibChoice(v: $0["v"] as? String ?? "", l: $0["l"] as? String ?? "") } }
        filters = choices("filters")
        sorts = choices("sorts")
        blurbLang = d["blurbLang"] as? String ?? "ja"
        s = d["strings"] as? [String: String] ?? [:]
    }

    func refresh() {
        webView?.callAsyncJavaScript("return await window.__kadokiLibDescribe()", arguments: [:], in: nil, in: .page) { [weak self] r in
            if case .success(let v) = r, let json = v as? String { self?.load(json) }
        }
    }

    func act(_ action: String, _ id: String = "", _ arg: String = "") {
        webView?.callAsyncJavaScript("return await window.__kadokiLibAction(a, id, arg)",
                                     arguments: ["a": action, "id": id, "arg": arg], in: nil, in: .page) { [weak self] r in
            if case .success(let v) = r, let json = v as? String, !json.isEmpty { self?.load(json) }
        }
    }

    func close() { webView?.evaluateJavaScript("window.__kadokiLibClose()", completionHandler: nil) }

    var allTitles: [LibTitle] { groups.flatMap { $0.titles } }

    /// What to draw: runs of standalone titles share one grid / list; each
    /// series is its own block under its name.
    func blocks(_ keep: (LibTitle) -> Bool) -> [LibGroup] {
        var out: [LibGroup] = []
        var run: [LibTitle] = []
        func flush() { if !run.isEmpty { out.append(LibGroup(id: out.count, series: "", titles: run)); run = [] } }
        for g in groups {
            let t = g.titles.filter(keep)
            if g.series.isEmpty { run += t; continue }
            flush()
            if !t.isEmpty { out.append(LibGroup(id: out.count, series: g.series, titles: t)) }
        }
        flush()
        return out
    }
}

// MARK: - Views

@available(iOS 16.0, *)
struct LibraryRootView: View {
    @ObservedObject var store: LibraryStore
    @State private var query = ""
    @State private var path: [LibTitle] = []

    private func matches(_ t: LibTitle) -> Bool {
        query.isEmpty || t.name.localizedCaseInsensitiveContains(query) || t.author.localizedCaseInsensitiveContains(query)
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if store.view == "gallery" { gallery } else { list }
            }
            .searchable(text: $query)
            .navigationTitle(store.folder.isEmpty ? store.str("library", "Library") : store.folder)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: LibTitle.self) { t in TitleDetail(store: store, id: t.id) }
            .toolbar { toolbar }
        }
        .preferredColorScheme(.dark)
    }

    /// List: native rows with the old swipe actions (left: Delete / Edit /
    /// Stats, right: Pin), plus the long-press menu.
    private var list: some View {
        List {
            if query.isEmpty && !store.pinned.isEmpty {
                Section { PinnedRow(store: store).listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0)) }
            }
            if query.isEmpty && !store.folders.isEmpty {
                Section { ForEach(store.folders) { f in FolderRow(store: store, f: f) } }
            }
            ForEach(store.blocks(matches)) { g in
                Section {
                    ForEach(g.titles) { t in
                        TitleRow(store: store, t: t) { path.append(t) }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) { store.act("delete", t.id) } label: { Label(store.str("del", "Delete"), systemImage: "trash") }
                                Button { store.act("edit", t.id) } label: { Label(store.str("edit", "Edit"), systemImage: "pencil") }.tint(.blue)
                                Button { store.act("stats", t.id) } label: { Label(store.str("stats", "Stats"), systemImage: "chart.bar") }.tint(.indigo)
                            }
                            .swipeActions(edge: .leading) {
                                Button { store.act("pin", t.id) } label: {
                                    Label(t.pinned ? store.str("unpin", "Unpin") : store.str("pin", "Pin"), systemImage: t.pinned ? "pin.slash" : "pin")
                                }.tint(.yellow)
                            }
                    }
                } header: {
                    if !g.series.isEmpty { Text(g.series) }
                }
            }
            if !store.empty.isEmpty && query.isEmpty {
                Text(store.empty).foregroundStyle(.secondary).frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
    }

    private var gallery: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                if query.isEmpty && !store.pinned.isEmpty { PinnedRow(store: store) }
                if query.isEmpty && !store.folders.isEmpty { FolderList(store: store) }
                ForEach(store.blocks(matches)) { g in
                    if !g.series.isEmpty { Text(g.series).font(.headline).padding(.horizontal) }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 108, maximum: 160), spacing: 16, alignment: .top)], spacing: 20) {
                        ForEach(g.titles) { t in TitleTile(store: store, t: t) }
                    }
                    .padding(.horizontal)
                }
                if !store.empty.isEmpty && query.isEmpty {
                    Text(store.empty).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(.vertical)
        }
        .background(Color(.systemGroupedBackground))
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            if store.folder.isEmpty {
                Button { store.close() } label: { Image(systemName: "xmark") }
            } else {
                Button { store.act("folder") } label: {
                    Label(store.str("library", "Library"), systemImage: "chevron.left").labelStyle(.titleAndIcon)
                }
            }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Menu {
                Picker("", selection: Binding(get: { store.view }, set: { store.act("view", "", $0) })) {
                    Label(store.str("list", "List"), systemImage: "list.bullet").tag("list")
                    Label(store.str("gallery", "Gallery"), systemImage: "square.grid.2x2").tag("gallery")
                }
                Picker(store.str("show", "Show"), selection: Binding(get: { store.filter }, set: { store.act("filter", "", $0) })) {
                    ForEach(store.filters, id: \.self) { c in Text(c.l).tag(c.v) }
                }
                .pickerStyle(.menu)
                Picker(store.str("sort", "Sort"), selection: Binding(get: { store.sort }, set: { store.act("sort", "", $0) })) {
                    ForEach(store.sorts, id: \.self) { c in Text(c.l).tag(c.v) }
                }
                .pickerStyle(.menu)
            } label: {
                Image(systemName: "line.3.horizontal.decrease.circle")
            }
            Menu {
                Button { store.act("newTitle") } label: { Label(store.str("newTitle", "New title"), systemImage: "plus.rectangle.on.rectangle") }
                Button { store.act("importFolder") } label: { Label(store.str("importFolder", "Import folder"), systemImage: "folder.badge.plus") }
                Button { store.act("newFolder") } label: { Label(store.str("newFolder", "New folder"), systemImage: "folder") }
            } label: {
                Image(systemName: "plus")
            }
        }
    }
}

@available(iOS 16.0, *)
struct PinnedRow: View {
    @ObservedObject var store: LibraryStore
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 14) {
                ForEach(store.pinned) { t in
                    Button { store.act("open", t.id) } label: {
                        CoverView(t: t, height: 150)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { TitleMenu(store: store, t: t) }
                }
            }
            .padding(.horizontal)
        }
    }
}

@available(iOS 16.0, *)
struct FolderRow: View {
    @ObservedObject var store: LibraryStore
    let f: LibFolder
    var body: some View {
        Button { store.act("folder", "", f.name) } label: {
            HStack {
                Image(systemName: "folder.fill").foregroundStyle(.tint)
                Text(f.name).foregroundStyle(.primary)
                Spacer()
                Text("\(f.count)").foregroundStyle(.secondary)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button { store.act("folderSheet", "", f.name) } label: { Label(f.name + "…", systemImage: "folder.badge.gearshape") }
        }
    }
}

@available(iOS 16.0, *)
struct FolderList: View {
    @ObservedObject var store: LibraryStore
    var body: some View {
        VStack(spacing: 0) {
            ForEach(store.folders) { f in
                FolderRow(store: store, f: f).padding(.horizontal).padding(.vertical, 12)
                if f.id != store.folders.last?.id { Divider().padding(.leading, 48) }
            }
        }
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal)
    }
}

/// Cover art, or a letter tile when the title has none.
struct CoverView: View {
    let t: LibTitle
    let height: CGFloat
    var body: some View {
        Group {
            if let img = t.cover {
                Image(uiImage: img).resizable().scaledToFill()
            } else {
                ZStack {
                    Color(.tertiarySystemFill)
                    Text(String(t.name.prefix(1))).font(.system(size: height * 0.3, weight: .bold)).foregroundStyle(.secondary)
                }
            }
        }
        .frame(width: height * 2 / 3, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .shadow(color: .black.opacity(0.35), radius: 4, y: 2)
        .opacity(t.cloud ? 0.6 : 1)
    }
}

@available(iOS 16.0, *)
struct TitleTile: View {
    @ObservedObject var store: LibraryStore
    let t: LibTitle
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { store.act("open", t.id) } label: { CoverView(t: t, height: 156) }
                .buttonStyle(.plain)
            Text(t.name).font(.subheadline.weight(.semibold)).lineLimit(2)
            if !t.author.isEmpty { Text(t.author).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            if t.progress > 0 { ProgressView(value: Double(t.progress), total: 100).tint(.green) }
        }
        .contextMenu { TitleMenu(store: store, t: t) }
    }
}

@available(iOS 16.0, *)
struct TitleRow: View {
    @ObservedObject var store: LibraryStore
    let t: LibTitle
    let info: () -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            CoverView(t: t, height: 84)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    if t.pinned { Image(systemName: "pin.fill").font(.caption).foregroundStyle(.yellow) }
                    if t.want { Image(systemName: "heart.fill").font(.caption).foregroundStyle(.pink) }
                    Text(t.name).font(.headline).lineLimit(2)
                }
                if !t.author.isEmpty { Text(t.author).font(.subheadline).foregroundStyle(.secondary) }
                HStack(spacing: 6) {
                    ForEach(t.kinds, id: \.self) { k in KindPill(k: k) }
                }
                if t.cloud {
                    Text(store.str("cloud", "In cloud")).font(.caption).foregroundStyle(.cyan)
                } else if t.progress > 0 {
                    ProgressView(value: Double(t.progress), total: 100).tint(.green)
                }
                Text([t.meta, t.opened].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(action: info) {
                Image(systemName: "info.circle").font(.title3)
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { store.act("open", t.id) }
        .contextMenu { TitleMenu(store: store, t: t) }
    }
}

/// EPUB / AUDIO / SRT pill in the title's mode color.
struct KindPill: View {
    let k: LibKind
    var body: some View {
        let c = k.color.isEmpty ? Color.secondary : Color(hex: k.color)
        Text(k.label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(c)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(c.opacity(0.14), in: Capsule())
            .overlay(Capsule().stroke(c.opacity(0.45), lineWidth: 0.5))
    }
}

/// The long-press menu: the same actions as the web library's details panel.
@available(iOS 16.0, *)
struct TitleMenu: View {
    @ObservedObject var store: LibraryStore
    let t: LibTitle
    var body: some View {
        Button { store.act("open", t.id) } label: { Label(store.str("open", "Open"), systemImage: "book") }
        Button { store.act("pin", t.id) } label: {
            Label(t.pinned ? store.str("unpin", "Unpin") : store.str("pin", "Pin"), systemImage: t.pinned ? "pin.slash" : "pin")
        }
        Button { store.act("want", t.id) } label: {
            Label(store.str("want", "Want to read"), systemImage: t.want ? "heart.fill" : "heart")
        }
        if t.canReadingBook {
            Button { store.act("reading", t.id) } label: {
                Label(store.str("readingBook", "Reading book"), systemImage: t.readingBook ? "star.fill" : "star")
            }
        }
        Button { store.act("move", t.id) } label: { Label(store.str("move", "Move") + "…", systemImage: "folder") }
        Button { store.act("stats", t.id) } label: { Label(store.str("stats", "Stats"), systemImage: "chart.bar") }
        Button { store.act("edit", t.id) } label: { Label(store.str("edit", "Edit") + "…", systemImage: "pencil") }
        if t.canSummarize {
            Button { store.act("summarize", t.id) } label: {
                Label(t.summary.isEmpty ? store.str("summarize", "Summarize") : store.str("newSummary", "New summary"), systemImage: "sparkles")
            }
        }
        Divider()
        Button(role: .destructive) { store.act("delete", t.id) } label: { Label(store.str("del", "Delete"), systemImage: "trash") }
    }
}

@available(iOS 16.0, *)
struct TitleDetail: View {
    @ObservedObject var store: LibraryStore
    let id: String

    var body: some View {
        let t = store.allTitles.first { $0.id == id } ?? store.pinned.first { $0.id == id }
        ScrollView {
            if let t = t {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(alignment: .top, spacing: 16) {
                        CoverView(t: t, height: 180)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(t.name).font(.title3.weight(.bold))
                            if !t.author.isEmpty { Text(t.author).foregroundStyle(.secondary) }
                            if !t.meta.isEmpty { Text(t.meta).font(.caption).foregroundStyle(.secondary) }
                            if t.progress > 0 { ProgressView(value: Double(t.progress), total: 100).tint(.green) }
                        }
                    }
                    Button { store.act("open", t.id) } label: {
                        Text(store.str("open", "Open")).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    if !t.tags.isEmpty {
                        Text(t.tags.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                    }
                    Picker("", selection: Binding(get: { store.blurbLang }, set: { store.act("blurbLang", "", $0) })) {
                        Text("日本語").tag("ja")
                        Text("English").tag("en")
                    }
                    .pickerStyle(.segmented)
                    if t.summary.isEmpty {
                        Text(store.str("noSummary", "No summary yet.")).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(t.summary.enumerated()), id: \.offset) { _, p in
                            Text(p).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding()
            }
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(t?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let t = t {
                Menu { TitleMenu(store: store, t: t) } label: { Image(systemName: "ellipsis.circle") }
            }
        }
    }
}
#endif
