import Foundation

struct CachedThreadDetail: Codable {
    let threadID: String
    let detail: ThreadDetail
    let savedAt: Double
    var liveMessages: [ChatMessage]? = nil
    var liveMessageTurnIDs: [String: String]? = nil
    var pendingOutgoing: ChatMessage? = nil
    var liveRunning: Bool? = nil
}

final class LocalConversationCache {
    static let shared = LocalConversationCache()

    private let rootURL: URL
    private let queue = DispatchQueue(label: "cloudex.conversation-cache", qos: .utility)

    init(rootURL: URL? = nil) {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        self.rootURL = rootURL ?? base.appendingPathComponent("CloudexNative", isDirectory: true)
            .appendingPathComponent("ConversationCache", isDirectory: true)
        try? FileManager.default.createDirectory(at: self.rootURL, withIntermediateDirectories: true)
    }

    func loadProjects(profileID: String) -> [CloudexProject]? {
        queue.sync { read([CloudexProject].self, from: projectsFileURL(profileID: profileID)) }
    }

    func saveProjects(_ projects: [CloudexProject], profileID: String) {
        queue.async { self.write(projects, to: self.projectsFileURL(profileID: profileID)) }
    }

    private func projectsFileURL(profileID: String) -> URL {
        let safeID = profileID.replacingOccurrences(of: "/", with: "_")
        return rootURL.appendingPathComponent("projects-\(safeID).json")
    }

    func loadThread(threadID: String, profileID: String) -> CachedThreadDetail? {
        queue.sync { read(CachedThreadDetail.self, from: threadFileURL(threadID, profileID: profileID)) }
    }

    // Enqueue directly in presentation order; detached Tasks would reorder writes.
    func saveThread(_ snapshot: CachedThreadDetail, profileID: String) {
        queue.async {
            let compact = CachedThreadDetail(threadID: snapshot.threadID, detail: self.compactDetail(snapshot.detail),
                savedAt: snapshot.savedAt, liveMessages: snapshot.liveMessages,
                liveMessageTurnIDs: snapshot.liveMessageTurnIDs, pendingOutgoing: snapshot.pendingOutgoing,
                liveRunning: snapshot.liveRunning)
            self.write(compact, to: self.threadFileURL(snapshot.threadID, profileID: profileID))
        }
    }

    func flush() async {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume() }
        }
    }

    private func compactDetail(_ detail: ThreadDetail) -> ThreadDetail {
        let turns = detail.turns.map { turn in
            let items = turn.items ?? []
            // Running turns must remain lossless across app suspension or a
            // cold relaunch. There is no final assistant item yet, so reducing
            // them to a compact snapshot would retain only the latest bubble.
            if ["inprogress", "in_progress", "active", "running"].contains(turn.status?.lowercased() ?? "") {
                return CloudexTurn(
                    id: turn.id,
                    items: items,
                    status: turn.status,
                    error: turn.error,
                    startedAt: turn.startedAt,
                    completedAt: turn.completedAt,
                    durationMs: turn.durationMs,
                    compressed: turn.compressed,
                    itemsView: "full",
                    processItemCount: 0,
                    detailsLoaded: true
                )
            }
            let finalAgentIndex = items.lastIndex { $0.type == "agentMessage" && $0.phase == "final_answer" }
                ?? items.lastIndex { $0.type == "agentMessage" }
            let visibleItems = items.enumerated().compactMap { index, item in
                item.type == "userMessage" || index == finalAgentIndex ? item : nil
            }
            let processItemCount = max(turn.processItemCount ?? 0, items.count - visibleItems.count)
            return CloudexTurn(
                id: turn.id,
                items: visibleItems,
                status: turn.status,
                error: turn.error,
                startedAt: turn.startedAt,
                completedAt: turn.completedAt,
                durationMs: turn.durationMs,
                compressed: turn.compressed,
                itemsView: turn.itemsView,
                processItemCount: processItemCount,
                detailsLoaded: processItemCount == 0
            )
        }
        return ThreadDetail(
            thread: detail.thread,
            turns: turns,
            hasMoreBefore: detail.hasMoreBefore,
            nextBefore: detail.nextBefore
        )
    }

    private func threadFileURL(_ threadID: String, profileID: String) -> URL {
        // Encode the pair, avoiding collisions from replacing slashes with underscores.
        let key = Data("\(profileID.utf8.count):\(profileID)\(threadID)".utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
        return rootURL.appendingPathComponent("thread-v2-\(key).json")
    }

    private func read<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func write<T: Encodable>(_ value: T, to url: URL) {
        let encoder = JSONEncoder()
        guard let data = try? encoder.encode(value) else { return }
        try? data.write(to: url, options: [.atomic])
    }
}
