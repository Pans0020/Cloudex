import Foundation

enum CloudexShared {
    static let groupID = "group.com.cloudex.native"

    static var inboxURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupID)?
            .appendingPathComponent("Inbox", isDirectory: true)
    }

    static func pendingItems() -> [SharedItem] {
        guard let inboxURL,
              let files = try? FileManager.default.contentsOfDirectory(at: inboxURL, includingPropertiesForKeys: nil) else { return [] }
        return files.filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(SharedItem.self, from: Data(contentsOf: $0)) }
            .sorted { $0.createdAt < $1.createdAt }
    }

    static func imageData(for item: SharedItem) -> Data? {
        guard let imageName = item.imageName, let inboxURL else { return nil }
        return try? Data(contentsOf: inboxURL.appendingPathComponent(imageName))
    }

    static func remove(_ item: SharedItem) {
        guard let inboxURL else { return }
        try? FileManager.default.removeItem(at: inboxURL.appendingPathComponent("\(item.id).json"))
        if let imageName = item.imageName {
            try? FileManager.default.removeItem(at: inboxURL.appendingPathComponent(imageName))
        }
    }
}

struct SharedItem: Codable, Identifiable, Equatable {
    let id: String
    let text: String
    let imageName: String?
    let createdAt: Date
}

struct CurrentTaskSnapshot: Codable {
    let hostName: String
    let title: String
    let activeCount: Int
    let updatedAt: Date

    static func load() -> CurrentTaskSnapshot? {
        guard let data = UserDefaults(suiteName: CloudexShared.groupID)?.data(forKey: "currentTask") else { return nil }
        return try? JSONDecoder().decode(CurrentTaskSnapshot.self, from: data)
    }
}
