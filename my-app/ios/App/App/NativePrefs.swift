import SwiftUI
import UIKit
import WebKit

#if os(iOS)
/// Native iOS Preferences, generated from the web Preferences panel.
///
/// native-prefs.js builds the web panel as usual (every section's setup runs),
/// keeps it invisible and posts a description of it; this draws that
/// description as an iOS Settings-style screen. Every change is written back
/// into the matching web control with its normal events, and Save / Cancel are
/// the web ones, so settings are still applied and stored in exactly one place.
///
/// Shown as a KadokiOverlay; when a button opens a web dialog the screen steps
/// aside until it closes ("cover" messages). iOS 16+ (older systems keep the
/// web Preferences).
@available(iOS 16.0, *)
final class KadokiNativePrefs: NSObject, WKScriptMessageHandler {
    private weak var hostVC: UIViewController?
    private let overlay = KadokiOverlay<PrefsRootView>()
    private let store = PrefsStore()

    static func userScript() -> WKUserScript {
        WKUserScript(source: "window.KADOKI_NATIVE_PREFS=true;", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    func install(in vc: UIViewController, webView: WKWebView) {
        hostVC = vc
        store.webView = webView
        webView.configuration.userContentController.add(WeakMessageHandler(self), name: "kadokiNativePrefs")
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let type = d["type"] as? String else { return }
        switch type {
        case "open":
            if let json = d["model"] as? String { store.load(json) }
            if let vc = hostVC { overlay.show(PrefsRootView(store: store), in: vc) }
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

struct PrefOption: Hashable { let v: String; let l: String }
struct PrefAccessory: Hashable { let id: String; let kind: String }

struct PrefItem: Identifiable {
    let id: String
    let t: String
    let label: String
    let help: String
    let disabled: Bool
    let text: String
    let value: String
    let num: Double
    let min: Double
    let max: Double
    let step: Double
    let display: String
    let on: Bool
    let secure: Bool
    let numeric: Bool
    let placeholder: String
    let unit: String
    let destructive: Bool
    let url: String
    let options: [PrefOption]
    let acc: [PrefAccessory]

    init(_ d: [String: Any], index: Int) {
        t = d["t"] as? String ?? "note"
        id = (d["id"] as? String) ?? "\(t)#\(index)"
        label = d["label"] as? String ?? ""
        help = d["help"] as? String ?? ""
        disabled = d["disabled"] as? Bool ?? false
        text = d["text"] as? String ?? ""
        if let s = d["value"] as? String { value = s } else if let n = d["value"] as? Double { value = String(n) } else { value = "" }
        num = (d["value"] as? Double) ?? Double(value) ?? 0
        min = d["min"] as? Double ?? 0
        max = d["max"] as? Double ?? 100
        step = d["step"] as? Double ?? 1
        display = d["display"] as? String ?? ""
        on = d["on"] as? Bool ?? false
        secure = d["secure"] as? Bool ?? false
        numeric = d["numeric"] as? Bool ?? false
        placeholder = d["placeholder"] as? String ?? ""
        unit = d["unit"] as? String ?? ""
        destructive = d["destructive"] as? Bool ?? false
        url = d["url"] as? String ?? ""
        options = ((d["options"] as? [[String: Any]]) ?? []).map { PrefOption(v: $0["v"] as? String ?? "", l: $0["l"] as? String ?? "") }
        acc = ((d["acc"] as? [[String: Any]]) ?? []).map { PrefAccessory(id: $0["id"] as? String ?? "", kind: $0["kind"] as? String ?? "") }
    }
}

/// A page's items split at sub-headings ("card", "read", …) into groups.
struct PrefGroup: Identifiable {
    let id: Int
    let header: String
    var items: [PrefItem]
}

struct PrefSection: Identifiable {
    let id: Int
    let title: String
    let key: String
    let groups: [PrefGroup]
}

@available(iOS 16.0, *)
final class PrefsStore: ObservableObject {
    weak var webView: WKWebView?
    @Published var title = "Preferences"
    @Published var sections: [PrefSection] = []

    func load(_ json: String) {
        guard let data = json.data(using: .utf8),
              let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        if let t = d["title"] as? String, !t.isEmpty { title = t }
        let raw = (d["sections"] as? [[String: Any]]) ?? []
        sections = raw.enumerated().map { si, s in
            var groups = [PrefGroup(id: 0, header: "", items: [])]
            for (i, item) in ((s["items"] as? [[String: Any]]) ?? []).enumerated() {
                let it = PrefItem(item, index: i)
                if it.t == "header" {
                    groups.append(PrefGroup(id: groups.count, header: it.text, items: []))
                } else {
                    groups[groups.count - 1].items.append(it)
                }
            }
            return PrefSection(id: si, title: s["title"] as? String ?? "", key: s["key"] as? String ?? "",
                               groups: groups.filter { !$0.items.isEmpty })
        }
    }

    private func run(_ js: String, _ args: [String: Any] = [:]) {
        webView?.callAsyncJavaScript(js, arguments: args, in: nil, in: .page) { [weak self] result in
            if case .success(let v) = result, let json = v as? String { self?.load(json) }
        }
    }

    func refresh() { run("return window.__kadokiPrefsDescribe()") }
    func set(_ id: String, _ value: Any) { run("return await window.__kadokiPrefsSet(id, v)", ["id": id, "v": value]) }
    func step(_ id: String, _ dir: Int) { run("return await window.__kadokiPrefsStep(id, d)", ["id": id, "d": dir]) }
    func click(_ id: String) { run("return await window.__kadokiPrefsClick(id)", ["id": id]) }
    func save() { webView?.evaluateJavaScript("window.__kadokiPrefsSave()", completionHandler: nil) }
    func cancel() { webView?.evaluateJavaScript("window.__kadokiPrefsCancel()", completionHandler: nil) }
}

// MARK: - Views

@available(iOS 16.0, *)
struct PrefsRootView: View {
    @ObservedObject var store: PrefsStore

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.sections) { s in
                    NavigationLink {
                        PrefsSectionPage(store: store, sectionId: s.id)
                    } label: {
                        Label(s.title, systemImage: Self.icon(s.key))
                    }
                }
            }
            .navigationTitle(store.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("Cancel", comment: "")) { store.cancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("Save", comment: "")) { store.save() }.bold()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    static func icon(_ key: String) -> String {
        switch key {
        case "lang.heading": return "globe"
        case "ph.sec_appearance": return "textformat.size"
        case "ph.sec_mode_colors": return "paintpalette"
        case "ph.sec_screen": return "sun.max"
        case "ph.sec_dictionaries": return "character.book.closed"
        case "ph.sec_gdrive": return "externaldrive.badge.icloud"
        case "ph.sec_transfer": return "arrow.up.arrow.down.square"
        case "ph.sec_ai": return "sparkles"
        case "ph.sec_audio_archive": return "waveform"
        case "ph.sec_anki_connect", "ph.sec_anki_swipe", "ph.sec_anki_dict": return "rectangle.on.rectangle.angled"
        case "ph.sec_licenses": return "doc.text"
        default: return "gearshape"
        }
    }
}

@available(iOS 16.0, *)
struct PrefsSectionPage: View {
    @ObservedObject var store: PrefsStore
    let sectionId: Int

    var body: some View {
        let s = store.sections.first { $0.id == sectionId }
        Form {
            ForEach(s?.groups ?? []) { g in
                Section {
                    ForEach(g.items) { it in PrefRow(store: store, item: it) }
                } header: {
                    if !g.header.isEmpty { Text(g.header.prefix(1).uppercased() + g.header.dropFirst()) }
                }
            }
        }
        .navigationTitle(s?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
    }
}

@available(iOS 16.0, *)
struct PrefRow: View {
    @ObservedObject var store: PrefsStore
    let item: PrefItem

    var body: some View {
        row
            .disabled(item.disabled)
            .modifier(AccessoryActions(store: store, acc: item.acc))
    }

    @ViewBuilder private var titleView: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.label)
            if !item.help.isEmpty {
                Text(item.help).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var row: some View {
        switch item.t {
        case "toggle":
            Toggle(isOn: Binding(get: { item.on }, set: { store.set(item.id, $0) })) { titleView }
        case "select":
            Picker(selection: Binding(get: { item.value }, set: { store.set(item.id, $0) })) {
                ForEach(item.options, id: \.self) { o in Text(o.l).tag(o.v) }
            } label: { titleView }
            .pickerStyle(.menu)
        case "text":
            PrefTextRow(store: store, item: item)
        case "slider":
            PrefSliderRow(store: store, item: item)
        case "color":
            ColorPicker(selection: Binding(get: { Color(hex: item.value) }, set: { store.set(item.id, $0.hexString) }),
                        supportsOpacity: false) { titleView }
        case "stepper":
            HStack {
                titleView
                Spacer()
                Text(item.value).monospacedDigit().foregroundStyle(.secondary)
                Stepper("", onIncrement: { store.step(item.id, 1) }, onDecrement: { store.step(item.id, -1) })
                    .labelsHidden()
            }
        case "button":
            Button(role: item.destructive ? .destructive : nil) { store.click(item.id) } label: { titleView }
        case "link":
            if let u = URL(string: item.url) { Link(item.label, destination: u) }
        default:
            Text(item.text).font(.footnote).foregroundStyle(.secondary)
        }
    }
}

/// Dictionary rows: move up / down and delete, as iOS row actions.
@available(iOS 16.0, *)
struct AccessoryActions: ViewModifier {
    @ObservedObject var store: PrefsStore
    let acc: [PrefAccessory]

    func body(content: Content) -> some View {
        if acc.isEmpty {
            content
        } else {
            content
                .swipeActions {
                    ForEach(acc.filter { $0.kind == "delete" }, id: \.self) { a in
                        Button(role: .destructive) { store.click(a.id) } label: { Label("Delete", systemImage: "trash") }
                    }
                }
                .contextMenu {
                    ForEach(acc.filter { $0.kind != "delete" }, id: \.self) { a in
                        Button { store.click(a.id) } label: {
                            Label(a.kind == "up" ? "Move Up" : "Move Down",
                                  systemImage: a.kind == "up" ? "arrow.up" : "arrow.down")
                        }
                    }
                }
        }
    }
}

/// Text fields commit on Return and when focus leaves (as the web's change).
@available(iOS 16.0, *)
struct PrefTextRow: View {
    @ObservedObject var store: PrefsStore
    let item: PrefItem
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.label)
            HStack {
                Group {
                    if item.secure { SecureField(item.placeholder, text: $draft) }
                    else { TextField(item.placeholder, text: $draft) }
                }
                .keyboardType(item.numeric ? .decimalPad : .default)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
                .onSubmit { commit() }
                .foregroundStyle(.secondary)
                if !item.unit.isEmpty { Text(item.unit).foregroundStyle(.secondary) }
            }
            if !item.help.isEmpty { Text(item.help).font(.caption).foregroundStyle(.secondary) }
        }
        .onAppear { draft = item.value }
        .onChange(of: focused) { f in if !f { commit() } }
        .onChange(of: item.value) { v in if !focused { draft = v } }
    }

    private func commit() { if draft != item.value { store.set(item.id, draft) } }
}

/// Sliders apply when the drag ends (one web change per adjustment).
@available(iOS 16.0, *)
struct PrefSliderRow: View {
    @ObservedObject var store: PrefsStore
    let item: PrefItem
    @State private var v: Double = 0
    @State private var dragging = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item.label)
                Spacer()
                Text(item.display).monospacedDigit().foregroundStyle(.secondary)
            }
            Group {
                if item.step > 0 {
                    Slider(value: $v, in: item.min...max(item.max, item.min + item.step), step: item.step) { e in edit(e) }
                } else {
                    Slider(value: $v, in: item.min...max(item.max, item.min + 0.01)) { e in edit(e) }
                }
            }
            if !item.help.isEmpty { Text(item.help).font(.caption).foregroundStyle(.secondary) }
        }
        .onAppear { v = item.num }
        .onChange(of: item.num) { n in if !dragging { v = n } }
    }

    private func edit(_ editing: Bool) {
        dragging = editing
        if !editing { store.set(item.id, v) }
    }
}

extension Color {
    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        let n = UInt64(s, radix: 16) ?? 0
        self.init(red: Double((n >> 16) & 0xFF) / 255, green: Double((n >> 8) & 0xFF) / 255, blue: Double(n & 0xFF) / 255)
    }
    var hexString: String {
        let c = UIColor(self)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "#%02x%02x%02x", Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
    }
}
#endif
