import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let statusLabel = UILabel()
    private let doneButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        statusLabel.text = "正在添加到 Cloudex…"
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        doneButton.setTitle("完成", for: .normal)
        doneButton.addTarget(self, action: #selector(finish), for: .touchUpInside)
        doneButton.isHidden = true
        let stack = UIStackView(arrangedSubviews: [statusLabel, doneButton])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
        ])
        Task { await saveSharedContent() }
    }

    private func saveSharedContent() async {
        guard let inboxURL = CloudexShared.inboxURL else {
            showResult("共享容器不可用，请检查 Cloudex 签名配置")
            return
        }
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var texts: [String] = []
        var imageData: Data?
        for provider in providers {
            if imageData == nil, provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
               let raw = await loadData(provider, type: UTType.image.identifier),
               let image = UIImage(data: raw) {
                imageData = image.jpegData(compressionQuality: 0.82)
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let value = await loadItem(provider, type: UTType.url.identifier) {
                if let url = value as? URL { texts.append(url.absoluteString) }
                else if let text = value as? String { texts.append(text) }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let value = await loadItem(provider, type: UTType.plainText.identifier) as? String {
                texts.append(value)
            }
        }
        guard !texts.isEmpty || imageData != nil else {
            showResult("没有可分享的图片、网址或文字")
            return
        }
        guard imageData?.count ?? 0 <= 10 * 1024 * 1024 else {
            showResult("图片超过 10 MB")
            return
        }
        let id = UUID().uuidString
        let imageName = imageData.map { _ in "\(id).jpg" }
        let item = SharedItem(id: id, text: texts.joined(separator: "\n"),
                              imageName: imageName, createdAt: Date())
        do {
            try FileManager.default.createDirectory(at: inboxURL, withIntermediateDirectories: true)
            if let imageData, let imageName {
                try imageData.write(to: inboxURL.appendingPathComponent(imageName), options: .atomic)
            }
            try JSONEncoder().encode(item).write(to: inboxURL.appendingPathComponent("\(id).json"), options: .atomic)
            showResult("已添加，打开 Cloudex 选择主机和会话")
        } catch {
            showResult("保存失败：\(error.localizedDescription)")
        }
    }

    private func loadData(_ provider: NSItemProvider, type: String) async -> Data? {
        await withCheckedContinuation { continuation in
            _ = provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    private func loadItem(_ provider: NSItemProvider, type: String) async -> NSSecureCoding? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, _ in
                continuation.resume(returning: item)
            }
        }
    }

    private func showResult(_ message: String) {
        statusLabel.text = message
        doneButton.isHidden = false
    }

    @objc private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
