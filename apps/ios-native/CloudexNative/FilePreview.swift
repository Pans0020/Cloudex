import SwiftUI
import WebKit
import QuickLook

struct FilePreviewRequest: Identifiable {
    let id = UUID()
    let path: String
    let client: APIClient
    let root: String

    static func resolve(_ url: URL, root: String) -> String? {
        if url.absoluteString.hasPrefix("data:image/") { return url.absoluteString }
        if ["https", "http"].contains(url.scheme ?? ""), ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains(url.pathExtension.lowercased()) {
            return url.absoluteString
        }
        guard url.scheme == nil || url.isFileURL || url.scheme == "sandbox" else { return nil }
        var path = url.path
        // Codex file citations may append a source line, which is not part of the filename.
        path = path.replacingOccurrences(of: #":\d+(?::\d+)?$"#, with: "", options: .regularExpression)
        guard !path.isEmpty else { return nil }
        if path.hasPrefix("/") { return path }
        guard !root.isEmpty else { return nil }
        return URL(fileURLWithPath: root, isDirectory: true).appendingPathComponent(path).standardizedFileURL.path
    }
}

struct FilePreviewSheet: View {
    let request: FilePreviewRequest
    @Environment(\.dismiss) private var dismiss
    @State private var localURL: URL?
    @State private var source: String?
    @State private var document: PreparedMarkdown?
    @State private var error: String?
    @State private var showSource = false
    @State private var scripts = false
    @State private var nested: FilePreviewRequest?
    @State private var attempt = 0
    @State private var gifData: Data?
    @State private var gifPaused = false
    @State private var markdownAnchor: String?
    @StateObject private var temporary = PreviewTemporaryDirectory()
    private var name: String {
        if request.path.hasPrefix("data:image/") {
            return "image." + String(request.path.dropFirst(11).prefix(while: { $0 != ";" }))
        }
        return URL(string: request.path)?.lastPathComponent ?? (request.path as NSString).lastPathComponent
    }
    private var ext: String { (name as NSString).pathExtension.lowercased() }

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    ContentUnavailableView {
                        Label("无法预览文件", systemImage: "doc.badge.ellipsis")
                    } description: { Text(error) } actions: {
                        Button("重试") { attempt += 1 }
                    }
                } else if let localURL {
                    if showSource, let source {
                        CodePreviewView(source: source, fileName: name)
                    } else if ["md", "markdown"].contains(ext), let source {
                        ScrollViewReader { reader in
                            ScrollView {
                                MarkdownText(document: document, fallbackText: source)
                                    .padding(20).textSelection(.enabled)
                            }
                            .onChange(of: markdownAnchor) { _, anchor in
                                guard let anchor else { return }
                                let target = document?.blocks.first { block in
                                    guard case let .paragraph(text) = block.content else { return false }
                                    let slug = String(text.characters).lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: "-")
                                    return slug == anchor.lowercased()
                                }
                                if let target { reader.scrollTo(target.id, anchor: .top) }
                            }
                        }
                        .environment(\.previewClient, request.client)
                        .environment(\.previewRoot, (request.path as NSString).deletingLastPathComponent)
                    } else if ext == "gif", let gifData {
                        if gifPaused, let image = UIImage(data: gifData) {
                            Image(uiImage: image).resizable().scaledToFit()
                        } else { GIFWebPreview(data: gifData) }
                    } else if ["html", "htm", "svg"].contains(ext) {
                        IsolatedFileWebView(request: request, scripts: scripts, onError: { error = $0 })
                            .id(scripts)
                    } else if ["png", "jpg", "jpeg", "webp", "heic", "heif", "bmp"].contains(ext)
                                || QLPreviewController.canPreview(localURL as NSURL) {
                        FileQuickLook(url: localURL)
                    } else if let source {
                        CodePreviewView(source: source, fileName: name)
                    } else {
                        ContentUnavailableView("此格式无法内置预览", systemImage: "doc", description: Text("可使用分享按钮保存或用其他应用打开。"))
                    }
                } else { ProgressView("读取文件…") }
            }
            .navigationTitle(name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                ToolbarItemGroup(placement: .bottomBar) {
                    if source != nil { Button(cloudexLocalized(showSource ? "预览" : "源码")) { showSource.toggle() } }
                    if ["html", "htm"].contains(ext) { Toggle("交互脚本", isOn: $scripts) }
                    if ext == "gif" { Button(cloudexLocalized(gifPaused ? "播放" : "暂停")) { gifPaused.toggle() } }
                    Spacer()
                    if let localURL { ShareLink(item: localURL) }
                }
            }
            .environment(\.openURL, OpenURLAction { url in
                if let fragment = url.fragment, url.path.isEmpty || FilePreviewRequest.resolve(url, root: (request.path as NSString).deletingLastPathComponent) == request.path {
                    markdownAnchor = fragment.removingPercentEncoding ?? fragment
                    return .handled
                }
                guard let path = FilePreviewRequest.resolve(url, root: (request.path as NSString).deletingLastPathComponent) else {
                    return ["https", "http", "mailto"].contains(url.scheme ?? "") ? .systemAction : .discarded
                }
                nested = FilePreviewRequest(path: path, client: request.client, root: request.root)
                return .handled
            })
        }
        .sheet(item: $nested) { FilePreviewSheet(request: $0) }
        .task(id: attempt) { await load() }
    }

    private func load() async {
        error = nil
        do {
            let data: Data
            if request.path.hasPrefix("data:image/"), let encoded = request.path.split(separator: ",", maxSplits: 1).last,
               let decoded = Data(base64Encoded: String(encoded)) { data = decoded }
            else if let url = URL(string: request.path), ["https", "http"].contains(url.scheme ?? "") {
                let (download, response) = try await URLSession.shared.download(from: url)
                defer { try? FileManager.default.removeItem(at: download) }
                guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
                      (try download.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 50 * 1024 * 1024 else { throw URLError(.cannotDecodeContentData) }
                data = try Data(contentsOf: download)
            } else { data = try await request.client.download("/api/file", queryItems: [.init(name: "path", value: request.path)]) }
            try Task.checkCancellation()
            let directory = temporary.url
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(name)
            try data.write(to: url, options: .atomic)
            if ext == "gif" { gifData = data }
            source = CodePreviewFile.supports(fileName: name) ? CodePreviewFile.decode(data) : nil
            if ["md", "markdown"].contains(ext), let source { document = try await MarkdownRenderer.shared.prepare(source) }
            try Task.checkCancellation()
            localURL = url
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}

private final class PreviewTemporaryDirectory: ObservableObject {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("CloudexPreviews/\(UUID())")
    deinit { try? FileManager.default.removeItem(at: url) }
}

private struct GIFWebPreview: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.loadHTMLString("<meta name='viewport' content='width=device-width,initial-scale=1'><style>body{margin:0;background:transparent}img{width:100%;object-fit:contain}</style><img src='data:image/gif;base64,\(data.base64EncodedString())'>", baseURL: nil)
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

// Untrusted HTML never receives a bearer token, API origin, cookies or a native JS bridge.
// Only relative resources beneath this document's directory pass through the scheme handler.
private struct IsolatedFileWebView: UIViewRepresentable {
    let request: FilePreviewRequest
    let scripts: Bool
    let onError: (String) -> Void
    func makeCoordinator() -> FileResourceHandler { FileResourceHandler(request: request, onError: onError) }
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = scripts
        config.setURLSchemeHandler(context.coordinator, forURLScheme: "cloudex-preview")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        var components = URLComponents()
        components.scheme = "cloudex-preview"; components.host = "document"; components.path = request.path
        if let url = components.url { view.load(URLRequest(url: url)) }
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
    static func dismantleUIView(_ view: WKWebView, coordinator: FileResourceHandler) {
        view.stopLoading(); coordinator.cancelAll()
    }
}

private final class FileResourceHandler: NSObject, WKURLSchemeHandler, WKNavigationDelegate {
    let request: FilePreviewRequest
    let onError: (String) -> Void
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(request: FilePreviewRequest, onError: @escaping (String) -> Void) { self.request = request; self.onError = onError }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        tasks[key] = Task { @MainActor in
            defer { tasks[key] = nil }
            do {
                guard let url = urlSchemeTask.request.url, url.host == "document" else { throw URLError(.unsupportedURL) }
                let data = try await request.client.download("/api/file", queryItems: [
                    .init(name: "path", value: url.path), .init(name: "previewRoot", value: (request.path as NSString).deletingLastPathComponent)])
                try Task.checkCancellation()
                let mime = ["html": "text/html", "htm": "text/html", "css": "text/css", "js": "text/javascript", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp" ][url.pathExtension.lowercased()] ?? "application/octet-stream"
                let contentType = mime.hasPrefix("text/") || mime == "image/svg+xml" ? "\(mime); charset=utf-8" : mime
                let headers = ["Content-Type": contentType, "Content-Security-Policy": "default-src 'none'; img-src cloudex-preview: data:; style-src cloudex-preview: 'unsafe-inline'; script-src cloudex-preview: 'unsafe-inline'; font-src cloudex-preview: data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"]
                urlSchemeTask.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!)
                urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
            } catch {
                if !Task.isCancelled && tasks[key] != nil { urlSchemeTask.didFailWithError(error) }
            }
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel() }
    func cancelAll() { for task in tasks.values { task.cancel() }; tasks.removeAll() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { onError(error.localizedDescription) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { onError(error.localizedDescription) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.scheme == "cloudex-preview" ? .allow : .cancel)
    }
}

struct FileQuickLook: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController(); controller.dataSource = context.coordinator; return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url; controller.reloadData()
    }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

private struct PreviewClientKey: EnvironmentKey { static let defaultValue = APIClient(serverURL: "", token: "") }
private struct PreviewRootKey: EnvironmentKey { static let defaultValue = "" }
extension EnvironmentValues {
    var previewClient: APIClient { get { self[PreviewClientKey.self] } set { self[PreviewClientKey.self] = newValue } }
    var previewRoot: String { get { self[PreviewRootKey.self] } set { self[PreviewRootKey.self] = newValue } }
}

struct MarkdownImage: View {
    let destination: String
    let label: String
    @Environment(\.previewClient) private var client
    @Environment(\.previewRoot) private var root
    @Environment(\.openURL) private var openURL
    var body: some View {
        if let url = URL(string: destination), let path = FilePreviewRequest.resolve(url, root: root) {
            Button { openURL(url) } label: {
                AttachmentThumbnail(path: path, server: client.serverURL, client: client)
                    .frame(maxWidth: 300).frame(height: 170)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }.buttonStyle(.plain).accessibilityLabel(label.isEmpty ? "查看图片" : label)
        } else if let url = URL(string: destination), ["http", "https"].contains(url.scheme ?? "") {
            // External requests intentionally carry no Cloudex authorization header.
            Link(destination: url) {
                AsyncImage(url: url) { image in image.resizable().scaledToFit() } placeholder: { Image(systemName: "photo") }
                    .frame(maxWidth: 300).frame(height: 170)
            }
        }
    }
}
