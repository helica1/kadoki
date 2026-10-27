import SwiftUI
import UIKit
import WebKit

#if os(iOS)
/// Native iOS Edit Title. native-title-edit.js keeps the web editor running
/// out of sight and describes the title; every control here calls the web
/// editor's own function (file picks, cover extraction, Send to Apple Watch,
/// Create book), so behaviour is unchanged. A child layer like the native
/// Library, not a presented sheet, so the document picker and web alerts
/// still present from the bridge view controller. iOS 16+.
@available(iOS 16.0, *)
final class KadokiNativeTitleEdit: NSObject, WKScriptMessageHandler {
    private weak var hostVC: UIViewController?
    private let overlay = KadokiOverlay<TitleEditView>()
    private let store = TitleEditStore()

    static func userScript() -> WKUserScript {
        WKUserScript(source: "window.KADOKI_NATIVE_TITLEEDIT=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func install(in vc: UIViewController, webView: WKWebView) {
        hostVC = vc
        store.webView = webView
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: "kadokiNativeTitleEdit")
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let type = d["type"] as? String else { return }
        switch type {
        case "open":
            if let json = d["model"] as? String { store.load(json, fresh: true) }
            if let vc = hostVC { overlay.show(TitleEditView(store: store), in: vc) }
        case "model":
            if let json = d["model"] as? String { store.load(json, fresh: false) }
        case "closed":
            overlay.hide()
        case "cover":
            overlay.setCovered((d["on"] as? Bool) ?? false)
        default:
            break
        }
    }
}

// MARK: - Model

struct TEAttachment: Identifiable {
    let id: String
    let label: String
    let indent: Bool
    let file: String
    let attached: Bool
    let pill: String
    let color: String
}

@available(iOS 16.0, *)
final class TitleEditStore: ObservableObject {
    weak var webView: WKWebView?
    @Published var id = ""
    @Published var name = ""
    @Published var style = ""
    @Published var reading: [TEAttachment] = []
    @Published var cards: [TEAttachment] = []
    @Published var createBook = false
    @Published var watch = false
    @Published var watchStatus = ""
    @Published var cover: UIImage?
    @Published var coverSource = ""
    @Published var hasEpub = false
    @Published var hasAudio = false
    @Published var s: [String: String] = [:]

    func str(_ k: String, _ d: String) -> String { s[k].flatMap { $0.isEmpty ? nil : $0 } ?? d }

    /// fresh: a new open. Later updates leave the two text fields alone, so a
    /// refresh never overwrites what the user is typing.
    func load(_ json: String, fresh: Bool) {
        guard let data = json.data(using: .utf8),
              let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let newId = d["id"] as? String ?? ""
        if fresh || newId != id {
            id = newId
            name = d["name"] as? String ?? ""
            style = d["style"] as? String ?? ""
        }
        let rows = { (k: String) in ((d[k] as? [[String: Any]]) ?? []).map {
            TEAttachment(id: $0["id"] as? String ?? "", label: $0["label"] as? String ?? "", indent: $0["indent"] as? Bool ?? false,
                         file: $0["file"] as? String ?? "", attached: $0["attached"] as? Bool ?? false,
                         pill: $0["pill"] as? String ?? "", color: $0["color"] as? String ?? "")
        } }
        reading = rows("reading")
        cards = rows("cards")
        createBook = d["createBook"] as? Bool ?? false
        watch = d["watch"] as? Bool ?? false
        watchStatus = d["watchStatus"] as? String ?? ""
        let c = d["cover"] as? [String: Any] ?? [:]
        coverSource = c["source"] as? String ?? ""
        hasEpub = c["hasEpub"] as? Bool ?? false
        hasAudio = c["hasAudio"] as? Bool ?? false
        if let uri = c["thumb"] as? String, let comma = uri.firstIndex(of: ","),
           let bytes = Data(base64Encoded: String(uri[uri.index(after: comma)...])) {
            cover = UIImage(data: bytes)
        } else {
            cover = nil
        }
        s = d["strings"] as? [String: String] ?? [:]
    }

    func act(_ action: String, _ arg: String = "") {
        webView?.callAsyncJavaScript("await window.__kadokiTitleEdit(a, arg)", arguments: ["a": action, "arg": arg],
                                     in: nil, in: .page, completionHandler: nil)
    }

    // Typing is saved shortly after the last keystroke.
    private var nameWork: DispatchWorkItem?
    private var styleWork: DispatchWorkItem?
    func nameChanged(_ v: String) {
        nameWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.act("name", v) }
        nameWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: w)
    }
    func styleChanged(_ v: String) {
        styleWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.act("style", v) }
        styleWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: w)
    }
    /// Save pending edits now (Done / close).
    func flush() {
        if let w = nameWork, !w.isCancelled { w.cancel(); act("name", name) }
        if let w = styleWork, !w.isCancelled { w.cancel(); act("style", style) }
        nameWork = nil; styleWork = nil
    }
}

// MARK: - Views

@available(iOS 16.0, *)
struct TitleEditView: View {
    @ObservedObject var store: TitleEditStore
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(store.str("name", "Title name"), text: $store.name)
                        .onChange(of: store.name) { store.nameChanged($0) }
                }
                Section(store.str("reading", "Reading")) {
                    ForEach(store.reading) { row($0) }
                    if store.createBook {
                        VStack(alignment: .leading, spacing: 4) {
                            Button(store.str("createBook", "Create book from transcription")) { store.act("createBook") }
                            Text(store.str("createBookNote", "")).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if store.watch {
                        VStack(alignment: .leading, spacing: 4) {
                            Button {
                                store.act("watch")
                            } label: {
                                Label(store.str("watch", "Send to Apple Watch"), systemImage: "applewatch")
                            }
                            Text(store.watchStatus.isEmpty ? store.str("watchNote", "") : store.watchStatus)
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Section(store.str("cards", "Cards")) {
                    ForEach(store.cards) { row($0) }
                }
                Section(store.str("cover", "Cover")) {
                    HStack(spacing: 14) {
                        Group {
                            if let img = store.cover {
                                Image(uiImage: img).resizable().scaledToFill()
                            } else {
                                Image(systemName: "photo").font(.title2).foregroundStyle(.tertiary)
                            }
                        }
                        .frame(width: 54, height: 72)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(store.coverSource.isEmpty ? store.str("coverNone", "No cover") : store.coverSource.uppercased())
                                    .foregroundStyle(store.coverSource.isEmpty ? .secondary : .primary)
                                Spacer()
                                if !store.coverSource.isEmpty {
                                    Button(role: .destructive) { store.act("remove", "cover") } label: {
                                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                                    }
                                    .buttonStyle(.borderless)
                                    .accessibilityLabel(store.str("remove", "Remove"))
                                }
                            }
                            Text(store.str("coverFrom", "Use cover from")).font(.caption).foregroundStyle(.secondary)
                            HStack(spacing: 8) {
                                coverButton(store.str("epub", "EPUB"), "book", "coverEpub", store.hasEpub, store.coverSource == "epub")
                                coverButton(store.str("audio", "Audio"), "headphones", "coverAudio", store.hasAudio, store.coverSource == "id3")
                                coverButton(store.str("clipboard", "Clipboard"), "doc.on.clipboard", "coverClipboard", true, store.coverSource == "clipboard")
                            }
                        }
                    }
                }
                Section {
                    TextField(store.str("stylePlaceholder", ""), text: $store.style, axis: .vertical)
                        .lineLimit(2...6)
                        .onChange(of: store.style) { store.styleChanged($0) }
                } header: {
                    Text(store.str("styleLabel", "AI illustration style"))
                } footer: {
                    Text(store.str("styleNote", ""))
                }
                Section {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        Text(store.str("del", "Delete Title")).frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationTitle(store.str("title", "Edit Title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(store.str("done", "Done")) { store.flush(); store.act("done") }.fontWeight(.semibold)
                }
            }
            .confirmationDialog(store.str("delConfirm", "Remove this title from your library?"),
                                isPresented: $confirmDelete, titleVisibility: .visible) {
                Button(store.str("del", "Delete Title"), role: .destructive) { store.act("delete") }
            } message: {
                Text(store.name)
            }
        }
        .preferredColorScheme(.dark)
    }

    /// A cover source: tinted when it is the current cover's source.
    private func coverButton(_ title: String, _ icon: String, _ action: String, _ enabled: Bool, _ current: Bool) -> some View {
        Button { store.act(action) } label: {
            VStack(spacing: 3) {
                Image(systemName: icon).font(.subheadline)
                Text(title).font(.caption2).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(.bordered)
        .tint(current ? .accentColor : .gray)
        .disabled(!enabled)
    }

    /// One attachment: its kind, the attached file, Pick (or a Replace /
    /// Remove menu when something is attached).
    private func row(_ a: TEAttachment) -> some View {
        HStack(spacing: 10) {
            if a.indent {
                Image(systemName: "arrow.turn.down.right").font(.caption).foregroundStyle(.tertiary)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if !a.pill.isEmpty { KindPill(k: LibKind(label: a.pill, color: a.color)).opacity(a.attached ? 1 : 0.45) }
                    Text(a.label).font(.caption).foregroundStyle(.secondary)
                }
                Text(a.attached ? a.file : store.str("notAttached", "Not attached"))
                    .foregroundStyle(a.attached ? .primary : .tertiary)
                    .lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if a.attached {
                Menu {
                    Button { store.act("pick", a.id) } label: { Label(store.str("replace", "Replace"), systemImage: "arrow.triangle.2.circlepath") }
                    Button(role: .destructive) { store.act("remove", a.id) } label: { Label(store.str("remove", "Remove"), systemImage: "trash") }
                } label: {
                    Text(store.str("replace", "Replace")).font(.subheadline)
                }
            } else {
                Button(store.str("pick", "Pick")) { store.act("pick", a.id) }
                    .font(.subheadline)
                    .buttonStyle(.borderless)
            }
        }
    }
}
#endif
