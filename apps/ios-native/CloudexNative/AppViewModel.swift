import Foundation
import SwiftUI
import UIKit
import WidgetKit
import ImageIO
import CryptoKit

@MainActor
final class ComposerDraft: ObservableObject {
    private let persists: Bool
    init(persists: Bool = true) { self.persists = persists }
    @Published var text = "" {
        didSet { if persists { UserDefaults.standard.set(text, forKey: "cloudex.draft") } }
    }
}

@MainActor
enum AttachmentImageCache {
    private static let diskQueue = DispatchQueue(label: "cloudex.thumbnail-cache", qos: .utility)
    private static let diskRoot = (FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true))
        .appendingPathComponent("CloudexNative/Thumbnails", isDirectory: true)
    private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 20 * 1024 * 1024
        return cache
    }()

    static func image(path: String, server: String) -> UIImage? {
        images.object(forKey: "\(server)|\(path)" as NSString)
    }

    static func cachedImage(path: String, server: String) async -> UIImage? {
        if let image = image(path: path, server: server) { return image }
        let url = diskFile(path: path, server: server)
        let data: Data? = await withCheckedContinuation { continuation in
            diskQueue.async { continuation.resume(returning: try? Data(contentsOf: url)) }
        }
        guard let data, !Task.isCancelled else { return nil }
        return await prepare(data, path: path, server: server, persist: false)
    }

    private static func diskFile(path: String, server: String) -> URL {
        let key = SHA256.hash(data: Data("\(server.utf8.count):\(server)\(path)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        return diskRoot.appendingPathComponent(key + ".png")
    }

    static func prepare(_ data: Data, path: String, server: String, persist: Bool = true) async -> UIImage? {
        let image = await Task.detached(priority: .userInitiated) {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 520,
                    kCGImageSourceShouldCacheImmediately: true
                  ] as CFDictionary) else { return nil as UIImage? }
            return UIImage(cgImage: thumbnail)
        }.value
        if let image {
            images.setObject(image, forKey: "\(server)|\(path)" as NSString,
                             cost: Int(image.size.width * image.size.height * 4))
            if persist {
                let url = diskFile(path: path, server: server)
                diskQueue.async {
                    guard let data = image.pngData() else { return }
                    let directory = url.deletingLastPathComponent()
                    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    try? data.write(to: url, options: .atomic)
                    let keys: Set<URLResourceKey> = [.fileSizeKey, .contentModificationDateKey]
                    let files = (try? FileManager.default.contentsOfDirectory(at: directory,
                        includingPropertiesForKeys: Array(keys))) ?? []
                    let entries = files.compactMap { file -> (URL, Int, Date)? in
                        guard let values = try? file.resourceValues(forKeys: keys) else { return nil }
                        return (file, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
                    }.sorted { $0.2 < $1.2 }
                    var bytes = entries.reduce(0) { $0 + $1.1 }
                    for (file, size, _) in entries where bytes > 40 * 1024 * 1024 {
                        try? FileManager.default.removeItem(at: file)
                        bytes -= size
                    }
                }
            }
        }
        return image
    }

    #if DEBUG
    static func checkDiskRestore() async {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 60))
        let image = renderer.image { context in
            UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 60))
        }
        let path = "/thumbnail-regression-\(UUID()).png"
        _ = await prepare(image.pngData()!, path: path, server: "regression")
        await withCheckedContinuation { continuation in diskQueue.async { continuation.resume() } }
        images.removeAllObjects()
        let restored = await cachedImage(path: path, server: "regression")
        let otherHost = await cachedImage(path: path, server: "other-host")
        precondition(restored != nil,
                     "Generated thumbnails must survive a cold memory cache offline")
        precondition(otherHost == nil,
                     "Thumbnail disk keys leaked across hosts")
        try? FileManager.default.removeItem(at: diskFile(path: path, server: "regression"))
    }
    #endif
}

@MainActor
final class AppViewModel: ObservableObject {
    private let isReadOnlyViewer: Bool
    var isReadOnlyConversation: Bool { isReadOnlyViewer || selectedThread?.canAcceptDirectInput == false }
    enum ConversationLoadState: Equatable {
        case idle, loading, ready, syncing, failed(String)
    }
    @Published private(set) var conversationLoadState: ConversationLoadState = .idle
    @Published private(set) var isRefreshing = false
    @Published var expandedProcessIDs: Set<String> = []
    @Published var chatDetails = ChatDetailPreferences.load() {
        didSet {
            guard !isReadOnlyViewer, chatDetails != oldValue else { return }
            if let data = try? JSONEncoder().encode(chatDetails) {
                UserDefaults.standard.set(data, forKey: ChatDetailPreferences.storageKey)
            }
        }
    }
    @Published var serverURL: String
    @Published var lanServerURL: String
    @Published var tailscaleServerURL: String
    @Published var connectionMode: ConnectionMode
    @Published var authToken: String
    @Published var selectedAgentProvider: AgentProvider
    @Published var selectedModelID: String
    @Published var selectedEffortID: String
    @Published var codexMode: CodexExecutionMode
    @Published var claudeMode: ClaudeExecutionMode
    @Published private(set) var pinnedThreadIDs: Set<String>
    @Published var projects: [CloudexProject] = []
    @Published var renderedMessages: [ChatMessage] = []
    @Published private(set) var isPreparingInitialMessages = false
    @Published var pendingOutgoing: ChatMessage? { didSet { rebuildRenderedMessages() } }
    @Published var models: [CodexModel] = []
    @Published var selectedProjectCWD: String?
    @Published var selectedThreadID: String? {
        didSet {
            guard oldValue != selectedThreadID else { return }
            resetConversationControls()
        }
    }
    @Published var collaborationMode = "default"
    @Published var collaborationModes: [String] = []
    @Published var collaborationModeError: String?
    @Published var queueItems: [QueuedMessage] = []
    @Published var queuePaused = false
    @Published var queueError: String?
    private var queueUploads = Set<String>()
    private var queueRevision = -1
    private var queueScope = ""
    private func resetConversationControls() {
        collaborationMode = UserDefaults.standard.string(forKey: collaborationPreferenceKey) ?? "default"
        collaborationModes = []; collaborationModeError = nil
        queueItems = []; queuePaused = false; queueError = nil; queueScope = ""; queueRevision = -1
    }
    @Published var detail: ThreadDetail? { didSet { rebuildRenderedMessages() } }
    let composerDraft: ComposerDraft
    var draft: String {
        get { composerDraft.text }
        set { composerDraft.text = newValue }
    }
    @Published var pendingSteerDraft = "" {
        didSet {
            if !isReadOnlyViewer { UserDefaults.standard.set(pendingSteerDraft, forKey: "cloudex.pendingSteerDraft") }
        }
    }
    @Published var status = cloudexLocalized("未连接")
    @Published var isServerReachable = false
    @Published var isBusy = false
    @Published var isOpeningThread = false
    @Published private(set) var isLoadingOlderTurns = false
    @Published var isCreatingNew = false
    // Token fragments are internal state; only coalesced rendered messages notify the UI.
    private var liveMessages: [ChatMessage] = [] { didSet { scheduleRenderedMessagesRebuild() } }
    @Published var liveRunning = false {
        didSet { if oldValue && !liveRunning { rebuildRenderedMessages() } }
    }
    @Published var localError: String? { didSet { rebuildRenderedMessages() } }
    @Published var attachedFiles: [RemoteFileEntry] = []
    @Published var pendingApprovals: [ApprovalRequest] = []
    @Published var pendingInputs: [InputRequest] = []
    @Published var presentedInput: InputRequest?
    @Published var systemMessages: [ChatMessage] = [] { didSet { rebuildRenderedMessages() } }
    @Published var messageIndex: [MessageIndexItem] = []
    @Published var pendingMessageJump: PendingMessageJump?
    @Published var threadNavigationRequest: ThreadNavigationRequest?
    @Published var notifyApprovals: Bool
    @Published var notifyTaskSuccess: Bool
    @Published var notifyTaskFailure: Bool
    @Published private(set) var connectionHistory: [ConnectionHistoryItem] = []
    @Published private(set) var serverProfiles: [ServerProfile] = []
    @Published private(set) var serverOverviews: [ServerOverview] = []
    @Published private(set) var pendingShares: [SharedItem] = []
    @Published var selectedServerProfileID: String?

    private let globalSSE = SSEClient()
    private let threadSSE = SSEClient()
    private let conversationCache: LocalConversationCache
    private var cacheCheckpointTask: Task<Void, Never>?
    private var replayedMessageText: [String: String] = [:]
    private var replayNeedsRefresh = false
    private var cachedOlderTurns: [CloudexTurn] = []
    private var lastCachedConversation: CachedThreadDetail?
    private var detailRequestInFlight: UUID?
    private var detailRefreshPending = false
    private var detailPageTask: Task<ThreadDetail, Error>?
    private var searchReturnDetail: ThreadDetail?
    private var sendingRequestID: UUID?
    private var refreshGeneration: Int?
    private var initialCacheLoadGeneration: Int?
    private var pollTask: Task<Void, Never>?
    private var healthTask: Task<Void, Never>?
    private var overviewGeneration = 0
    private var connectionGeneration = 0
    private var modelsLoaded = false
    private var modelsLoadingGeneration: Int?
    private var modelsLoading: Bool { modelsLoadingGeneration == connectionGeneration }
    private var started = false
    private var isForeground = true
    private var streamsStarted = false
    private var lastThreadEventID = 0
    private var threadStreamReplaying = false
    private var threadReplayIsIncremental = false
    private var threadEventRevision = 0
    private var approvalEventRevision = 0
    private var inputEventRevision = 0
    private var pendingRequestsGeneration: Int?
    private var detailLoadGeneration = 0
    private var threadOpenGeneration = 0
    private var olderTurnsLoadGeneration = 0
    private var liveMessageTurnIDs: [String: String] = [:]
    private var suppressedCompactionMessageIDs = Set<String>()
    private var liveOrderingClock: Double = 0
    private var activeTurnNotificationKeys: [String: String] = [:]
    private var sentTaskResultNotificationKeys = Set<String>()
    private var renderedMessagesRebuildTask: Task<Void, Never>?
    private var eventReloadTask: Task<Void, Never>?
    private var terminalReloadPending = false
    private var renderEpoch = 0
    private var renderRequestID = 0
    private var publishedRenderID = 0
    private var pendingRender: (epoch: Int, id: Int, messages: [ChatMessage])?
    private var renderPreparationTask: Task<Void, Never>?

    init(conversationCache: LocalConversationCache = .shared, readOnlyParent: AppViewModel? = nil) {
        self.conversationCache = conversationCache
        isReadOnlyViewer = readOnlyParent != nil
        composerDraft = ComposerDraft(persists: readOnlyParent == nil)
        let defaults = UserDefaults.standard
        let savedLANURL = defaults.string(forKey: "cloudex.lanServerURL") ?? ""
        let savedTailscaleURL = defaults.string(forKey: "cloudex.tailscaleServerURL") ?? ""
        let savedToken = defaults.string(forKey: "cloudex.authToken") ?? ""
        // 不内置任何开发机地址：默认只指向本机回环地址，
        // 真实服务器地址通过设置页填写或扫描配对二维码获取。
        let defaultServerURL = "http://127.0.0.1:8890"
        let initialLANURL = savedLANURL.isEmpty ? defaultServerURL : savedLANURL
        let initialTailscaleURL = savedTailscaleURL.isEmpty ? defaultServerURL : savedTailscaleURL
        let initialConnectionMode = ConnectionMode(rawValue: defaults.string(forKey: "cloudex.connectionMode") ?? "") ?? .automatic
        lanServerURL = initialLANURL
        tailscaleServerURL = initialTailscaleURL
        connectionMode = initialConnectionMode
        serverURL = initialConnectionMode == .tailscale ? initialTailscaleURL : initialLANURL
        // 不内置任何开发期 Token：认证信息只来自已保存值或扫码配对。
        authToken = savedToken
        // The Codex CLI config is authoritative on each launch. An in-app
        // selection still applies for the current run and subsequent turns.
        selectedModelID = ""
        selectedAgentProvider = AgentProvider(rawValue: defaults.string(forKey: "cloudex.agentProvider") ?? "") ?? .codex
        selectedEffortID = defaults.bool(forKey: "cloudex.effort.userSelected")
            ? (defaults.string(forKey: "cloudex.effort") ?? "")
            : ""
        pendingSteerDraft = defaults.string(forKey: "cloudex.pendingSteerDraft") ?? ""
        codexMode = CodexExecutionMode(
            rawValue: defaults.string(forKey: "cloudex.codexMode") ?? ""
        ) ?? .requestApproval
        claudeMode = ClaudeExecutionMode(
            rawValue: defaults.string(forKey: "cloudex.claudeMode") ?? ""
        ) ?? .manual
        pinnedThreadIDs = Set(defaults.stringArray(forKey: "cloudex.pinnedThreadIDs") ?? [])
        notifyApprovals = defaults.object(forKey: "cloudex.notifyApprovals") as? Bool ?? true
        notifyTaskSuccess = defaults.object(forKey: "cloudex.notifyTaskSuccess") as? Bool ?? true
        notifyTaskFailure = defaults.object(forKey: "cloudex.notifyTaskFailure") as? Bool ?? true
        draft = isReadOnlyViewer ? "" : (defaults.string(forKey: "cloudex.draft") ?? "")
        if !isReadOnlyViewer {
            defaults.set(lanServerURL, forKey: "cloudex.serverURL")
            defaults.set(lanServerURL, forKey: "cloudex.lanServerURL")
            defaults.set(tailscaleServerURL, forKey: "cloudex.tailscaleServerURL")
            defaults.set(connectionMode.rawValue, forKey: "cloudex.connectionMode")
            defaults.set(authToken, forKey: "cloudex.authToken")
        }
        connectionHistory = Self.loadConnectionHistory(defaults: defaults)
        serverProfiles = Self.loadServerProfiles(defaults: defaults)
        if serverProfiles.isEmpty {
            serverProfiles = connectionHistory.map { item in
                let lan = item.connectionMode == .tailscale ? "" : item.serverURL
                let tailscale = item.connectionMode == .tailscale ? item.serverURL : ""
                return ServerProfile(
                    name: Self.serverName(for: item.serverURL),
                    lanURL: lan,
                    tailscaleURL: tailscale,
                    token: item.token,
                    connectionMode: item.connectionMode,
                    lastUsedAt: item.lastUsedAt
                )
            }
            if !isReadOnlyViewer { persistServerProfiles(defaults: defaults) }
        }
        selectedServerProfileID = defaults.string(forKey: "cloudex.selectedServerProfileID") ?? serverProfiles.first?.id
        if let profile = activeServerProfile {
            lanServerURL = profile.lanURL.isEmpty ? lanServerURL : profile.lanURL
            tailscaleServerURL = profile.tailscaleURL.isEmpty ? tailscaleServerURL : profile.tailscaleURL
            connectionMode = profile.connectionMode
            authToken = profile.token
            serverURL = profile.activeURL.isEmpty ? profile.preferredURL : profile.activeURL
        }
        if let parent = readOnlyParent {
            serverURL = parent.serverURL
            lanServerURL = parent.lanServerURL
            tailscaleServerURL = parent.tailscaleServerURL
            connectionMode = parent.connectionMode
            authToken = parent.authToken
            serverProfiles = parent.serverProfiles
            selectedServerProfileID = parent.selectedServerProfileID
            selectedAgentProvider = parent.selectedAgentProvider
            models = parent.models
            modelsLoaded = parent.modelsLoaded
            projects = parent.projects
            chatDetails = parent.chatDetails
            isServerReachable = parent.isServerReachable
            pendingSteerDraft = ""
        } else {
            Task { await restoreProjectsIfNeeded() }
        }
        rebuildRenderedMessages()
    }

    private func restoreProjectsIfNeeded() async {
        let profile = selectedServerProfileID ?? "default"
        let cache = conversationCache
        let cached = await Task.detached(priority: .userInitiated) { cache.loadProjects(profileID: profile) }.value
        guard (selectedServerProfileID ?? "default") == profile, projects.isEmpty, let cached else { return }
        projects = cached
    }

    var client: APIClient { APIClient(serverURL: serverURL, token: authToken) }
    var activeServerProfile: ServerProfile? {
        serverProfiles.first { $0.id == selectedServerProfileID }
    }
    var serverProfileTitle: String {
        activeServerProfile?.name ?? activeConnectionTitle
    }
    var activeConnectionTitle: String {
        serverURL == normalizedURL(tailscaleServerURL) ? "Tailscale" : cloudexLocalized("局域网")
    }
    var selectedProject: CloudexProject? { projects.first { $0.cwd == selectedProjectCWD } }
    var selectedThread: CloudexThread? { detail?.thread }
    var selectedThreadSnapshot: CloudexThread? {
        guard let selectedThreadID else { return nil }
        return projects.lazy.flatMap(\.threads).compactMap { $0.descendant(withID: selectedThreadID) }.first
    }
    var selectedSubagents: [CloudexThread] {
        selectedThreadSnapshot?.subagents ?? selectedThread?.subagents ?? []
    }
    var allThreads: [CloudexThread] { projects.flatMap(\.threads).filter { !$0.isSubagent } }
    var availableAgentProviders: [AgentProvider] {
        let found = Set(allThreads.map(\.agentProvider)).union(models.map(\.agentProvider))
        return AgentProvider.allCases.filter { found.contains($0) || $0 == selectedAgentProvider }
    }
    var agentProjects: [CloudexProject] {
        projects.compactMap { project in
            let threads = project.threads.filter { !$0.isSubagent && $0.agentProvider == selectedAgentProvider }
            guard !threads.isEmpty else { return nil }
            return CloudexProject(id: project.id, name: project.name, cwd: project.cwd, threads: threads, updatedAt: project.updatedAt)
        }
    }
    var isConnected: Bool { isServerReachable }
    var active: Bool { liveRunning || selectedThread?.isActive == true }
    var selectedModel: CodexModel? {
        models.first { $0.agentProvider == selectedAgentProvider && $0.identifier == selectedModelID }
    }
    var modelsForSelectedProvider: [CodexModel] {
        var seen = Set<String>()
        return models.filter {
            guard $0.agentProvider == selectedAgentProvider else { return false }
            return seen.insert($0.identifier).inserted
        }
    }
    var availableEfforts: [ReasoningEffortOption] { selectedModel?.supportedReasoningEfforts ?? [] }
    var selectedEffortTitle: String {
        availableEfforts.first { $0.reasoningEffort == selectedEffortID }?.title ?? cloudexLocalized("默认")
    }
    var compactModelTitle: String {
        let title = selectedModel?.title
            ?? (!selectedModelID.isEmpty ? selectedModelID : cloudexLocalized(modelsLoading ? "读取中" : "模型"))
        return title
            .replacingOccurrences(of: "GPT-", with: "")
            .replacingOccurrences(of: "gpt-", with: "")
    }
    var visibleApprovals: [ApprovalRequest] {
        guard let selectedThreadID else { return pendingApprovals }
        return pendingApprovals
            .filter { approval in
                approval.threadId == nil || approval.threadId == selectedThreadID
            }
            .sorted { left, right in
                (left.requestedAt ?? 0) < (right.requestedAt ?? 0)
            }
    }

    var navigationTitle: String {
        if isCreatingNew { return cloudexLocalized("新对话") }
        return isReadOnlyConversation ? (selectedThread?.agentTitle ?? "Cloudex") : (selectedThread?.title ?? "Cloudex")
    }

    var projectTitle: String { selectedProject?.displayName ?? cloudexLocalized("选择项目") }

    var messages: [ChatMessage] {
        renderedMessages
    }

    private func isTurnInProgress(_ turn: CloudexTurn) -> Bool {
        guard let status = turn.status?.lowercased() else { return liveRunning }
        return ["inprogress", "in_progress", "active", "running"].contains(status)
    }

    private func buildMessages() -> [ChatMessage] {
        var result: [ChatMessage] = []
        let liveByID = Dictionary(liveMessages.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        let liveMessagesByTurn = Dictionary(grouping: liveMessages) { message in
            liveMessageTurnIDs[message.id] ?? ""
        }
        for turn in detail?.turns ?? [] {
            let items = turn.items ?? []
            let shouldFoldProcess = turn.status != nil && !isTurnInProgress(turn)
            let durationMessage = taskDurationMessage(for: turn)
            let compressedMessage = compressedMessage(for: turn)
            if shouldFoldProcess {
                let finalAgentIndex = items.lastIndex(where: { $0.type == "agentMessage" && $0.phase == "final_answer" })
                    ?? items.lastIndex(where: { $0.type == "agentMessage" })
                var processItems: [ChatMessage] = []
                var finalMessage: ChatMessage?

                for (index, item) in items.enumerated() {
                    guard let persisted = timelineMessage(from: item, turnID: turn.id, fallbackIndex: index) else { continue }
                    let message = liveByID[persisted.id] ?? persisted
                    if item.type == "userMessage" {
                        result.append(message)
                    } else if index == finalAgentIndex {
                        finalMessage = message
                    } else {
                        processItems.append(message)
                    }
                }
                // Keep the fine-grained execution rows captured from the live
                // event stream even when the persisted session omits them.
                let existingProcessIDs = Set(processItems.map(\.id))
                let itemIDs = Set(items.compactMap(\.id))
                let hasFinalAnswer = items.contains { $0.type == "agentMessage" && $0.phase == "final_answer" }
                processItems.append(contentsOf: (liveMessagesByTurn[turn.id] ?? []).filter {
                    ($0.role == .execution && !existingProcessIDs.contains($0.id)) ||
                    ($0.role == .assistant && $0.phase != "final_answer" && hasFinalAnswer && !itemIDs.contains($0.id))
                })
                if let compressedMessage { processItems.append(compressedMessage) }
                processItems = mergeSemanticExecutionItems(processItems)

                if !processItems.isEmpty || (turn.processItemCount ?? 0) > 0 || durationMessage != nil {
                    result.append(ChatMessage(
                        id: "\(turn.id)-process-summary",
                        role: .processSummary,
                        text: processSummaryText(durationMessage?.text),
                        processItems: processItems,
                        createdAt: processItems.compactMap(\.createdAt).min(),
                        sourceTurnID: turn.id,
                        processItemCount: turn.processItemCount,
                        processDetailsLoaded: turn.processDetailsAreLoaded,
                        attachments: processItems.flatMap(\.attachments).reduce(into: [MessageAttachment]()) { values, item in
                            if !values.contains(where: { $0.path == item.path }) { values.append(item) }
                        }
                    ))
                }
                let editDiff = processItems.flatMap { $0.editDiff ?? [] }
                if var finalMessage {
                    finalMessage.phase = "final_answer"
                    finalMessage.editDiff = editDiff.isEmpty ? nil : editDiff
                    result.append(finalMessage)
                }
                // A terminal page can arrive before its last agent item is persisted.
                result.append(contentsOf: (liveMessagesByTurn[turn.id] ?? []).filter {
                    $0.role == .assistant && ($0.phase == "final_answer" || !hasFinalAnswer) && !itemIDs.contains($0.id)
                })
            } else {
                for (index, item) in items.enumerated() {
                    if let message = timelineMessage(from: item, turnID: turn.id, fallbackIndex: index) {
                        result.append(liveByID[message.id] ?? message)
                    }
                }
                // Keep the original live presentation for an active turn:
                // each execution row and assistant bubble stays directly in
                // the timeline. Only the command semantic classification is
                // shared with the completed-turn process view.
                let liveForTurn = liveMessagesByTurn[turn.id] ?? []
                let existingMessageIDs = Set(result.map(\.id))
                result.append(contentsOf: liveForTurn.filter {
                    !existingMessageIDs.contains($0.id)
                })
                if let durationMessage { result.append(durationMessage) }
                if let compressedMessage { result.append(compressedMessage) }
            }
            if let error = turn.error {
                result.append(ChatMessage(
                    id: "\(turn.id)-error",
                    role: .error,
                    text: error.displayText,
                    createdAt: turn.completedAt ?? turn.startedAt
                ))
            }
        }
        if let localError, !localError.isEmpty {
            result.append(ChatMessage(
                id: "local-error",
                role: .error,
                text: localError,
                createdAt: Date().timeIntervalSince1970
            ))
        }
        if let pendingOutgoing {
            let persisted = pendingOutgoing.executionStatus == "sent" && (detail?.turns ?? []).contains { turn in
                (pendingOutgoing.sourceTurnID == nil
                    ? (turn.startedAt ?? 0) >= (pendingOutgoing.createdAt ?? 0) - 30
                    : turn.id == pendingOutgoing.sourceTurnID)
                    && (turn.items ?? []).contains {
                        $0.type == "userMessage"
                            && (pendingOutgoing.sourceTurnID != nil || $0.renderedText == pendingOutgoing.text)
                    }
            }
            if !persisted { result.append(pendingOutgoing) }
        }
        result.append(contentsOf: systemMessages.filter { $0.threadID == nil || $0.threadID == selectedThreadID })
        // New turns can be absent even when older turns are already loaded.
        let turnIDs = Set((detail?.turns ?? []).map(\.id))
        result.append(contentsOf: liveMessages.filter { !turnIDs.contains(liveMessageTurnIDs[$0.id] ?? "") })
        // Turn order and semantic placement are authoritative. Compact process
        // headers intentionally have no item timestamps until details are fetched.
        let ordered = mergeSemanticExecutionItems(result)

        // SwiftUI's ForEach requires IDs to be unique. A compact snapshot and
        // a live item can occasionally carry the same fallback ID while a
        // turn is being replaced, causing rows to disappear or go blank.
        var usedIDs = Set<String>()
        return ordered.enumerated().map { index, message in
            guard usedIDs.contains(message.id) else {
                usedIDs.insert(message.id)
                return message
            }
            var unique = message
            var candidate = "\(message.id)-duplicate-\(index)"
            var suffix = 1
            while usedIDs.contains(candidate) {
                candidate = "\(message.id)-duplicate-\(index)-\(suffix)"
                suffix += 1
            }
            unique.id = candidate
            usedIDs.insert(candidate)
            return unique
        }
    }

    private func rebuildRenderedMessages(invalidateInFlight: Bool = true) {
        scheduleCacheCheckpoint()
        renderedMessagesRebuildTask?.cancel()
        renderedMessagesRebuildTask = nil
        if invalidateInFlight { renderEpoch += 1 }
        renderRequestID += 1
        let previous = Dictionary(uniqueKeysWithValues: renderedMessages.map { ($0.id, $0) })
        let next = buildMessages().map { reuseMarkdown($0, previous: previous[$0.id]) }
        if !next.contains(where: needsMarkdown) {
            pendingRender = nil
            publishedRenderID = renderRequestID
            if renderedMessages != next { renderedMessages = next }
            if isPreparingInitialMessages { isPreparingInitialMessages = false }
            return
        }
        // Sending must remain immediate even while an older assistant reply is being prepared.
        if let outgoing = pendingOutgoing, next.contains(where: { $0.id == outgoing.id }) {
            if let index = renderedMessages.firstIndex(where: { $0.id == outgoing.id }) {
                if renderedMessages[index] != outgoing { renderedMessages[index] = outgoing }
            } else {
                renderedMessages.append(outgoing)
            }
        }
        pendingRender = (renderEpoch, renderRequestID, next)
        if renderedMessages.isEmpty && !isPreparingInitialMessages { isPreparingInitialMessages = true }
        guard renderPreparationTask == nil else { return }
        renderPreparationTask = Task { [weak self] in
            while let self, let request = self.pendingRender {
                self.pendingRender = nil
                var prepared: [ChatMessage] = []
                for message in request.messages {
                    guard !Task.isCancelled, self.renderEpoch == request.epoch else { break }
                    prepared.append(await self.prepareMarkdown(message))
                }
                guard !Task.isCancelled else { return }
                if self.renderEpoch == request.epoch && request.id > self.publishedRenderID {
                    self.publishedRenderID = request.id
                    if self.renderedMessages != prepared { self.renderedMessages = prepared }
                    if self.isPreparingInitialMessages { self.isPreparingInitialMessages = false }
                }
            }
            self?.renderPreparationTask = nil
        }
    }

    private func needsMarkdown(_ message: ChatMessage) -> Bool {
        ((!message.text.isEmpty && (message.role == .assistant || message.role == .processSummary)) && message.markdown == nil)
            || (message.processItems?.contains {
                (expandedProcessIDs.contains(message.id) || chatDetails.mustKeep($0)) && needsMarkdown($0)
            } ?? false)
    }

    private func reuseMarkdown(_ message: ChatMessage, previous: ChatMessage?) -> ChatMessage {
        var result = message
        if previous?.text == message.text && previous?.role == message.role { result.markdown = previous?.markdown }
        if let items = message.processItems {
            let previousItems = Dictionary((previous?.processItems ?? []).map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            result.processItems = items.map { reuseMarkdown($0, previous: previousItems[$0.id]) }
        }
        return result
    }

    private func prepareMarkdown(_ message: ChatMessage) async -> ChatMessage {
        var result = message
        if !message.text.isEmpty && (message.role == .assistant || message.role == .processSummary) && message.markdown == nil {
            result.markdown = try? await MarkdownRenderer.shared.prepare(message.text)
        }
        if let items = message.processItems {
            var prepared: [ChatMessage] = []
            for item in items {
                prepared.append(expandedProcessIDs.contains(message.id) || chatDetails.mustKeep(item)
                    ? await prepareMarkdown(item) : item)
            }
            result.processItems = prepared
        }
        return result
    }

    private func scheduleRenderedMessagesRebuild() {
        guard renderedMessagesRebuildTask == nil else { return }
        renderedMessagesRebuildTask = Task { [weak self] in
            // Throttle, not debounce: continuous tokens must not postpone publication.
            try? await Task.sleep(for: .milliseconds(60))
            guard !Task.isCancelled else { return }
            self?.rebuildRenderedMessages(invalidateInFlight: false)
        }
    }

    private func timelineMessage(from item: TurnItem, turnID: String, fallbackIndex: Int) -> ChatMessage? {
        if let attachments = item.attachments, !attachments.isEmpty {
            return ChatMessage(id: item.id ?? "\(turnID)-images-\(fallbackIndex)", role: .assistant,
                               text: item.renderedText, createdAt: item.createdAt, sourceTurnID: turnID, attachments: attachments)
        }
        if item.isCompressed {
            return ChatMessage(
                id: item.id ?? "\(turnID)-compressed-\(fallbackIndex)",
                role: .compressed,
                text: item.renderedText.isEmpty ? cloudexLocalized("上下文已压缩") : item.renderedText,
                createdAt: item.createdAt,
                isCompressed: true
            )
        }
        if item.type == "thinking" || item.type == "reasoning" {
            return ChatMessage(
                id: item.id ?? "\(turnID)-thinking-\(fallbackIndex)",
                role: .execution,
                text: item.renderedText,
                executionStatus: item.status,
                executionKind: "thinking",
                createdAt: item.createdAt
            )
        }
        if item.type == "commandExecution" || item.command != nil || item.activity == "edited" || item.diff != nil {
            let command = item.command?.trimmingCharacters(in: .whitespacesAndNewlines)
            let execution = command.map { semanticExecution(command: $0, activity: item.activity, status: item.status) }
            let text = item.activity == "edited"
                ? editSummary(from: item.diff) ?? execution?.text ?? "Edited files"
                : execution?.text ?? item.renderedText
            let kind = execution?.kind ?? (item.activity == "edited" ? "edit" : "run")
            return ChatMessage(
                id: item.id ?? "\(turnID)-command-\(fallbackIndex)",
                role: .execution,
                text: text,
                executionStatus: item.status,
                executionDuration: DateFormatting.wholeSecondDuration(from: item.duration),
                executionExitCode: item.exitCode,
                executionKind: kind,
                editDiff: item.diff,
                createdAt: item.createdAt
            )
        }
        guard item.type == "userMessage" || item.type == "agentMessage" else { return nil }
        if item.type == "agentMessage", shouldHidePersistedLiveMessage(item, turnID: turnID) { return nil }
        let presentation = item.type == "userMessage"
            ? userMessagePresentation(for: item)
            : (text: item.renderedText, attachments: [MessageAttachment]())
        guard !presentation.text.isEmpty || !presentation.attachments.isEmpty else { return nil }
        return ChatMessage(
            id: item.id ?? "\(turnID)-\(item.type)-\(fallbackIndex)",
            role: item.type == "userMessage" ? .user : .assistant,
            text: presentation.text,
            createdAt: item.createdAt,
            sourceTurnID: turnID,
            phase: item.phase,
            attachments: presentation.attachments
        )
    }

    private func userMessagePresentation(for item: TurnItem) -> (text: String, attachments: [MessageAttachment]) {
        let source = item.renderedText
        var attachments: [MessageAttachment] = []

        func appendAttachment(name: String?, path: String?, image: Bool) {
            let trimmedPath = path?.trimmingCharacters(in: .whitespacesAndNewlines)
            let fileName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedName: String = {
                if let fileName, !fileName.isEmpty { return fileName }
                guard let trimmedPath, !trimmedPath.isEmpty else { return image ? "图片" : "文件" }
                if let url = URL(string: trimmedPath), url.isFileURL, !url.lastPathComponent.isEmpty {
                    return url.lastPathComponent
                }
                let lastPathComponent = (trimmedPath as NSString).lastPathComponent
                return lastPathComponent.isEmpty ? trimmedPath : lastPathComponent
            }()
            let kind: MessageAttachment.Kind = image || Self.isImagePath(trimmedPath ?? resolvedName) ? .image : .file
            let attachment = MessageAttachment(name: resolvedName, path: trimmedPath, kind: kind)
            guard !attachments.contains(where: { $0.id == attachment.id }) else { return }
            attachments.append(attachment)
        }

        for part in item.content ?? [] {
            let type = (part.type ?? "").lowercased()
            let candidate = part.path ?? part.url
            let isImage = type.contains("image") || (part.mimeType?.lowercased().hasPrefix("image/") ?? false)
            let isFile = type.contains("file") || type.contains("document") || candidate != nil
            if isImage || isFile {
                appendAttachment(name: part.name ?? part.filename, path: candidate, image: isImage)
            }
        }

        for match in Self.captureMatches(in: source, pattern: #"\[Attached local file:\s*([^\]]+)\]"#) {
            appendAttachment(name: nil, path: match, image: false)
        }
        for match in Self.captureMatches(in: source, pattern: #"(?m)^\s*##\s*(.+?)\s*:\s*((?:/|~|[A-Za-z]:[\\/]).+?)\s*$"#, group: 2) {
            appendAttachment(name: nil, path: match, image: false)
        }
        for match in Self.captureMatches(in: source, pattern: #"<image\b[^>]*\bpath=\"([^\"]+)\"[^>]*>"#) {
            appendAttachment(name: nil, path: match, image: true)
        }

        var text = source
        for tag in ["in-app-browser-context", "browser-context", "environment_context", "app-context", "skills_instructions", "permissions instructions", "collaboration_mode"] {
            let escaped = NSRegularExpression.escapedPattern(for: tag)
            text = text.replacingOccurrences(
                of: "(?is)<\(escaped)\\b[^>]*>.*?</\(escaped)\\s*>",
                with: "",
                options: .regularExpression
            )
        }
        text = text.replacingOccurrences(of: #"\[Attached local file:\s*[^\]]+\]"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s*<image\b[^>]*>\s*$"#, with: "", options: .regularExpression)

        let visibleLines = text.components(separatedBy: .newlines).filter { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return true }
            if trimmed.range(of: #"^#*\s*files mentioned by (?:the )?user\s*:?$"#, options: [.regularExpression, .caseInsensitive]) != nil {
                return false
            }
            if trimmed.range(of: #"^#*\s*my request(?: for codex)?\s*[:：]?$"#, options: [.regularExpression, .caseInsensitive]) != nil {
                return false
            }
            if trimmed.range(of: #"^##\s*.+?\s*:\s*(?:/|~|[A-Za-z]:[\\/]).+$"#, options: .regularExpression) != nil {
                return false
            }
            return !trimmed.localizedCaseInsensitiveContains("in-app-browser-context")
        }

        text = visibleLines.joined(separator: "\n")
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (text, attachments)
    }

    private static func captureMatches(in source: String, pattern: String, group: Int = 1) -> [String] {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(source.startIndex..., in: source)
        return expression.matches(in: source, range: range).compactMap { match in
            guard match.numberOfRanges > group,
                  let range = Range(match.range(at: group), in: source) else { return nil }
            return String(source[range])
        }
    }

    private static func isImagePath(_ value: String) -> Bool {
        ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff"]
            .contains((value as NSString).pathExtension.lowercased())
    }

    private func taskDurationMessage(for turn: CloudexTurn) -> ChatMessage? {
        guard turn.status != nil && turn.status != "inProgress" else { return nil }
        let duration = DateFormatting.duration(fromMilliseconds: turn.durationMs)
            .nilIfEmpty
            ?? DateFormatting.duration(fromSeconds: durationSeconds(for: turn)).nilIfEmpty
        guard let duration else { return nil }
        let statusText: String
        switch turn.status {
        case "failed": statusText = cloudexLocalized("任务失败")
        case "interrupted": statusText = cloudexLocalized("任务已中断")
        case "cancelled", "canceled": statusText = cloudexLocalized("任务已取消")
        default: statusText = cloudexLocalized("任务完成")
        }
        return ChatMessage(
            id: "\(turn.id)-duration",
            role: .taskSummary,
            text: cloudexLocalized("%@ · 用时 %@", statusText, duration),
            createdAt: (turn.completedAt ?? turn.startedAt).map { $0 + 0.0001 }
        )
    }

    private func compressedMessage(for turn: CloudexTurn) -> ChatMessage? {
        guard turn.compressed == true || turn.itemsView == "compressed" else { return nil }
        return ChatMessage(
            id: "\(turn.id)-compressed",
            role: .compressed,
            text: cloudexLocalized("上下文已压缩"),
            createdAt: turn.completedAt ?? turn.startedAt,
            isCompressed: true
        )
    }

    private func durationSeconds(for turn: CloudexTurn) -> Double? {
        guard let startedAt = turn.startedAt,
              let completedAt = turn.completedAt,
              completedAt >= startedAt else { return nil }
        return completedAt - startedAt
    }

    private func semanticExecution(command: String, activity: String?, status: String?) -> (text: String, kind: String) {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        if let operation = abstractOperationDisplay(from: trimmed) {
            return operation
        }
        if let readTargets = readTargets(from: trimmed) {
            return ("Read \(joinedTargets(readTargets))", "read")
        }
        if let search = searchDisplay(from: trimmed) {
            return ("Search \(search.query) in \(joinedTargets(search.targets))", "search")
        }
        if activity == "approval" {
            return (trimmed, "approval")
        }
        if activity == "edited" {
            return ("Edited \(editedDisplay(from: trimmed))", "edit")
        }
        if activity == "explored" {
            return ("Explored \(joinedTargets(fileTargets(from: trimmed), fallback: trimmed))", "explore")
        }
        return ("\(status == "inProgress" ? "Running" : "Ran") \(unwrappedShellCommand(trimmed))", "run")
    }

    private func editedDisplay(from command: String) -> String {
        if command.contains("\n") { return command }
        return joinedTargets(fileTargets(from: command), fallback: command)
    }

    private func readTargets(from command: String) -> [String]? {
        guard containsCommand(command, names: ["read", "sed", "cat", "head", "tail"]) else { return nil }
        let targets = fileTargets(from: command)
        return targets.isEmpty ? ["files"] : targets
    }

    private func abstractOperationDisplay(from command: String) -> (text: String, kind: String)? {
        let tokens = semanticCommandTokens(command)
        guard let operation = tokens.first?.lowercased(), ["browse", "search"].contains(operation) else { return nil }
        let value = tokens.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return (operation == "browse" ? "Browse web" : "Search workspace", operation) }
        return ("\(operation == "browse" ? "Browse" : "Search") \(value)", operation)
    }

    private func searchDisplay(from command: String) -> (query: String, targets: [String])? {
        let searchCommands = Set(["rg", "grep", "find", "fd"])
        let tokens = semanticCommandTokens(command)
        guard let commandIndex = tokens.firstIndex(where: {
            searchCommands.contains(($0 as NSString).lastPathComponent.lowercased())
        }) else { return nil }

        let commandName = (tokens[commandIndex] as NSString).lastPathComponent.lowercased()
        let arguments = Array(tokens.dropFirst(commandIndex + 1))
        var query: String?
        var pathTokens: [String] = []

        if commandName == "find" {
            var index = 0
            while index < arguments.count {
                let token = arguments[index]
                if ["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"].contains(token),
                   index + 1 < arguments.count {
                    query = arguments[index + 1]
                    index += 2
                    continue
                }
                if !token.hasPrefix("-") && query == nil {
                    pathTokens.append(token)
                }
                index += 1
            }
        } else {
            let optionsWithValue = Set([
                "-f", "--file", "-g", "--glob", "-t", "--type", "--type-add",
                "-m", "--max-count", "-A", "-B", "-C", "--after-context",
                "--before-context", "--context", "--encoding", "--engine"
            ])
            var index = 0
            while index < arguments.count {
                let token = arguments[index]
                if ["-e", "--regexp"].contains(token), index + 1 < arguments.count {
                    query = arguments[index + 1]
                    index += 2
                    continue
                }
                if optionsWithValue.contains(token) {
                    index += min(2, arguments.count - index)
                    continue
                }
                if token.hasPrefix("-") {
                    index += 1
                    continue
                }
                if query == nil {
                    query = token
                } else {
                    pathTokens.append(token)
                }
                index += 1
            }
        }

        let cleanedQuery = query?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let cleanedQuery, !cleanedQuery.isEmpty else { return nil }
        let targets = displayTargets(from: pathTokens)
        return (cleanedQuery, targets.isEmpty ? ["workspace"] : targets)
    }

    private func semanticCommandTokens(_ command: String) -> [String] {
        let tokens = shellLikeTokens(command)
        let shells = Set(["sh", "bash", "zsh", "fish"])
        guard let first = tokens.first,
              shells.contains((first as NSString).lastPathComponent.lowercased()),
              let commandFlagIndex = tokens.firstIndex(where: { $0 == "-c" || $0 == "-lc" }),
              commandFlagIndex + 1 < tokens.count else { return tokens }
        return shellLikeTokens(tokens[commandFlagIndex + 1])
    }

    private func unwrappedShellCommand(_ command: String) -> String {
        let tokens = shellLikeTokens(command)
        let shells = Set(["sh", "bash", "zsh", "fish"])
        guard let first = tokens.first,
              shells.contains((first as NSString).lastPathComponent.lowercased()),
              let commandFlagIndex = tokens.firstIndex(where: { $0 == "-c" || $0 == "-lc" }),
              commandFlagIndex + 1 < tokens.count else { return command }
        return tokens.dropFirst(commandFlagIndex + 1).joined(separator: " ")
    }

    private func displayTargets(from tokens: [String]) -> [String] {
        tokens.reduce(into: [String]()) { result, token in
            let cleaned = token.trimmingCharacters(in: CharacterSet(charactersIn: ","))
            guard !cleaned.isEmpty else { return }
            let display: String
            if cleaned == "." || cleaned == "./" {
                display = "workspace"
            } else {
                let name = (cleaned as NSString).lastPathComponent
                display = name.isEmpty ? cleaned : name
            }
            if !result.contains(display) { result.append(display) }
        }
    }

    private func containsCommand(_ command: String, names: [String]) -> Bool {
        let escaped = names.map { NSRegularExpression.escapedPattern(for: $0) }.joined(separator: "|")
        let pattern = "(?:^|[;&|()]\\s*|\\b)(?:" + escaped + ")(?:\\s|$)"
        return command.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private func firstCommandName(_ command: String) -> String {
        let sanitized = command.replacingOccurrences(of: #"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\S+)\s+)*"#, with: "", options: .regularExpression)
        let tokens = shellLikeTokens(sanitized)
        guard let first = tokens.first else { return "" }
        let name = (first as NSString).lastPathComponent
        return name.lowercased()
    }

    private func fileTargets(from command: String) -> [String] {
        let tokens = semanticCommandTokens(command)
        let ignoredCommands = Set(["read", "sed", "cat", "head", "tail", "rg", "grep", "find", "fd", "git", "ps", "aux", "ls", "pwd", "wc", "stat", "which", "sh", "bash", "zsh", "fish", "env"])
        let ignoredOptionArguments = Set(["-n", "-e", "-f", "-m", "-A", "-B", "-C", "--max-count", "--after-context", "--before-context", "--context", "--glob", "-g", "--type", "-t"])
        var values: [String] = []
        var skipNext = false
        for token in tokens {
            if skipNext {
                skipNext = false
                continue
            }
            if ignoredOptionArguments.contains(token) {
                skipNext = true
                continue
            }
            if token.hasPrefix("-") { continue }
            let bare = token.trimmingCharacters(in: CharacterSet(charactersIn: ","))
            if bare.isEmpty { continue }
            let executableName = (bare as NSString).lastPathComponent.lowercased()
            if ignoredCommands.contains(bare.lowercased()) || ignoredCommands.contains(executableName) { continue }
            if bare.range(of: #"^\d+,\d+p$"#, options: .regularExpression) != nil { continue }
            if bare.range(of: #"^\d+p$"#, options: .regularExpression) != nil { continue }
            if bare.contains("/") || bare.contains(".") {
                let name = (bare as NSString).lastPathComponent
                if !name.isEmpty && !values.contains(name) { values.append(name) }
            }
        }
        return values
    }

    private func shellLikeTokens(_ command: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var quote: Character?
        var escaped = false
        for character in command {
            if escaped {
                current.append(character)
                escaped = false
                continue
            }
            if character == "\\" {
                escaped = true
                continue
            }
            if let activeQuote = quote {
                if character == activeQuote {
                    quote = nil
                } else {
                    current.append(character)
                }
                continue
            }
            if character == "'" || character == "\"" {
                quote = character
                continue
            }
            if character.isWhitespace || character == "|" || character == ";" || character == "&" {
                if !current.isEmpty {
                    tokens.append(current)
                    current = ""
                }
                continue
            }
            current.append(character)
        }
        if !current.isEmpty { tokens.append(current) }
        return tokens
    }

    private func joinedTargets(_ targets: [String], fallback: String? = nil) -> String {
        let cleaned = targets
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let unique = cleaned.reduce(into: [String]()) { result, value in
            if !result.contains(value) { result.append(value) }
        }
        let values = unique.isEmpty ? fallback.map { [$0] } ?? [] : unique
        guard !values.isEmpty else { return "" }
        if values.count <= 4 { return values.joined(separator: ", ") }
        return "\(values.prefix(3).joined(separator: ", ")) and \(values.count - 3) more"
    }

    private func mergeSemanticExecutionItems(_ items: [ChatMessage]) -> [ChatMessage] {
        // Preserve every fine-grained execution item. Time-bucket merging made
        // rapid live Read/Search events collapse across intervening messages,
        // which looked like missing commands and also changed their order.
        items
    }

    private func mergedExecutionItem(_ first: ChatMessage, with second: ChatMessage, kind: String) -> ChatMessage {
        let prefix = kind == "read" ? "Read " : "Search "
        let targets = (targetsText(from: first.text, prefix: prefix) + targetsText(from: second.text, prefix: prefix))
            .reduce(into: [String]()) { result, value in
                if !result.contains(value) { result.append(value) }
            }
        let status = first.executionStatus == "failed" || second.executionStatus == "failed"
            ? "failed"
            : (first.executionStatus == "inProgress" || second.executionStatus == "inProgress" ? "inProgress" : first.executionStatus ?? second.executionStatus)
        return ChatMessage(
            id: "\(first.id)-merged-\(second.id)",
            role: .execution,
            text: "\(prefix)\(joinedTargets(targets))",
            executionStatus: status,
            executionDuration: first.executionDuration ?? second.executionDuration,
            executionExitCode: first.executionExitCode ?? second.executionExitCode,
            executionKind: kind,
            createdAt: minTimestamp(first.createdAt, second.createdAt)
        )
    }

    private func targetsText(from text: String, prefix: String) -> [String] {
        guard text.hasPrefix(prefix) else { return [] }
        return text.dropFirst(prefix.count)
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private func minTimestamp(_ first: Double?, _ second: Double?) -> Double? {
        switch (first, second) {
        case let (left?, right?): return min(left, right)
        case let (left?, nil): return left
        case let (nil, right?): return right
        case (nil, nil): return nil
        }
    }

    private func processSummaryText(_ taskSummary: String?) -> String {
        guard let taskSummary, !taskSummary.isEmpty else { return cloudexLocalized("查看过程") }
        return cloudexLocalized("查看过程 · %@", taskSummary)
    }

    private func shouldHidePersistedLiveMessage(_ item: TurnItem, turnID: String) -> Bool {
        guard !liveMessages.isEmpty else { return false }
        if let id = item.id, liveMessages.contains(where: { $0.id == id }) { return true }
        let persisted = normalizedMessageText(item.renderedText)
        guard !persisted.isEmpty else { return false }
        return liveMessages.contains { message in
            guard liveMessageTurnIDs[message.id] == turnID else { return false }
            let streaming = normalizedMessageText(message.text)
            return !streaming.isEmpty && (streaming == persisted || streaming.hasPrefix(persisted))
        }
    }

    private func normalizedMessageText(_ value: String) -> String {
        value.replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func nextLiveCreatedAt() -> Double {
        liveOrderingClock = max(Date().timeIntervalSince1970, liveOrderingClock + 0.000_001)
        return liveOrderingClock
    }

    private func liveTurnID(
        from params: [String: Any],
        item: [String: Any]? = nil,
        threadID: String
    ) -> String? {
        params["turnId"] as? String
            ?? (params["turn"] as? [String: Any])?["id"] as? String
            ?? item?["turnId"] as? String
            ?? activeTurnNotificationKeys[threadID]
    }

    private func liveText(from item: [String: Any]?) -> String {
        guard let item else { return "" }
        if let text = item["text"] as? String, !text.isEmpty { return text }
        if let message = item["message"] as? String, !message.isEmpty { return message }
        if let summary = item["summary"] as? [String], !summary.isEmpty { return summary.joined(separator: "\n\n") }
        if let content = item["content"] as? [String] { return content.joined(separator: "\n\n") }
        guard let content = item["content"] as? [[String: Any]] else { return "" }
        return content.compactMap { part in
            part["text"] as? String ?? part["value"] as? String
        }.joined()
    }

    private func isCompactionSummary(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.range(
            of: #"^(?:#+\s*|\*\*)?handoff summary\b"#,
            options: [.regularExpression, .caseInsensitive]
        ) != nil
    }

    private func isCompactionItem(_ item: [String: Any]) -> Bool {
        let type = (item["type"] as? String ?? "").lowercased()
        return type.contains("compact") || type.contains("compress")
    }

    private func recordLiveCompaction(turnID: String?) {
        liveMessages.removeAll { message in
            guard message.role == .assistant, isCompactionSummary(message.text) else { return false }
            suppressedCompactionMessageIDs.insert(message.id)
            liveMessageTurnIDs.removeValue(forKey: message.id)
            return true
        }
        guard let turnID else { return }
        let id = "\(turnID)-live-compacted"
        guard !liveMessages.contains(where: { $0.id == id }) else { return }
        liveMessageTurnIDs[id] = turnID
        liveMessages.append(ChatMessage(
            id: id,
            role: .compressed,
            text: cloudexLocalized("上下文已压缩"),
            createdAt: nextLiveCreatedAt(),
            isCompressed: true
        ))
    }

    private func beginLiveMessage(id: String, turnID: String?, text: String = "", phase: String? = nil, authoritative: Bool = false) {
        if threadStreamReplaying { replayedMessageText[id] = text }
        if isCompactionSummary(text) {
            suppressedCompactionMessageIDs.insert(id)
            liveMessages.removeAll { $0.id == id }
            liveMessageTurnIDs.removeValue(forKey: id)
            return
        }
        guard !suppressedCompactionMessageIDs.contains(id) else { return }
        liveMessageTurnIDs[id] = turnID
        if let index = liveMessages.firstIndex(where: { $0.id == id }) {
            let previous = liveMessages[index]
            // Replaying from item/started must not blank a restored partial reply.
            if threadStreamReplaying && !authoritative && previous.text.hasPrefix(text) {
                if let phase { liveMessages[index].phase = phase }
                return
            }
            liveMessages[index] = ChatMessage(id: id, role: .assistant, text: text, createdAt: previous.createdAt,
                sourceTurnID: turnID, phase: phase ?? previous.phase)
        } else {
            if threadStreamReplaying, !authoritative,
               let persisted = detail?.turns.flatMap({ $0.items ?? [] }).first(where: { $0.id == id }),
               persisted.renderedText.hasPrefix(text) { return }
            liveMessages.append(ChatMessage(id: id, role: .assistant, text: text, createdAt: nextLiveCreatedAt(), sourceTurnID: turnID, phase: phase))
        }
    }

    private func appendLiveDelta(id: String, turnID: String?, delta: String) {
        guard !suppressedCompactionMessageIDs.contains(id) else { return }
        if threadStreamReplaying && !threadReplayIsIncremental {
            // The server retains only 250 events: a replay may start midway
            // through an item. A suffix is not a replacement for its full text.
            guard let previous = replayedMessageText[id] else { replayNeedsRefresh = true; return }
            let text = previous + delta
            beginLiveMessage(id: id, turnID: turnID, text: text)
            return
        }
        let persistedText = detail?.turns.flatMap { $0.items ?? [] }.first { $0.id == id }?.renderedText ?? ""
        let combinedText = (liveMessages.first(where: { $0.id == id })?.text ?? persistedText) + delta
        if isCompactionSummary(combinedText) {
            suppressedCompactionMessageIDs.insert(id)
            liveMessages.removeAll { $0.id == id }
            liveMessageTurnIDs.removeValue(forKey: id)
            return
        }
        liveMessageTurnIDs[id] = turnID
        if let index = liveMessages.firstIndex(where: { $0.id == id }) {
            let previous = liveMessages[index]
            liveMessages[index] = ChatMessage(id: id, role: .assistant, text: previous.text + delta, createdAt: previous.createdAt,
                sourceTurnID: turnID, phase: previous.phase)
        } else {
            liveMessages.append(ChatMessage(id: id, role: .assistant, text: combinedText, createdAt: nextLiveCreatedAt(), sourceTurnID: turnID))
        }
    }

    private func liveEditDiff(from item: [String: Any]) -> [EditDiffPayload]? {
        if let existing = item["diff"] as? [[String: Any]] {
            let decoded = existing.compactMap { payload -> EditDiffPayload? in
                guard let name = payload["name"] as? String else { return nil }
                let lines = (payload["lines"] as? [[String: Any]] ?? []).compactMap { line -> EditDiffLinePayload? in
                    guard let kind = line["kind"] as? String,
                          let text = line["text"] as? String else { return nil }
                    return EditDiffLinePayload(kind: kind, text: text, lineNumber: (line["lineNumber"] as? NSNumber)?.intValue)
                }
                return EditDiffPayload(
                    name: name,
                    additions: (payload["additions"] as? NSNumber)?.intValue,
                    deletions: (payload["deletions"] as? NSNumber)?.intValue,
                    lines: lines.isEmpty ? nil : lines
                )
            }
            if !decoded.isEmpty { return decoded }
        }
        guard let changes = item["changes"] as? [[String: Any]] else { return nil }
        let payloads = changes.compactMap { change -> EditDiffPayload? in
            guard let name = editPath(from: change) else { return nil }
            let diff = change["diff"] as? String
            var oldLine = 1
            var newLine = 1
            var additions = 0
            var deletions = 0
            var lines: [EditDiffLinePayload] = []
            for raw in (diff ?? "").replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
                if raw.hasPrefix("@@") {
                    lines.append(EditDiffLinePayload(kind: "header", text: raw.trimmingCharacters(in: .whitespaces), lineNumber: nil))
                    let ranges = raw.split(whereSeparator: { $0.isWhitespace })
                    if ranges.count >= 3 {
                        oldLine = Int(ranges[1].dropFirst().split(separator: ",").first ?? "1") ?? oldLine
                        newLine = Int(ranges[2].dropFirst().split(separator: ",").first ?? "1") ?? newLine
                    }
                    continue
                }
                if raw.hasPrefix("+++") || raw.hasPrefix("---") { continue }
                if raw.hasPrefix("+") {
                    lines.append(EditDiffLinePayload(kind: "addition", text: String(raw.dropFirst()), lineNumber: newLine))
                    additions += 1
                    newLine += 1
                } else if raw.hasPrefix("-") {
                    lines.append(EditDiffLinePayload(kind: "deletion", text: String(raw.dropFirst()), lineNumber: oldLine))
                    deletions += 1
                    oldLine += 1
                } else if raw.hasPrefix(" ") {
                    lines.append(EditDiffLinePayload(kind: "context", text: String(raw.dropFirst()), lineNumber: newLine))
                    oldLine += 1
                    newLine += 1
                }
            }
            if lines.isEmpty {
                additions = editCount(from: change, keys: ["additions", "added", "addedLines", "insertions"])
                deletions = editCount(from: change, keys: ["deletions", "deleted", "deletedLines", "removals"])
            }
            guard !lines.isEmpty || additions > 0 || deletions > 0 else { return nil }
            return EditDiffPayload(name: name, additions: additions, deletions: deletions, lines: lines)
        }
        return payloads.isEmpty ? nil : payloads
    }

    private func editSummary(from payloads: [EditDiffPayload]?) -> String? {
        let summaries = (payloads ?? []).compactMap { payload -> String? in
            let name = editDisplayName(payload.name)
            guard !name.isEmpty else { return nil }
            let additions = payload.additions ?? payload.lines?.filter { $0.kind == "addition" }.count ?? 0
            let deletions = payload.deletions ?? payload.lines?.filter { $0.kind == "deletion" }.count ?? 0
            return "\(name) +\(additions) -\(deletions)"
        }
        return summaries.isEmpty ? nil : summaries.joined(separator: "\n")
    }

    private func editPath(from change: [String: Any]) -> String? {
        ["path", "filePath", "relativePath", "name", "file"]
            .compactMap { change[$0] as? String }
            .first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func editCount(from change: [String: Any], keys: [String]) -> Int {
        for key in keys {
            if let value = change[key] as? NSNumber { return max(value.intValue, 0) }
            if let value = change[key] as? Int { return max(value, 0) }
        }
        return 0
    }

    private func editDisplayName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return (trimmed as NSString).lastPathComponent
    }

    private func upsertLiveExecution(
        item: [String: Any],
        fallbackID: String? = nil,
        turnID: String?,
        status: String
    ) {
        guard let id = item["id"] as? String ?? fallbackID else { return }
        let type = (item["type"] as? String ?? "").lowercased()
        let activity = item["activity"] as? String
            ?? (type.contains("filechange") ? "edited" : type == "reasoning" ? "thinking" : nil)
        let changedPaths = (item["changes"] as? [[String: Any]] ?? []).compactMap { change in
            editPath(from: change)
        }
        let existingIndex = liveMessages.firstIndex(where: { $0.id == id })
        let previous = existingIndex.map { liveMessages[$0] }
        let editDiff = activity == "edited" ? liveEditDiff(from: item) : nil
        let editText = activity == "edited" ? editSummary(from: editDiff) : nil
        // Codex uses different payload shapes for shell exploration and file
        // edits. Edits may not have a command at all, so do not discard them.
        let rawCommand = (item["command"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? (item["path"] as? String)
            ?? (!changedPaths.isEmpty ? changedPaths.joined(separator: ", ") : nil)
        let rawText = liveText(from: item).trimmingCharacters(in: .whitespacesAndNewlines)
        let execution = rawCommand.map { semanticExecution(command: $0, activity: activity, status: status) }
        let duration: String? = {
            guard let milliseconds = (item["durationMs"] as? NSNumber)?.doubleValue else { return nil }
            return DateFormatting.duration(fromMilliseconds: milliseconds)
        }()
        let createdAt = existingIndex.flatMap { liveMessages[$0].createdAt } ?? nextLiveCreatedAt()
        let message = ChatMessage(
            id: id,
            role: .execution,
            text: editText
                ?? execution?.text
                ?? (activity == "thinking" ? rawText : nil)
                ?? previous?.text
                ?? (activity == "edited" ? "Edited files" : activity == "explored" ? "Explored workspace" : "Ran tool"),
            executionStatus: status,
            executionDuration: duration ?? previous?.executionDuration,
            executionExitCode: (item["exitCode"] as? NSNumber)?.intValue ?? previous?.executionExitCode,
            executionKind: execution?.kind ?? previous?.executionKind ?? (activity == "edited" ? "edit" : activity == "thinking" ? "thinking" : "run"),
            editDiff: editDiff ?? previous?.editDiff,
            createdAt: createdAt
        )
        liveMessageTurnIDs[id] = turnID
        if let index = existingIndex {
            liveMessages[index] = message
        } else {
            liveMessages.append(message)
        }
    }

    private func isLiveExecutionItem(_ item: [String: Any]) -> Bool {
        let type = (item["type"] as? String ?? "").lowercased()
        return type == "commandexecution"
            || type.contains("commandexecution")
            || type == "thinking"
            || type == "reasoning"
            || type.contains("thinking")
            || type.contains("filechange")
            || type.contains("toolcall")
            || item["command"] != nil
            || item["activity"] != nil
            || item["diff"] != nil
    }

    private func clearLiveMessages() {
        liveMessages = []
        liveMessageTurnIDs = [:]
        suppressedCompactionMessageIDs = []
        liveOrderingClock = 0
        replayedMessageText = [:]
        replayNeedsRefresh = false
        rebuildRenderedMessages()
    }

    private func removePersistedLiveMessages(from result: ThreadDetail, authoritative: Bool = false) {
        let turnIDs = Set(result.turns.map(\.id))
        liveMessages.removeAll { message in
            if authoritative, result.hasMoreBefore == false,
               let turnID = liveMessageTurnIDs[message.id], !turnIDs.contains(turnID) {
                liveMessageTurnIDs.removeValue(forKey: message.id)
                return true
            }
            guard message.role == .assistant,
                  let turn = result.turns.first(where: { $0.id == liveMessageTurnIDs[message.id] }),
                  let item = (turn.items ?? []).first(where: { $0.type == "agentMessage" && $0.id == message.id }) else { return false }
            let incoming = normalizedMessageText(item.renderedText)
            let displayed = normalizedMessageText(message.text)
            // Same ID or terminal status alone does not acknowledge the displayed text.
            // Accept extensions and genuine edits; reject a stale, shorter prefix.
            if incoming == displayed || !displayed.hasPrefix(incoming) || (authoritative && !isTurnInProgress(turn)) {
                liveMessageTurnIDs.removeValue(forKey: message.id)
                return true
            }
            return false
        }
    }

    private func scheduleCacheCheckpoint() {
        guard cacheCheckpointTask == nil else { return }
        cacheCheckpointTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self else { return }
            self.checkpointConversation()
        }
    }

    private func checkpointConversation() {
        cacheCheckpointTask?.cancel()
        cacheCheckpointTask = nil
        guard initialCacheLoadGeneration == nil else { return }
        guard let threadID = selectedThreadID, let detail, detail.thread.id == threadID,
              !detail.turns.isEmpty || !liveMessages.isEmpty || pendingOutgoing?.executionStatus == "sent" else { return }
        let snapshot = CachedThreadDetail(
            threadID: threadID, detail: searchReturnDetail ?? ThreadDetail(thread: detail.thread, turns: cachedOlderTurns + detail.turns,
                hasMoreBefore: detail.hasMoreBefore, nextBefore: detail.nextBefore), savedAt: 0,
            liveMessages: liveMessages, liveMessageTurnIDs: liveMessageTurnIDs,
            pendingOutgoing: pendingOutgoing?.executionStatus == "sent" ? pendingOutgoing : nil,
            liveRunning: liveRunning
        )
        guard snapshot != lastCachedConversation else { return }
        lastCachedConversation = snapshot
        conversationCache.saveThread(snapshot, profileID: selectedServerProfileID ?? "default")
    }

    private func restoreConversation(_ snapshot: CachedThreadDetail) {
        liveMessageTurnIDs = snapshot.liveMessageTurnIDs ?? [:]
        liveMessages = snapshot.liveMessages ?? []
        pendingOutgoing = snapshot.pendingOutgoing
        liveRunning = snapshot.liveRunning ?? snapshot.detail.thread.isActive
        cachedOlderTurns = Array(snapshot.detail.turns.dropLast(12))
        detail = ThreadDetail(thread: snapshot.detail.thread, turns: Array(snapshot.detail.turns.suffix(12)),
            hasMoreBefore: snapshot.detail.hasMoreBefore, nextBefore: snapshot.detail.nextBefore)
        rebuildMessageIndex(from: snapshot.detail, threadID: snapshot.threadID)
    }

    #if DEBUG
    private var uiFixtureStreamTask: Task<Void, Never>?
    private var uiCachePage: ThreadDetail?
    private var uiCacheReadDelay: Duration = .zero
    private var uiPageDelay: Duration = .zero
    private var uiSubmitResult: Task<Data, Error>?
    private var uiProcessAttempts = 0
    private var uiPageReads = 0

    // Runs the real disk queue, navigation/restore, reconciliation and render paths.
    // Only the HTTP page is substituted; no Codex sessions or real host connections.
    private func runCacheRegression() async {
        let wire = Data("\u{FEFF}: heartbeat\r\nid: 7\r\nevent: notification\r\ndata: 你好\r\ndata:  spaced \r\n\r\nevent:\rdata:\r\ndata: done\n\n".utf8)
        for boundary in 0...wire.count {
            let parser = SSEParser()
            let events = parser.append(wire.prefix(boundary)) + parser.append(wire.suffix(wire.count - boundary))
            precondition(events.count == 2 && events[0].id == "7" && events[0].name == "notification")
            precondition(String(decoding: events[0].data, as: UTF8.self) == "你好\n spaced ", "SSE chunking changed text")
            precondition(events[1].id == nil && events[1].name == "message"
                         && String(decoding: events[1].data, as: UTF8.self) == "\ndone")
        }
        let byteParser = SSEParser()
        precondition(wire.flatMap { byteParser.append(Data([$0])) }.count == 2, "Byte-split CRLF or UTF-8 lost an event")
        SSEClient.checkReconnectIsolation()
        await AttachmentImageCache.checkDiskRestore()
        for invalidURL in ["file:///tmp", "ftp://host", "http:///", "http://host?token=x", "host:8890"] {
            precondition((try? APIClient(serverURL: invalidURL, token: "").makeURL(path: "/api/projects")) == nil)
        }
        precondition(try! APIClient(serverURL: "https://host:8890/base/", token: "")
            .makeURL(path: "/api/projects").absoluteString == "https://host:8890/base/api/projects")
        let nativeData = Data(#"{"thread":{"id":"native"},"turns":[{"id":"native-turn","status":"completed","items":[{"type":"userMessage","id":"native-user","content":[{"type":"text","text":"question"},{"type":"future","value":{"new":true}}]},{"type":"reasoning","id":"native-reasoning","summary":["summary"],"content":["raw block"]},{"type":"futureTool","id":"future","text":{"new":true},"content":{"new":true}},{"type":"imageArtifact","id":"native-file","attachments":[{"name":"result.audio","path":"/result.audio","kind":"audio"}]},{"type":"plan","id":"native-plan","text":"Final plan"}]}]}"#.utf8)
        let native = try! JSONDecoder().decode(ThreadDetail.self, from: nativeData)
        let nativeItems = native.turns[0].items!
        precondition(nativeItems[0].renderedText == "question" && nativeItems[1].renderedText == "summary")
        precondition(nativeItems[1].content?.first?.text == "raw block", "Native reasoning invalidated the thread")
        precondition(nativeItems[3].attachments?.first?.kind == .file && nativeItems[4].type == "agentMessage")
        precondition(nativeItems[4].phase == "final_answer")
        precondition(timelineMessage(from: nativeItems[1], turnID: "native-turn", fallbackIndex: 1)?.executionKind == "thinking")
        let defaults = UserDefaults(suiteName: "cloudex-detail-regression")!
        defer { defaults.removePersistentDomain(forName: "cloudex-detail-regression") }
        defaults.removePersistentDomain(forName: "cloudex-detail-regression")
        let quiet = ChatDetailPreferences.load(from: defaults)
        let all = ChatDetailPreferences(process: true, thinking: true, tools: true, progress: true, statistics: true)
        let rows: [ChatMessage] = [
            .init(id: "user", role: .user, text: "question"),
            .init(id: "thinking", role: .execution, text: "summary", executionKind: "thinking"),
            .init(id: "tool", role: .execution, text: "pwd", executionKind: "run"),
            .init(id: "progress", role: .assistant, text: "checking", phase: "commentary"),
            .init(id: "final", role: .assistant, text: "answer", phase: "final_answer"),
            .init(id: "legacy", role: .assistant, text: "legacy answer"),
            .init(id: "failure", role: .execution, text: "failed command", executionStatus: "failed"),
            .init(id: "error", role: .error, text: "connection lost"),
            .init(id: "file", role: .assistant, text: "[file](result.md)", phase: "commentary"),
            .init(id: "duration", role: .taskSummary, text: "12s")
        ]
        precondition(quiet.visibleMessages(rows).map(\.id) == ["user", "final", "legacy", "failure", "error", "file"])
        precondition(all.visibleMessages(rows) == rows)
        for field in [\ChatDetailPreferences.thinking, \.tools, \.progress, \.statistics] {
            var single = quiet; single[keyPath: field] = true
            precondition(single.visibleMessages(rows).count == quiet.visibleMessages(rows).count + 1)
        }
        let artifact = MessageAttachment(name: "image", path: "/result.png", kind: .image)
        let process = ChatMessage(id: "process", role: .processSummary, text: "process",
            processItems: rows.filter { !["user", "final", "legacy"].contains($0.id) }, attachments: [artifact])
        var hidden = quiet; hidden.process = false
        let kept = hidden.visibleMessages([rows[0], process, rows[4]])
        precondition(kept.map(\.id) == ["user", "process", "failure", "error", "file", "final"])
        precondition(kept[1].attachments == [artifact])
        precondition(quiet.visibleMessages([process]) == [process])
        let preparedProcess = await prepareMarkdown(process)
        precondition(preparedProcess.processItems?.first(where: { $0.id == "file" })?.markdown != nil,
                     "Links must remain rendered when the process entry is hidden")
        defaults.set(try! JSONEncoder().encode(all), forKey: ChatDetailPreferences.storageKey)
        precondition(ChatDetailPreferences.load(from: defaults) == all)
        let commentary = TurnItem(type: "agentMessage", id: "commentary", text: "progress", content: nil,
            command: nil, activity: nil, status: nil, exitCode: nil, duration: nil, phase: "commentary", createdAt: nil, compressed: nil, diff: nil)
        precondition(timelineMessage(from: commentary, turnID: "test", fallbackIndex: 0)?.phase == "commentary")
        let parsed = try! MarkdownParser.prepare("Before\n\n![图](picture.png)\n\n[文档](guide.md)\n\n```md\n![literal](ignored.png)\n```")
        precondition(parsed.blocks.filter { if case .image = $0.content { return true }; return false }.count == 1)
        precondition(FilePreviewRequest.resolve(URL(string: "images/a%20b.png")!, root: "/workspace") == "/workspace/images/a b.png")
        precondition(FilePreviewRequest.resolve(URL(string: "/workspace/test.swift:12")!, root: "/elsewhere") == "/workspace/test.swift")
        precondition(FilePreviewRequest.resolve(URL(string: "https://example.com")!, root: "/workspace") == nil)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cloudex-cache-check-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = LocalConversationCache(rootURL: root)
        cache.saveThread(.init(threadID: "native", detail: native, savedAt: 0), profileID: "native-test")
        await cache.flush()
        let nativeRestore = cache.loadThread(threadID: "native", profileID: "native-test")!
        precondition(nativeRestore.detail.turns[0].items?.contains { $0.id == "native-file" } == true,
                     "Offline compaction lost a tool attachment")
        precondition(nativeRestore.detail.turns[0].items?.last?.text == "Final plan")
        let model = AppViewModel(conversationCache: cache)
        model.selectedServerProfileID = "cache-test-host"
        model.selectedThreadID = "native"
        let hierarchy = try! JSONDecoder().decode(CloudexThread.self, from: Data(#"{"id":"parent","subagents":[{"id":"child","parentThreadId":"parent","agentNickname":"Worker","agentStatus":"interrupted","canAcceptDirectInput":false,"subagents":[{"id":"nested","parentThreadId":"child","agentStatus":"closed"}]}]}"#.utf8))
        precondition(hierarchy.descendants.count == 2 && hierarchy.descendant(withID: "nested")?.agentActivity == "closed")
        precondition(hierarchy.subagents?.first?.agentActivity == "interrupted", "Interrupted or closed agents must not be marked completed")
        let cachedProjects = [CloudexProject(id: "hierarchy", name: "Hierarchy", cwd: "/hierarchy", threads: [hierarchy], updatedAt: nil)]
        try! JSONEncoder().encode(cachedProjects).write(to: root.appendingPathComponent("projects-hierarchy-test.json"))
        precondition(cache.loadProjects(profileID: "hierarchy-test") == nil, "Legacy flat project snapshots must be refreshed on upgrade")
        cache.saveProjects(cachedProjects, profileID: "hierarchy-test")
        await cache.flush()
        precondition(cache.loadProjects(profileID: "hierarchy-test")?.first?.threads.first?.descendants.count == 2,
                     "Offline project snapshots must retain the subagent tree")
        let protectedKeys = ["cloudex.draft", "cloudex.pendingSteerDraft", "cloudex.agentProvider", "cloudex.serverURL", "cloudex.lanServerURL", "cloudex.tailscaleServerURL", "cloudex.connectionMode", "cloudex.authToken", "cloudex.serverProfiles", ChatDetailPreferences.storageKey]
        let protectedValues = protectedKeys.map { UserDefaults.standard.object(forKey: $0) as? NSObject }
        let parentDraft = model.draft
        let reader = AppViewModel(conversationCache: cache, readOnlyParent: model)
        reader.selectedThreadID = "child"
        reader.detail = ThreadDetail(thread: hierarchy.subagents!.first!, turns: [])
        reader.draft = "reader draft"
        reader.pendingSteerDraft = "reader steer"
        reader.chatDetails = all
        let readerSent = await reader.submitPrompt("must not send", steering: false)
        let readerForked = await reader.forkThread(threadID: "child", turnID: "turn", position: "through", editedMessage: nil)
        await reader.changeQueue("pause")
        await reader.stop()
        reader.closeReadOnlyViewer()
        precondition(!readerSent && !readerForked && model.selectedThreadID == "native" && model.draft == parentDraft)
        precondition(protectedKeys.map { UserDefaults.standard.object(forKey: $0) as? NSObject } == protectedValues,
                     "Inspecting a subagent changed the parent's persisted composer or settings")
        func nativeEvent(_ method: String, _ params: [String: Any]) {
            let data = try! JSONSerialization.data(withJSONObject: ["method": method, "params": params])
            model.handleThreadEvent(SSEEvent(id: nil, name: "notification", data: data), expectedThreadID: model.selectedThreadID ?? "native")
        }
        nativeEvent("item/started", ["turnId": "native-turn", "item": ["id": "live-plan", "type": "plan", "text": "Draft"]])
        nativeEvent("item/plan/delta", ["turnId": "native-turn", "itemId": "live-plan", "delta": " continuation"])
        precondition(model.liveMessages.last?.text == "Draft continuation")
        nativeEvent("item/completed", ["turnId": "native-turn", "item": ["id": "live-plan", "type": "plan", "text": "Authoritative plan"]])
        precondition(model.liveMessages.last?.text == "Authoritative plan" && model.liveMessages.last?.phase == "final_answer")
        model.threadStreamReplaying = true
        nativeEvent("item/completed", ["turnId": "native-turn", "item": ["id": "live-plan", "type": "plan", "text": "Authoritative"]])
        precondition(model.liveMessages.last?.text == "Authoritative", "Final plan must replace a longer draft during replay")
        model.threadStreamReplaying = false
        model.startNewChat()
        let outbox = AppViewModel(conversationCache: cache)
        outbox.selectedServerProfileID = "queue-test-\(UUID())"
        outbox.selectedThreadID = "queue-a"
        let queueKey = outbox.queueStorageKey
        defer { UserDefaults.standard.removeObject(forKey: queueKey) }
        let recoverPayload = try! JSONSerialization.data(withJSONObject: ["message": "recover text", "files": [["path": "/recovered.png"]]])
        UserDefaults.standard.set(try! JSONEncoder().encode([LocalQueueDraft(id: "recover-local", payload: recoverPayload)]), forKey: queueKey)
        outbox.recoverLocalQueueDraft(id: "recover-local")
        outbox.recoverLocalQueueDraft(id: "recover-local")
        precondition(outbox.attachedFiles.map(\.path) == ["/recovered.png"], "Recovering an outbox draft must restore attachments once")
        UserDefaults.standard.removeObject(forKey: queueKey)
        let queued = QueuedMessage(id: "queue-1", body: .init(message: "one", collaborationMode: "plan"), status: "pending")
        outbox.acceptQueue(.init(paused: true, items: [queued], revision: 2), key: queueKey)
        outbox.acceptQueue(.init(paused: false, items: [], revision: 1), key: queueKey)
        precondition(outbox.queueItems == [queued] && outbox.queuePaused, "Slow HTTP must not overwrite newer queue events")
        outbox.collaborationMode = "plan"
        outbox.selectedThreadID = "queue-b"
        outbox.acceptQueue(.init(paused: true, items: [queued], revision: 3), key: queueKey)
        precondition(outbox.queueItems.isEmpty && outbox.collaborationMode == "default", "Old queue/mode leaked across conversations")
        outbox.selectedThreadID = nil
        outbox.draft = "preserve before thread creation"
        outbox.queueSteerDraft()
        precondition(!outbox.draft.isEmpty && outbox.localError != nil, "Queue before thread creation must keep draft and explain")
        func page(_ text: String, revision: Int = 1, state: String = "completed", turnID: String = "t1",
                  syncRevision: String? = nil) -> ThreadDetail {
            var threadFields: [String: Any] = ["id": "cache-test", "name": "缓存回归", "updatedAt": revision]
            if let syncRevision { threadFields["syncRevision"] = syncRevision }
            let object: [String: Any] = [
                "thread": threadFields,
                "turns": [["id": turnID, "status": state, "items": [
                    ["id": "answer-\(turnID)", "type": "agentMessage", "text": text, "phase": "final_answer"]
                ]]], "hasMoreBefore": true, "nextBefore": "older-cursor"
            ]
            return try! JSONDecoder().decode(ThreadDetail.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let old = page("旧回复")
        let original = page("完整但已被修正的回复", revision: 5, syncRevision: "file-a")
        let correction = page("完整", revision: 5, syncRevision: "file-b")
        precondition(mergingLatestPage(correction, into: original).turns[0].items?.last?.renderedText == "完整",
                     "A same-mtime rewrite retained an outdated longer reply")
        let backdated = page("新的权威回复", revision: 1, syncRevision: "file-c")
        precondition(mergingLatestPage(backdated, into: original).thread.syncRevision == "file-c",
                     "A changed file revision was rejected only because its timestamp moved backwards")
        let priorHistory = ThreadDetail(thread: original.thread,
            turns: original.turns + page("已删除的旧轮次", turnID: "deleted").turns, hasMoreBefore: false)
        let replacedHistory = ThreadDetail(thread: correction.thread, turns: correction.turns, hasMoreBefore: false)
        precondition(mergingLatestPage(replacedHistory, into: priorHistory).turns.map(\.id) == correction.turns.map(\.id),
                     "A complete replacement revision retained deleted turns")
        model.uiCachePage = old
        await model.openThread(old.thread, projectCWD: nil)
        model.threadStreamReplaying = false
        model.liveRunning = true
        var runningPublications = 0
        let runningObservation = model.$liveRunning.sink { _ in runningPublications += 1 }
        for index in 0..<100 {
            nativeEvent("item/agentMessage/delta", ["itemId": "burst", "turnId": "burst-turn", "delta": "\(index),"])
        }
        runningObservation.cancel()
        precondition(runningPublications == 1, "Repeated tokens bypassed the render throttle through liveRunning")
        model.beginLiveMessage(id: "resume", turnID: "resume-turn", text: "Before")
        model.lastThreadEventID = 6
        model.handleThreadEvent(SSEEvent(id: nil, name: "replay-start", data: Data(#"{"resumed":true}"#.utf8)),
                                expectedThreadID: old.thread.id)
        let suffix = try! JSONSerialization.data(withJSONObject: ["method": "item/agentMessage/delta",
            "params": ["itemId": "resume", "turnId": "resume-turn", "delta": " after reconnect"]])
        let resumed = SSEEvent(id: "epoch:7", name: "notification", data: suffix)
        model.handleThreadEvent(resumed, expectedThreadID: old.thread.id)
        model.handleThreadEvent(resumed, expectedThreadID: old.thread.id)
        model.handleThreadEvent(SSEEvent(id: "epoch:7", name: "replay-complete",
            data: Data(#"{"latestEventId":"epoch:7"}"#.utf8)), expectedThreadID: old.thread.id)
        precondition(model.liveMessages.first { $0.id == "resume" }?.text == "Before after reconnect",
                     "Reconnect suffix replay lost or duplicated deltas")
        precondition(!model.threadStreamReplaying, "Replay-complete sharing the last event ID was dropped")
        model.handleThreadEvent(SSEEvent(id: nil, name: "replay-start", data: Data(#"{"resetRequired":true}"#.utf8)),
                                expectedThreadID: old.thread.id)
        model.handleThreadEvent(SSEEvent(id: "new-epoch:1", name: "replay-complete",
            data: Data(#"{"resetRequired":true,"latestEventId":"new-epoch:1"}"#.utf8)), expectedThreadID: old.thread.id)
        precondition(model.lastThreadEventID == 1 && !model.threadStreamReplaying,
                     "Controller restart must reset the event sequence")
        model.cancelDetailRead()
        model.clearLiveMessages()
        model.liveRunning = false
        model.startNewChat()
        model.uiCachePage = old
        await model.openThread(old.thread, projectCWD: nil)
        model.beginLiveMessage(id: "answer-t2", turnID: "t2", text: "最新回复：已经显示")
        model.pendingOutgoing = ChatMessage(id: "outgoing-test", role: .user, text: "刚刚发出的提问",
            executionStatus: "sent", sourceTurnID: "t2",
            attachments: [MessageAttachment(name: "图.png", path: "/image.png", kind: .image)])
        model.rebuildRenderedMessages()
        await model.renderPreparationTask?.value
        precondition(model.messages.contains { $0.text == "最新回复：已经显示" }, "Missing turn must display live content")

        // Leave before the terminal HTTP reload, reopen offline, then read with a new cache instance.
        model.startNewChat()
        model.uiCachePage = nil
        await model.openThread(old.thread, projectCWD: nil)
        await model.renderPreparationTask?.value
        precondition(model.messages.contains { $0.text == "最新回复：已经显示" }, "Immediate reopen regressed")
        precondition(model.pendingOutgoing?.attachments.count == 1)
        await cache.flush()
        let coldCache = LocalConversationCache(rootURL: root)
        let cold = AppViewModel(conversationCache: coldCache)
        cold.selectedServerProfileID = "cache-test-host"
        await cold.openThread(old.thread, projectCWD: nil)
        await cold.renderPreparationTask?.value
        precondition(cold.messages.contains { $0.text == "最新回复：已经显示" }, "Cold disk restore regressed")
        precondition(cold.pendingOutgoing?.executionStatus == "sent")
        precondition(coldCache.loadThread(threadID: old.thread.id, profileID: "different-host") == nil)

        cold.uiCachePage = page("最新回复：", state: "inProgress", turnID: "t2")
        await cold.loadThread(old.thread.id, force: true)
        await cold.renderPreparationTask?.value
        precondition(cold.messages.contains { $0.text == "最新回复：已经显示" }, "Short HTTP snapshot erased live text")
        cold.threadStreamReplaying = true
        cold.beginLiveMessage(id: "answer-t2", turnID: "t2")
        cold.appendLiveDelta(id: "answer-t2", turnID: "t2", delta: "最新回复：")
        cold.rebuildRenderedMessages()
        await cold.renderPreparationTask?.value
        precondition(cold.messages.contains { $0.text == "最新回复：已经显示" }, "SSE replay regressed restored text")
        cold.appendLiveDelta(id: "answer-t2", turnID: "t2", delta: "已经显示")
        cold.replayedMessageText = [:]
        cold.appendLiveDelta(id: "answer-t2", turnID: "t2", delta: "不完整的重放尾部")
        precondition(cold.liveMessages.last?.text == "最新回复：已经显示", "Truncated replay replaced the full message")
        cold.threadStreamReplaying = false
        cold.uiCachePage = page("最新回复：已经显示", revision: 2, turnID: "t2")
        await cold.loadThread(old.thread.id, force: true)
        await cold.renderPreparationTask?.value
        precondition(cold.liveMessages.isEmpty, "Matching snapshot must acknowledge overlay")
        precondition(cold.messages.filter { $0.id == "answer-t2" }.count == 1, "Duplicate final reply")
        cold.appendLiveDelta(id: "answer-t2", turnID: "t2", delta: "，继续")
        precondition(cold.liveMessages.last?.text == "最新回复：已经显示，继续", "Delta must use acknowledged baseline")
        cold.uiCachePage = page("修改后的最终回复", revision: 3, turnID: "t2")
        await cold.loadThread(old.thread.id, force: true)
        await cold.renderPreparationTask?.value
        precondition(cold.messages.contains { $0.text == "修改后的最终回复" }, "Completed correction ignored")
        cold.uiCachePage = old
        await cold.loadThread(old.thread.id, force: true)
        precondition(cold.detail?.thread.updatedAt == 3, "Old HTTP revision replaced newer snapshot")
        cold.started = true
        cold.uiCachePage = page("前台恢复后的最新回复", revision: 4, turnID: "t2")
        await cold.resumeFromForeground()
        precondition(cold.detail?.turns.last?.items?.last?.renderedText == "前台恢复后的最新回复",
                     "Foreground must revalidate completed conversations")
        let lagging = page("旧回复", revision: 4)
        let retained = cold.mergingLatestPage(lagging, into: cold.detail)
        precondition(retained.turns.map(\.id) == ["t1", "t2"], "Missing latest turn must not reorder history")
        cold.beginLiveMessage(id: "commentary-t2", turnID: "t2", text: "中间分析", phase: "commentary")
        cold.rebuildRenderedMessages()
        await cold.renderPreparationTask?.value
        precondition(!cold.messages.contains { $0.text == "中间分析" }, "Restored commentary must stay folded")
        precondition(cold.messages.contains { $0.processItems?.contains { $0.text == "中间分析" } == true })

        // Acknowledged-only persistence; incomplete sends must not reappear as sent.
        cold.pendingOutgoing = ChatMessage(id: "unacknowledged", role: .user, text: "发送中", executionStatus: "sending")
        cold.suspendForBackground()
        await coldCache.flush()
        let saved = coldCache.loadThread(threadID: old.thread.id, profileID: "cache-test-host")!
        precondition(saved.pendingOutgoing == nil)
        precondition(saved.detail.turns.count == 2, "Latest-page save discarded loaded history")
        precondition(saved.detail.nextBefore == "older-cursor")
        precondition(saved.liveMessages?.first?.phase == "commentary")

        // Serial writes must retain the newest enqueue even after large earlier snapshots.
        for revision in 0..<30 {
            let value = page(String(repeating: "缓存", count: revision == 0 ? 100_000 : revision + 1), revision: revision)
            coldCache.saveThread(CachedThreadDetail(threadID: old.thread.id, detail: value, savedAt: Double(revision)),
                                profileID: "queue-check")
        }
        await coldCache.flush()
        let disk = LocalConversationCache(rootURL: root)
        precondition(disk.loadThread(threadID: old.thread.id, profileID: "queue-check")?.detail.thread.updatedAt == 29)

        let compactTurns: [[String: Any]] = (0..<36).map { index in
            var user: [String: Any] = ["id": "user-\(index)", "type": "userMessage",
                "content": [["type": "text", "text": "问题 \(index)"]]]
            var answer: [String: Any] = ["id": "final-\(index)", "type": "agentMessage", "text": "回答 \(index)", "phase": "final_answer"]
            if index % 2 == 0 { user["createdAt"] = index * 2; answer["createdAt"] = index * 2 + 1 }
            return ["id": "compact-\(index)", "status": "completed", "items": [user, answer],
                    "processItemCount": 2, "detailsLoaded": false, "durationMs": 1000]
        }
        let turns = try! JSONDecoder().decode([CloudexTurn].self, from: JSONSerialization.data(withJSONObject: compactTurns))
        let full = ThreadDetail(thread: old.thread, turns: turns, hasMoreBefore: false, nextBefore: nil)
        let gap = AppViewModel(conversationCache: coldCache)
        gap.selectedServerProfileID = "gap-check"
        gap.selectedThreadID = old.thread.id
        gap.detail = full
        gap.cachedOlderTurns = Array(turns.prefix(24))
        let distantTurns = (100..<112).map { page("远端回答 \($0)", revision: 2, turnID: "distant-\($0)").turns[0] }
        let distant = ThreadDetail(thread: page("", revision: 2).thread, turns: distantTurns,
                                   hasMoreBefore: true, nextBefore: "gap-cursor")
        gap.acceptThreadPage(distant, threadID: old.thread.id)
        precondition(gap.detail?.turns.map(\.id) == distantTurns.map(\.id) && gap.cachedOlderTurns.isEmpty
                     && gap.detail?.hasMoreBefore == true && gap.detail?.nextBefore == "gap-cursor",
                     "A distant newer page hid the uncached history gap behind a stale complete-cache cursor")
        gap.cacheCheckpointTask?.cancel()
        cold.startNewChat()
        coldCache.saveThread(CachedThreadDetail(threadID: old.thread.id, detail: full, savedAt: 0), profileID: "cache-test-host")
        await coldCache.flush()
        cold.uiCachePage = nil
        await cold.openThread(old.thread, projectCWD: nil)
        precondition(cold.detail?.turns.count == 12 && cold.cachedOlderTurns.count == 24, "First cache page must be bounded")
        precondition(cold.messages.map(\.id) == (24..<36).flatMap { ["user-\($0)", "compact-\($0)-process-summary", "final-\($0)"] }, "Missing timestamps must not reorder turns")
        await cold.loadOlderTurns()
        precondition(cold.detail?.turns.count == 24 && cold.cachedOlderTurns.count == 12)
        await cold.loadOlderTurns()
        precondition(cold.detail?.turns.count == 36 && !cold.hasMoreHistory)
        cold.startNewChat()
        await coldCache.flush()
        cold.uiCacheReadDelay = .milliseconds(150)
        cold.uiCachePage = ThreadDetail(thread: old.thread, turns: Array(turns.suffix(12)))
        await cold.openThread(old.thread, projectCWD: nil)
        precondition(cold.detail?.turns.count == 12 && cold.cachedOlderTurns.count == 24, "Network winner must retain unrendered cache history")
        cold.startNewChat()
        cold.uiCacheReadDelay = .zero
        cold.uiPageDelay = .milliseconds(150)
        var visibleThenEmpty = false
        var visible = false
        let observation = cold.$renderedMessages.sink { messages in
            if visible && messages.isEmpty { visibleThenEmpty = true }
            if !messages.isEmpty { visible = true }
        }
        await cold.openThread(old.thread, projectCWD: nil)
        observation.cancel()
        precondition(visible && !visibleThenEmpty, "Background synchronization blanked first content")
        cold.uiPageDelay = .zero

        // An idle Desktop update arriving during HTTP must queue one follow-up read.
        cold.uiPageDelay = .milliseconds(150)
        cold.uiPageReads = 0
        let changed = SSEEvent(id: nil, name: "history/changed", data: Data("{}".utf8))
        cold.handleThreadEvent(changed, expectedThreadID: old.thread.id)
        let firstReload = cold.eventReloadTask
        while cold.uiPageReads == 0 { try? await Task.sleep(for: .milliseconds(5)) }
        cold.uiCachePage = page("会话实时更新", revision: 5, turnID: "t2")
        cold.handleThreadEvent(changed, expectedThreadID: old.thread.id)
        cold.handleThreadEvent(changed, expectedThreadID: old.thread.id)
        await firstReload?.value
        try? await Task.sleep(for: .milliseconds(220))
        await cold.renderPreparationTask?.value
        precondition(cold.uiPageReads == 2 && cold.messages.contains { $0.text == "会话实时更新" },
                     "History changes during an in-flight read must coalesce and then refresh")
        let staleRead = Task { await cold.loadThread(old.thread.id, force: true) }
        await Task.yield()
        cold.startNewChat()
        await staleRead.value
        precondition(cold.detail == nil && cold.detailPageTask == nil, "Navigation left the previous HTTP read alive")
        cold.uiPageDelay = .zero

        // Exercise the real submit callback, substituting only the transport result.
        cold.uiSubmitResult = Task { try await Task.sleep(for: .milliseconds(100)); throw URLError(.timedOut) }
        cold.isRefreshing = true
        let sending = Task { await cold.submitPrompt("发送中切换", steering: false) }
        await Task.yield()
        precondition(cold.isBusy && cold.pendingOutgoing?.text == "发送中切换", "Refresh must not block optimistic sending")
        cold.startNewChat()
        cold.draft = "另一会话的草稿"
        cold.localError = "另一会话的提示"
        _ = await sending.value
        precondition(cold.draft == "另一会话的草稿" && cold.localError == "另一会话的提示" && !cold.isBusy, "Old send mutated new conversation")
        cold.isRefreshing = false
        cold.uiSubmitResult = Task { throw URLError(.timedOut) }
        _ = await cold.submitPrompt("结果待确认", steering: false)
        precondition(cold.pendingOutgoing?.executionStatus == "unconfirmed", "Timeout must not imply failure or automatically resend")
        precondition(!cold.active, "A timed-out new conversation must not stay running without an ID")
        model.cacheCheckpointTask?.cancel()
        cold.cacheCheckpointTask?.cancel()
        await cache.flush()
        await coldCache.flush()
        projects = [CloudexProject(id: "cache-check", name: "缓存回归通过", cwd: "/cache-check", threads: [old.thread], updatedAt: nil)]
    }

    func startUIFixtureStream() {
        guard ProcessInfo.processInfo.arguments.contains("--ui-stream-fixture") else { return }
        uiFixtureStreamTask?.cancel()
        let thread = selectedThreadID
        liveRunning = true
        beginLiveMessage(id: "ui-stream", turnID: "ui-turn-5", text: "流式输出：")
        uiFixtureStreamTask = Task { [weak self] in
            for _ in 0..<500 {
                try? await Task.sleep(for: .milliseconds(10))
                guard !Task.isCancelled, let self, self.selectedThreadID == thread else { return }
                self.appendLiveDelta(id: "ui-stream", turnID: "ui-turn-5", delta: "文")
            }
            guard let self else { return }
            self.appendLiveDelta(id: "ui-stream", turnID: "ui-turn-5", delta: "终态已到达")
            self.liveRunning = false
        }
    }

    // In-memory UI regression data only; never creates Codex sessions or contacts a server.
    private func loadUIFixture(thread: CloudexThread? = nil) async {
        if thread == nil, !ProcessInfo.processInfo.arguments.contains("--ui-preserve-details") {
            chatDetails = ProcessInfo.processInfo.arguments.contains("--ui-all-details")
                ? ChatDetailPreferences(process: true, thinking: true, tools: true, progress: true, statistics: true)
                : ChatDetailPreferences()
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-queue-fixture") {
            serverURL = "http://127.0.0.1:18089"
        }
        isOpeningThread = true
        conversationLoadState = .loading
        defer { isOpeningThread = false }
        uiFixtureStreamTask?.cancel()
        clearLiveMessages()
        liveRunning = false
        selectedModelID = "gpt-6-sol"
        codexMode = .fullAccess
        isServerReachable = true
        let fixtureThreads = ["CV", "Calcu"].map { name in
            var root = CloudexThread(id: "ui-\(name)", name: "布局回归 \(name)", preview: "长文本与键盘布局",
                          cwd: "/ui/\(name)", status: nil, model: nil, createdAt: nil,
                          updatedAt: nil, usage: nil, provider: "codex")
            if name == "CV", ProcessInfo.processInfo.arguments.contains("--ui-subagents-fixture") {
                func agent(_ key: String, _ title: String, _ activity: String, parent: String = "ui-CV", children: [CloudexThread] = []) -> CloudexThread {
                    CloudexThread(id: "ui-agent-\(key)", name: title, preview: "检查 \(title) 的状态与详细过程",
                        cwd: "/ui/CV", status: ThreadStatus(type: activity == "active" ? "active" : "idle", activeFlags: []),
                        model: nil, createdAt: nil, updatedAt: nil, usage: nil, provider: "codex",
                        parentThreadId: parent, agentNickname: title, agentRole: "worker", agentStatus: activity,
                        threadSource: "subagent", canAcceptDirectInput: false, subagents: children)
                }
                root.subagents = [agent("research", "探索", "active", children: [agent("nested", "资料整理", "completed", parent: "ui-agent-research")]),
                                  agent("review", "复核", "completed"), agent("audit", "审计", "failed"), agent("stop", "中断检查", "interrupted")]
            }
            return root
        }
        if !isReadOnlyViewer {
            projects = fixtureThreads.map {
                CloudexProject(id: $0.id, name: String($0.id.dropFirst(3)), cwd: $0.cwd!, threads: [$0], updatedAt: nil)
            }
        }
        let scrollingFixture = ProcessInfo.processInfo.arguments.contains("--ui-scroll-fixture")
        if scrollingFixture {
            projects = projects.map { project in
                let threads = (0..<80).map { index in
                    CloudexThread(id: "\(project.id)-\(index)", name: "滚动回归 \(index)", preview: "历史会话",
                                  cwd: project.cwd, status: nil, model: nil, createdAt: nil,
                                  updatedAt: Double(1800000000 - index), usage: nil, provider: "codex")
                }
                return CloudexProject(id: project.id, name: project.name, cwd: project.cwd, threads: threads, updatedAt: nil)
            }
        }
        guard let thread else { draft = ""; conversationLoadState = .idle; return }
        selectedThreadID = thread.id
        selectedProjectCWD = thread.cwd
        var turns: [[String: Any]] = (0..<(scrollingFixture ? 36 : 6)).map { index -> [String: Any] in
            let items: [[String: Any]] = [
                ["type": "userMessage", "id": "ui-user-\(index)", "content": [["type": "text", "text": "检查第 \(index + 1) 轮消息"]]],
                ["type": "agentMessage", "id": "ui-answer-\(index)", "text": "这是用于检查布局的回复。\n\n**重点**：输入框增长时，聊天区域需要跟着缩小，文字不能穿过工具栏。\n\n附件、语音、模型和访问模式在同一行，长输入只在输入框内部滚动。" + (scrollingFixture ? "\n\n第 \(index) 轮 **Markdown**，`inline code` 与 [链接](https://example.com)。\n\n- 项目一\n- 项目二\n\n> 引用文本\n\n```swift\nlet count = \(index)\nprint(count)\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 更多内容 |" : "")]
            ]
            return ["id": "ui-turn-\(index)", "status": "completed", "items": items]
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-uneven-fixture") {
            turns = (0..<36).map { index in
                let text = index == 35 ? "这是实际的最后一条回复。" : String(repeating: "第 \(index) 轮：长短不一的历史消息，用于检查懒加载估算高度变化。\n\n", count: index % 3 == 0 ? 28 : 2)
                return ["id": "ui-turn-\(index)", "status": "completed", "items": [
                    ["type": "agentMessage", "id": "ui-answer-\(index)", "text": text]
                ]]
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-stream-fixture") {
            turns[5]["status"] = "inProgress"
            for index in turns.indices {
                var items = turns[index]["items"] as! [[String: Any]]
                for item in items.indices { items[item]["createdAt"] = Double(1700000000 + index * 2 + item) }
                turns[index]["items"] = items
            }
        }
        if thread.id == "ui-Calcu", ProcessInfo.processInfo.arguments.contains("--ui-empty-second-fixture") { turns = [] }
        if ProcessInfo.processInfo.arguments.contains("--ui-process-fixture") {
            for index in turns.indices {
                turns[index]["processItemCount"] = 2
                turns[index]["detailsLoaded"] = false
                turns[index]["durationMs"] = 12_000
                var items = turns[index]["items"] as! [[String: Any]]
                for item in items.indices { items[item]["createdAt"] = Double(1700000000 + index * 2 + item) }
                turns[index]["items"] = items
            }
            uiProcessAttempts = 0
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-preview-fixture") {
            serverURL = "http://127.0.0.1:18089"
            turns = [["id": "preview-turn", "status": "completed", "items": [
                ["type": "imageArtifact", "id": "process-image", "attachments": [["name": "过程图片", "path": "/ui/picture.png", "kind": "image"]]],
                ["type": "agentMessage", "id": "preview-answer", "text": "[查看实际界面截图](/ui/guide.md)\n\n![生成图片](/ui/picture.png)\n\n[HTML](/ui/page.html) · [GIF](/ui/animation.gif)"]
            ]]]
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-details-fixture") {
            turns = [["id": "details-turn", "status": "completed", "items": [
                ["type": "userMessage", "id": "details-user", "content": [["type": "text", "text": "显示设置回归"]]],
                ["type": "thinking", "id": "details-thinking", "text": "可选思考摘要"],
                ["type": "commandExecution", "id": "details-tool", "command": "pwd", "status": "completed"],
                ["type": "agentMessage", "id": "details-progress", "text": "可选中间进展", "phase": "commentary"],
                ["type": "agentMessage", "id": "details-answer", "text": "最终回答始终可见", "phase": "final_answer"]
            ]]]
            if ProcessInfo.processInfo.arguments.contains("--ui-details-active") {
                turns[0]["status"] = "inProgress"
            }
        }
        if thread.isSubagent, ProcessInfo.processInfo.arguments.contains("--ui-subagents-fixture") {
            turns = [["id": "\(thread.id)-turn", "status": thread.isActive ? "inProgress" : "completed", "itemsView": "full", "detailsLoaded": true, "processItemCount": 2,
                "items": [["type": "userMessage", "id": "\(thread.id)-user", "content": [["type": "text", "text": "子智能体任务：\(thread.agentTitle)"]]],
                          ["type": "thinking", "id": "\(thread.id)-thinking", "text": "子智能体思考摘要"],
                          ["type": "commandExecution", "id": "\(thread.id)-tool", "command": "pwd", "status": "completed", "aggregatedOutput": "子智能体工具详情"],
                          ["type": "agentMessage", "id": "\(thread.id)-answer", "text": "子智能体活动过程：\(thread.agentTitle)", "phase": thread.isActive ? "commentary" : "final_answer"]]]]
        }
        let data = try! JSONSerialization.data(withJSONObject: turns)
        // No real host access: the explicit preview fixture uses a loopback file-only server.
        let paginated = ProcessInfo.processInfo.arguments.contains("--ui-pagination-fixture")
        detail = ThreadDetail(thread: thread, turns: try! JSONDecoder().decode([CloudexTurn].self, from: data),
                              hasMoreBefore: paginated, nextBefore: paginated ? "ui-older" : nil)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 130))
        let image = renderer.image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 200, height: 130))
            ("截图缩略图" as NSString).draw(at: CGPoint(x: 20, y: 50), withAttributes: [.foregroundColor: UIColor.white, .font: UIFont.systemFont(ofSize: 24)])
        }
        _ = await AttachmentImageCache.prepare(image.pngData()!, path: "/ui-fixture.png", server: serverURL)
        attachedFiles = [RemoteFileEntry(name: "截图.png", path: "/ui-fixture.png", type: "file", size: nil, modifiedAt: nil, selectable: true)]
        await renderPreparationTask?.value
        conversationLoadState = .ready
        if ProcessInfo.processInfo.arguments.contains("--ui-queue-fixture") { liveRunning = true }
    }

    func completeUISubagentFixture() {
        guard !isReadOnlyViewer, ProcessInfo.processInfo.arguments.contains("--ui-subagents-fixture") else { return }
        projects = projects.map { project in
            var threads = project.threads
            for index in threads.indices {
                threads[index].subagents = threads[index].subagents?.map { child in
                    guard child.id == "ui-agent-research" else { return child }
                    return CloudexThread(id: child.id, name: child.name, preview: child.preview, cwd: child.cwd,
                        status: ThreadStatus(type: "idle", activeFlags: []), model: child.model,
                        createdAt: child.createdAt, updatedAt: child.updatedAt, usage: child.usage, provider: child.provider,
                        parentThreadId: child.parentThreadId, agentNickname: child.agentNickname, agentRole: child.agentRole,
                        agentStatus: "completed", threadSource: child.threadSource, canAcceptDirectInput: false, subagents: child.subagents)
                }
            }
            return CloudexProject(id: project.id, name: project.name, cwd: project.cwd, threads: threads, updatedAt: project.updatedAt)
        }
    }
    #endif

    func start() async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-cache-regression") { await runCacheRegression(); return }
        if ProcessInfo.processInfo.arguments.contains("--ui-fixture") { await loadUIFixture(); return }
        #endif
        guard !started else { return }
        started = true
        loadSharedInbox()
        startHealthMonitor()
        streamsStarted = true
        connectGlobalStream()
        await refresh()
    }

    func startReadOnlyViewer(_ thread: CloudexThread) async {
        guard isReadOnlyViewer else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-fixture") {
            await openThread(thread, projectCWD: thread.cwd)
            return
        }
        #endif
        started = true
        streamsStarted = true
        isForeground = true
        connectGlobalStream()
        startHealthMonitor()
        await openThread(thread, projectCWD: thread.cwd)
    }

    func closeReadOnlyViewer() {
        guard isReadOnlyViewer else { return }
        checkpointConversation()
        isForeground = false
        started = false
        streamsStarted = false
        connectionGeneration += 1
        threadOpenGeneration += 1
        cancelDetailRead()
        healthTask?.cancel()
        pollTask?.cancel()
        globalSSE.stop()
        threadSSE.stop()
    }

    func resumeFromForeground() async {
        isForeground = true
        guard started else { return }
        if !isReadOnlyViewer { loadSharedInbox() }
        if streamsStarted { connectGlobalStream() }
        let generation = connectionGeneration
        let openGeneration = threadOpenGeneration
        let threadID = selectedThreadID
        if let threadID {
            connectThreadStream(threadID: threadID)
            if active { startPolling(threadID: threadID) }
        }
        async let metadata: Void = refresh(synchronizeConversation: false)
        // Revalidate completed conversations too; metadata and replay are independent.
        if let threadID { await loadThread(threadID, force: true) }
        await metadata
        guard isForeground, generation == connectionGeneration, openGeneration == threadOpenGeneration else { return }
        if let threadID, active { startPolling(threadID: threadID) }
    }

    func suspendForBackground() {
        isForeground = false
        checkpointConversation()
        detailLoadGeneration += 1
        cancelDetailRead()
        // Let the serial disk queue finish before iOS suspends the process.
        var backgroundTask = UIBackgroundTaskIdentifier.invalid
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Save conversation") {
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
        }
        Task {
            await conversationCache.flush()
            if backgroundTask != .invalid {
                UIApplication.shared.endBackgroundTask(backgroundTask)
                backgroundTask = .invalid
            }
        }
        globalSSE.stop()
        threadSSE.stop()
        pollTask?.cancel()
        pollTask = nil
    }

    func applySettings(
        lanServerURL: String,
        tailscaleServerURL: String,
        connectionMode: ConnectionMode,
        token: String
    ) async {
        connectionGeneration += 1
        let generation = connectionGeneration
        threadOpenGeneration += 1
        detailLoadGeneration += 1
        olderTurnsLoadGeneration += 1
        initialCacheLoadGeneration = nil
        isLoadingOlderTurns = false
        cancelDetailRead()
        isOpeningThread = false
        self.lanServerURL = normalizedURL(lanServerURL)
        self.tailscaleServerURL = normalizedURL(tailscaleServerURL)
        self.connectionMode = connectionMode
        serverURL = connectionMode == .tailscale ? self.tailscaleServerURL : self.lanServerURL
        authToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        models = []
        modelsLoaded = false
        selectedEffortID = ""
        let defaults = UserDefaults.standard
        defaults.set(self.lanServerURL, forKey: "cloudex.serverURL")
        defaults.set(self.lanServerURL, forKey: "cloudex.lanServerURL")
        defaults.set(self.tailscaleServerURL, forKey: "cloudex.tailscaleServerURL")
        defaults.set(connectionMode.rawValue, forKey: "cloudex.connectionMode")
        defaults.set(authToken, forKey: "cloudex.authToken")
        saveConnectionHistory(serverURL: serverURL, token: authToken, mode: connectionMode)
        globalSSE.stop()
        threadSSE.stop()
        streamsStarted = true
        startHealthMonitor()
        connectGlobalStream()
        if let selectedThreadID { connectThreadStream(threadID: selectedThreadID) }
        await refresh()
        guard generation == connectionGeneration else { return }
    }

    func saveServerProfile(
        id: String?,
        name: String,
        lanURL: String,
        tailscaleURL: String,
        connectionMode: ConnectionMode,
        token: String
    ) async {
        let normalizedLAN = normalizedURL(lanURL)
        let normalizedTailscale = normalizedURL(tailscaleURL)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedLAN.isEmpty || !normalizedTailscale.isEmpty else { return }
        let existingID = id ?? UUID().uuidString
        let fallbackName = Self.serverName(for: normalizedLAN.isEmpty ? normalizedTailscale : normalizedLAN)
        let profile = ServerProfile(
            id: existingID,
            name: name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? fallbackName : name.trimmingCharacters(in: .whitespacesAndNewlines),
            lanURL: normalizedLAN,
            tailscaleURL: normalizedTailscale,
            token: trimmedToken,
            connectionMode: connectionMode
        )
        if let index = serverProfiles.firstIndex(where: { $0.id == existingID }) {
            serverProfiles[index] = profile
        } else {
            serverProfiles.append(profile)
        }
        persistServerProfiles()
        await switchToServerProfile(profile)
        Task { await refreshServerOverviews() }
    }

    func switchToServerProfile(_ profile: ServerProfile) async {
        let switching = selectedServerProfileID != profile.id
        if switching {
            resetConversationControls()
            checkpointConversation()
            connectionGeneration += 1
            initialCacheLoadGeneration = nil
            searchReturnDetail = nil
            cancelDetailRead()
            sendingRequestID = nil
            isBusy = false
            if let previousID = selectedServerProfileID {
                UserDefaults.standard.set(draft, forKey: "cloudex.draft.\(previousID)")
                UserDefaults.standard.set(pendingSteerDraft, forKey: "cloudex.pendingSteerDraft.\(previousID)")
            }
            threadOpenGeneration += 1
            detailLoadGeneration += 1
            selectedThreadID = nil
            selectedProjectCWD = nil
            detail = nil
            pendingOutgoing = nil
            clearLiveMessages()
            projects = []
            cachedOlderTurns = []
            lastCachedConversation = nil
            conversationLoadState = .idle
            liveRunning = false
            isCreatingNew = false
            attachedFiles = []
            threadSSE.stop()
            pollTask?.cancel()
            pollTask = nil
        }
        selectedServerProfileID = profile.id
        await restoreProjectsIfNeeded()
        guard selectedServerProfileID == profile.id else { return }
        UserDefaults.standard.set(profile.id, forKey: "cloudex.selectedServerProfileID")
        if switching {
            draft = UserDefaults.standard.string(forKey: "cloudex.draft.\(profile.id)") ?? ""
            pendingSteerDraft = UserDefaults.standard.string(forKey: "cloudex.pendingSteerDraft.\(profile.id)") ?? ""
        }
        await applySettings(
            lanServerURL: profile.lanURL,
            tailscaleServerURL: profile.tailscaleURL,
            connectionMode: profile.connectionMode,
            token: profile.token
        )
        if let index = serverProfiles.firstIndex(where: { $0.id == profile.id }) {
            serverProfiles[index].lastUsedAt = Date().timeIntervalSince1970
            persistServerProfiles()
        }
    }

    func loadSharedInbox() {
        pendingShares = CloudexShared.pendingItems()
    }

    func acceptSharedItem(_ item: SharedItem, thread: CloudexThread, project: CloudexProject,
                          profile: ServerProfile) async -> Bool {
        if selectedServerProfileID != profile.id { await switchToServerProfile(profile) }
        await openThread(thread, projectCWD: project.isNoProjectLike ? nil : project.cwd)
        if let imageName = item.imageName {
            guard let data = CloudexShared.imageData(for: item), !data.isEmpty,
                  await attachPhoneImage(data) else {
                status = "无法读取分享的图片：\(imageName)"
                return false
            }
        }
        let text = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { draft += (draft.isEmpty ? "" : "\n\n") + text }
        CloudexShared.remove(item)
        loadSharedInbox()
        return true
    }

    func deleteServerProfile(_ profile: ServerProfile) {
        overviewGeneration += 1
        serverProfiles.removeAll { $0.id == profile.id }
        serverOverviews.removeAll { $0.id == profile.id }
        persistServerProfiles()
        guard selectedServerProfileID == profile.id else { return }
        if let next = serverProfiles.first {
            Task { await switchToServerProfile(next) }
        } else {
            connectionGeneration += 1
            globalSSE.stop()
            suspendForBackground()
            selectedServerProfileID = nil
            UserDefaults.standard.removeObject(forKey: "cloudex.selectedServerProfileID")
            projects = []
            selectedThreadID = nil
            detail = nil
            draft = ""
            pendingSteerDraft = ""
        }
    }

    func switchToConnection(_ item: ConnectionHistoryItem) async {
        let lanURL = item.connectionMode == .tailscale ? lanServerURL : item.serverURL
        let tailscaleURL = item.connectionMode == .tailscale ? item.serverURL : tailscaleServerURL
        await applySettings(
            lanServerURL: lanURL,
            tailscaleServerURL: tailscaleURL,
            connectionMode: item.connectionMode,
            token: item.token
        )
    }

    func removeConnectionHistory(at offsets: IndexSet) {
        connectionHistory.remove(atOffsets: offsets)
        if let data = try? JSONEncoder().encode(connectionHistory) {
            UserDefaults.standard.set(data, forKey: "cloudex.connectionHistory")
        }
    }

    private func saveConnectionHistory(serverURL: String, token: String, mode: ConnectionMode) {
        let url = normalizedURL(serverURL)
        guard !url.isEmpty, !token.isEmpty else { return }
        var items = connectionHistory.filter { $0.serverURL != url || $0.token != token }
        items.append(ConnectionHistoryItem(serverURL: url, token: token, connectionMode: mode))
        items.sort { $0.lastUsedAt > $1.lastUsedAt }
        connectionHistory = Array(items.prefix(12))
        if let data = try? JSONEncoder().encode(connectionHistory) {
            UserDefaults.standard.set(data, forKey: "cloudex.connectionHistory")
        }
    }

    private static func loadConnectionHistory(defaults: UserDefaults) -> [ConnectionHistoryItem] {
        guard let data = defaults.data(forKey: "cloudex.connectionHistory"),
              let items = try? JSONDecoder().decode([ConnectionHistoryItem].self, from: data) else { return [] }
        return items.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    private static func loadServerProfiles(defaults: UserDefaults) -> [ServerProfile] {
        guard let data = defaults.data(forKey: "cloudex.serverProfiles"),
              let items = try? JSONDecoder().decode([ServerProfile].self, from: data) else { return [] }
        return items.sorted { $0.lastUsedAt > $1.lastUsedAt }
    }

    private func persistServerProfiles(defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(serverProfiles) {
            defaults.set(data, forKey: "cloudex.serverProfiles")
        }
    }

    private static func serverName(for url: String) -> String {
        guard let host = URL(string: url)?.host, !host.isEmpty else { return "Cloudex 服务器" }
        return host
    }

    func refresh(synchronizeConversation: Bool = true) async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-cache-regression") { return }
        #endif
        let generation = connectionGeneration
        guard refreshGeneration != generation else { return }
        refreshGeneration = generation
        isRefreshing = true
        defer {
            if refreshGeneration == generation { refreshGeneration = nil; isRefreshing = false }
        }
        do {
            let (available, response): (APIClient, ProjectsResponse) = try await APIClient.getFirstAvailable(
                "/api/projects", servers: connectionCandidates, token: authToken)
            guard !Task.isCancelled, generation == connectionGeneration else { return }
            activateConnection(available.serverURL)
            isServerReachable = true
            applyProjects(response.data)
            status = cloudexLocalized("已连接 · %@ · %@", activeConnectionTitle,
                                      Date().formatted(date: .omitted, time: .standard))
            Task { [weak self] in await self?.refreshPendingRequests(using: available, generation: generation) }
            if synchronizeConversation { await synchronizeSelectedThreadIfNeeded(from: response.data) }
        } catch {
            guard !Task.isCancelled, generation == connectionGeneration else { return }
            isServerReachable = false
            status = cloudexLocalized("连接失败：%@", error.localizedDescription)
        }
    }

    func reconnect() async {
        let generation = connectionGeneration
        globalSSE.stop()
        threadSSE.stop()
        streamsStarted = true
        connectGlobalStream()
        if let selectedThreadID { connectThreadStream(threadID: selectedThreadID) }
        await refresh()
        guard generation == connectionGeneration else { return }
    }

    func loadModelsIfNeeded(force: Bool = false) async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-fixture") || ProcessInfo.processInfo.arguments.contains("--ui-cache-regression") { return }
        #endif
        if modelsLoading { return }
        if modelsLoaded && !force { return }
        let generation = connectionGeneration
        modelsLoadingGeneration = generation
        defer { if modelsLoadingGeneration == generation { modelsLoadingGeneration = nil } }
        var lastError: Error?
        for candidate in connectionCandidates {
            do {
                let candidateClient = APIClient(serverURL: candidate, token: authToken)
                let response: ModelsResponse = try await candidateClient.get("/api/models")
                guard generation == connectionGeneration else { return }
                let visibleModels = response.data.filter { $0.hidden != true }
                models = visibleModels
                modelsLoaded = true
                activateConnection(candidate)
                let providerModels = visibleModels.filter { $0.agentProvider == selectedAgentProvider }
                let providerDefault = providerModels.first { $0.isDefault == true }
                let globalDefault = visibleModels.first { $0.isDefault == true }
                let fallbackModelID = providerDefault?.identifier
                    ?? providerModels.first?.identifier
                    ?? globalDefault?.identifier
                    ?? visibleModels.first?.identifier
                    ?? ""
                if !providerModels.contains(where: { $0.identifier == selectedModelID }) {
                    selectedModelID = fallbackModelID
                }
                normalizeEffortForSelectedModel()
                return
            } catch {
                lastError = error
            }
        }
        guard generation == connectionGeneration else { return }
        status = "读取模型列表失败：\(lastError?.localizedDescription ?? "无法访问本地服务器")"
    }

    private func startHealthMonitor() {
        healthTask?.cancel()
        healthTask = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                guard let self else { return }
                guard self.isForeground else {
                    try? await Task.sleep(for: .seconds(5))
                    continue
                }
                if UIApplication.shared.applicationState == .active,
                   let threadID = self.selectedThreadID {
                    let client = self.client
                    Task {
                        let _: EmptyResponse? = try? await client.post(client.threadPath(threadID, action: "lease"))
                    }
                }
                await self.refreshServerReachability()
                if !self.isReadOnlyViewer, tick.isMultiple(of: 3) { Task { await self.refreshServerOverviews() } }
                tick += 1
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func refreshServerOverviews() async {
        overviewGeneration += 1
        let generation = overviewGeneration
        let profiles = serverProfiles
        let latest = await withTaskGroup(of: (Int, ServerOverview).self) { group in
            for (index, profile) in profiles.enumerated() {
                group.addTask { (index, await Self.fetchServerOverview(profile)) }
            }
            var results: [(Int, ServerOverview)] = []
            for await result in group { results.append(result) }
            return results.sorted { $0.0 < $1.0 }.map(\.1)
        }
        guard generation == overviewGeneration else { return }
        if serverOverviews != latest { serverOverviews = latest }
    }

    private static func fetchServerOverview(_ profile: ServerProfile) async -> ServerOverview {
        let candidates: [String]
        switch profile.connectionMode {
        case .automatic: candidates = [profile.lanURL, profile.tailscaleURL]
        case .lan: candidates = [profile.lanURL]
        case .tailscale: candidates = [profile.tailscaleURL]
        }
        let offline = ServerOverview(id: profile.id, isOnline: false, projectCount: 0,
                                     activeThreads: [], pendingApprovalCount: 0, projects: [])
        let servers = candidates.map { $0.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/")) }.filter { !$0.isEmpty }
        do {
            let (remote, projects): (APIClient, ProjectsResponse) = try await APIClient.getFirstAvailable(
                "/api/projects", servers: servers, token: profile.token)
            let approvals: ApprovalsResponse? = try? await remote.get("/api/approvals", timeout: 3)
            let projectData = projects.data
            return ServerOverview(id: profile.id, isOnline: true, projectCount: projectData.count,
                activeThreads: projectData.flatMap(\.threads).filter(\.isActive).map(\.title),
                pendingApprovalCount: approvals?.data.count ?? 0, projects: projectData)
        } catch { return offline }
    }

    private func refreshServerReachability() async {
        let generation = connectionGeneration
        do {
            let (available, _): (APIClient, HealthResponse) = try await APIClient.getFirstAvailable(
                "/api/health", servers: connectionCandidates, token: authToken, timeout: 3)
            guard !Task.isCancelled, isForeground, generation == connectionGeneration else { return }
            if !isServerReachable { isServerReachable = true }
            activateConnection(available.serverURL)
            await refreshPendingRequests(using: available, generation: generation)
        } catch {
            guard !Task.isCancelled, isForeground, generation == connectionGeneration else { return }
            if isServerReachable { isServerReachable = false }
        }
    }

    private func activateConnection(_ address: String) {
        guard normalizedURL(serverURL) != address else { return }
        serverURL = address
        if streamsStarted {
            connectGlobalStream()
            if let selectedThreadID { connectThreadStream(threadID: selectedThreadID) }
        }
    }

    private func refreshPendingRequests(using api: APIClient, generation: Int) async {
        guard pendingRequestsGeneration != generation else { return }
        pendingRequestsGeneration = generation
        defer { if pendingRequestsGeneration == generation { pendingRequestsGeneration = nil } }
        let approvalRevision = approvalEventRevision
        let inputRevision = inputEventRevision
        async let approvals: ApprovalsResponse? = try? api.get("/api/approvals", timeout: 3)
        async let inputs: InputsResponse? = try? api.get("/api/inputs", timeout: 3)
        if let response = await approvals, generation == connectionGeneration,
           api.serverURL == serverURL, approvalRevision == approvalEventRevision,
           pendingApprovals != response.data { pendingApprovals = response.data }
        if let response = await inputs, generation == connectionGeneration,
           api.serverURL == serverURL, inputRevision == inputEventRevision,
           pendingInputs != response.data { pendingInputs = response.data }
    }

    private var connectionCandidates: [String] {
        let values: [String]
        switch connectionMode {
        case .automatic: values = [serverURL, lanServerURL, tailscaleServerURL]
        case .lan: values = [lanServerURL]
        case .tailscale: values = [tailscaleServerURL]
        }
        var seen = Set<String>()
        return values.map(normalizedURL).filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    private func normalizedURL(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    func selectProject(_ cwd: String?) {
        selectedProjectCWD = cwd
    }

    func openThread(_ thread: CloudexThread, projectCWD: String?) async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-fixture") { await loadUIFixture(thread: thread); return }
        #endif
        checkpointConversation()
        searchReturnDetail = nil
        cancelDetailRead()
        cachedOlderTurns = []
        sendingRequestID = nil
        isBusy = false
        lastCachedConversation = nil
        expandedProcessIDs = []
        conversationLoadState = .loading
        detailLoadGeneration += 1
        olderTurnsLoadGeneration += 1
        isLoadingOlderTurns = false
        threadSSE.stop()
        pollTask?.cancel()
        threadOpenGeneration += 1
        let openGeneration = threadOpenGeneration
        let connection = connectionGeneration
        isOpeningThread = true
        defer {
            if threadOpenGeneration == openGeneration {
                isOpeningThread = false
            }
        }
        selectedProjectCWD = projectCWD
        selectedThreadID = thread.id
        pendingOutgoing = nil
        presentedInput = isReadOnlyConversation ? nil : pendingInputs.first { $0.threadId == thread.id }
        selectedAgentProvider = thread.agentProvider
        if !isReadOnlyViewer { UserDefaults.standard.set(selectedAgentProvider.rawValue, forKey: "cloudex.agentProvider") }
        isCreatingNew = false
        clearLiveMessages()
        localError = nil
        attachedFiles = []
        detail = ThreadDetail(thread: thread, turns: [])
        // Do not carry the previous conversation's model into this one.
        selectedModelID = ""
        selectedEffortID = ""
        if !isReadOnlyViewer {
            Task { [weak self] in
                await self?.refreshModelsForConversation()
                guard let self, self.selectedThreadID == thread.id,
                      self.threadOpenGeneration == openGeneration else { return }
                self.applyConversationModel(self.detail?.thread.model ?? thread.model)
            }
        }
        applyConversationModel(thread.model)
        liveRunning = thread.isActive
        messageIndex = []
        let cache = conversationCache
        let profileID = selectedServerProfileID ?? "default"
        let pageClient = client
        initialCacheLoadGeneration = openGeneration
        var acceptedNetwork = false
        var acceptedCache = false
        var subscribed = false
        func startUpdates() {
            guard !subscribed, isForeground, connectionGeneration == connection,
                  selectedThreadID == thread.id, threadOpenGeneration == openGeneration else { return }
            subscribed = true
            connectThreadStream(threadID: thread.id)
            if active { startPolling(threadID: thread.id) }
        }
        let cacheTask = Task { @MainActor in
            defer {
                if initialCacheLoadGeneration == openGeneration {
                    initialCacheLoadGeneration = nil
                    checkpointConversation()
                }
            }
            #if DEBUG
            if uiCacheReadDelay != .zero { try? await Task.sleep(for: uiCacheReadDelay) }
            #endif
            let snapshot = await Task.detached(priority: .userInitiated) {
                cache.loadThread(threadID: thread.id, profileID: profileID)
            }.value
            guard selectedThreadID == thread.id, threadOpenGeneration == openGeneration,
                  connectionGeneration == connection else { return }
            guard let snapshot else { startUpdates(); return }
            if acceptedNetwork {
                liveMessageTurnIDs = (snapshot.liveMessageTurnIDs ?? [:]).merging(liveMessageTurnIDs) { _, current in current }
                let currentIDs = Set(liveMessages.map(\.id))
                liveMessages = (snapshot.liveMessages ?? []).filter { !currentIDs.contains($0.id) } + liveMessages
                if pendingOutgoing == nil, sendingRequestID == nil { pendingOutgoing = snapshot.pendingOutgoing }
                if let current = detail { removePersistedLiveMessages(from: current) }
                // Keep unrendered cached history even if HTTP won the first-screen race.
                if let current = detail, let first = current.turns.first,
                   let boundary = snapshot.detail.turns.firstIndex(where: { $0.id == first.id }) {
                    cachedOlderTurns = Array(snapshot.detail.turns[..<boundary])
                    detail = ThreadDetail(thread: current.thread, turns: current.turns,
                        hasMoreBefore: snapshot.detail.hasMoreBefore, nextBefore: snapshot.detail.nextBefore)
                    rebuildMessageIndex(from: ThreadDetail(thread: current.thread, turns: cachedOlderTurns + current.turns), threadID: thread.id)
                    checkpointConversation()
                }
                return
            }
            acceptedCache = true
            restoreConversation(snapshot)
            startUpdates()
            applyConversationModel(snapshot.detail.thread.model)
            await renderPreparationTask?.value
            guard selectedThreadID == thread.id, threadOpenGeneration == openGeneration else { return }
            if !acceptedNetwork { conversationLoadState = .syncing }
            isOpeningThread = false
        }
        let networkTask = Task { @MainActor in
            let requestID = UUID()
            let eventRevision = threadEventRevision
            detailRequestInFlight = requestID
            let read = Task { try await latestThreadPage(thread.id, using: pageClient) }
            detailPageTask = read
            defer { finishDetailRead(requestID, threadID: thread.id) }
            guard let page = try? await read.value, !Task.isCancelled,
                  selectedThreadID == thread.id, threadOpenGeneration == openGeneration,
                  connectionGeneration == connection else { return }
            acceptedNetwork = true
            acceptThreadPage(page, threadID: thread.id, updateExecutionState: threadEventRevision == eventRevision)
            startUpdates()
            await renderPreparationTask?.value
            guard selectedThreadID == thread.id, threadOpenGeneration == openGeneration else { return }
            conversationLoadState = .ready
            isOpeningThread = false
        }
        await cacheTask.value
        await networkTask.value
        guard selectedThreadID == thread.id, threadOpenGeneration == openGeneration,
              connectionGeneration == connection else { return }
        conversationLoadState = acceptedNetwork || acceptedCache ? .ready : .failed("读取会话失败，请检查连接后重试")
        startUpdates()
        if active && isForeground {
            startPolling(threadID: thread.id)
        } else {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private func refreshModelsForConversation() async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-cache-regression") { return }
        #endif
        while modelsLoading {
            try? await Task.sleep(for: .milliseconds(20))
            if Task.isCancelled { return }
        }
        await loadModelsIfNeeded()
    }

    private func applyConversationModel(_ modelValue: String?) {
        guard let model = modelValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !model.isEmpty,
              models.contains(where: { $0.identifier == model }) else {
            if !models.contains(where: { $0.identifier == selectedModelID }) {
                selectedModelID = models.first(where: { $0.isDefault == true })?.identifier
                    ?? models.first?.identifier
                    ?? ""
            }
            normalizeEffortForSelectedModel()
            return
        }
        selectedModelID = model
        normalizeEffortForSelectedModel()
    }

    func startNewChat(projectCWD: String? = nil, clearProject: Bool = false) {
        checkpointConversation()
        searchReturnDetail = nil
        cancelDetailRead()
        initialCacheLoadGeneration = nil
        sendingRequestID = nil
        isBusy = false
        cachedOlderTurns = []
        lastCachedConversation = nil
        expandedProcessIDs = []
        conversationLoadState = .idle
        // Invalidate any in-flight history/model load before switching to the
        // empty composer. Otherwise the old task can keep the new page in its
        // opening state or restore the previous conversation after navigation.
        threadOpenGeneration += 1
        detailLoadGeneration += 1
        isOpeningThread = false
        selectedProjectCWD = clearProject ? nil : (projectCWD ?? selectedProjectCWD)
        selectedThreadID = nil
        pendingOutgoing = nil
        detail = nil
        draft = ""
        clearLiveMessages()
        liveRunning = false
        localError = nil
        attachedFiles = []
        isCreatingNew = true
        messageIndex = []
        threadSSE.stop()
        pollTask?.cancel()
    }

    func loadThread(_ threadID: String, force: Bool = false) async {
        guard selectedThreadID == threadID else { return }
        guard detailRequestInFlight == nil else {
            if force { detailRefreshPending = true }
            return
        }
        if liveRunning && !force { return }
        detailLoadGeneration += 1
        let generation = detailLoadGeneration
        let connection = connectionGeneration
        let eventRevision = threadEventRevision
        let requestID = UUID()
        detailRequestInFlight = requestID
        let read = Task { try await latestThreadPage(threadID) }
        detailPageTask = read
        defer { finishDetailRead(requestID, threadID: threadID) }
        do {
            let result = try await read.value
            guard !Task.isCancelled, selectedThreadID == threadID, generation == detailLoadGeneration,
                  connection == connectionGeneration else { return }
            acceptThreadPage(result, threadID: threadID, updateExecutionState: threadEventRevision == eventRevision)
            conversationLoadState = .ready
            if let error = result.turns.last(where: { $0.error != nil })?.error {
                status = cloudexLocalized("任务失败：%@", error.displayText)
            }
        } catch {
            guard !Task.isCancelled, selectedThreadID == threadID, generation == detailLoadGeneration,
                  connection == connectionGeneration else { return }
            status = "读取会话失败：\(error.localizedDescription)"
        }
    }

    private func cancelDetailRead() {
        detailPageTask?.cancel()
        detailPageTask = nil
        detailRequestInFlight = nil
        detailRefreshPending = false
        eventReloadTask?.cancel()
        eventReloadTask = nil
        terminalReloadPending = false
    }

    private func finishDetailRead(_ requestID: UUID, threadID: String) {
        guard detailRequestInFlight == requestID else { return }
        detailRequestInFlight = nil
        detailPageTask = nil
        if detailRefreshPending {
            detailRefreshPending = false
            let connection = connectionGeneration
            let openGeneration = threadOpenGeneration
            Task { [weak self] in
                guard let self, self.connectionGeneration == connection,
                      self.threadOpenGeneration == openGeneration else { return }
                await self.loadThread(threadID, force: true)
            }
        }
    }

    private func acceptThreadPage(_ result: ThreadDetail, threadID: String, updateExecutionState: Bool = true) {
        if let retained = searchReturnDetail {
            let updated = mergingLatestPage(result, into: retained)
            searchReturnDetail = updated
            removePersistedLiveMessages(from: updated, authoritative: updateExecutionState
                && result.thread.syncRevision?.isEmpty == false && result.thread.syncRevision != retained.thread.syncRevision)
            if updateExecutionState, liveRunning != updated.thread.isActive { liveRunning = updated.thread.isActive }
            checkpointConversation()
            return
        }
        let updated = mergingLatestPage(result, into: detail)
        let revisionChanged = result.thread.syncRevision?.isEmpty == false && result.thread.syncRevision != detail?.thread.syncRevision
        if revisionChanged, result.hasMoreBefore == false { cachedOlderTurns = [] }
        if result.hasMoreBefore == true, let current = detail, !current.turns.isEmpty,
           revisionChanged || (result.thread.updatedAt ?? 0) > (current.thread.updatedAt ?? 0),
           Set(current.turns.map(\.id)).isDisjoint(with: result.turns.map(\.id)) {
            cachedOlderTurns = []
        }
        let visibleIDs = Set(updated.turns.map(\.id))
        cachedOlderTurns.removeAll { visibleIDs.contains($0.id) }
        removePersistedLiveMessages(from: updated, authoritative: updateExecutionState && revisionChanged)
        if detail != updated { detail = updated }
        rebuildMessageIndex(from: ThreadDetail(thread: updated.thread, turns: cachedOlderTurns + updated.turns), threadID: threadID)
        if updateExecutionState, liveRunning != updated.thread.isActive { liveRunning = updated.thread.isActive }
        checkpointConversation()
    }

    var hasMoreHistory: Bool { !cachedOlderTurns.isEmpty || detail?.hasMoreBefore == true }

    private func latestThreadPage(_ threadID: String, using requestClient: APIClient? = nil) async throws -> ThreadDetail {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-cache-regression") {
            uiPageReads += 1
            guard let uiCachePage else { throw URLError(.notConnectedToInternet) }
            if uiPageDelay != .zero { try await Task.sleep(for: uiPageDelay) }
            return uiCachePage
        }
        #endif
        let api = requestClient ?? client
        return try await api.get(api.threadPath(threadID), queryItems: [URLQueryItem(name: "limit", value: "12")])
    }

    func loadOlderTurns() async {
        if !cachedOlderTurns.isEmpty, !isLoadingOlderTurns, let current = detail {
            let generation = threadOpenGeneration
            isLoadingOlderTurns = true
            let count = min(12, cachedOlderTurns.count)
            let older = Array(cachedOlderTurns.suffix(count))
            cachedOlderTurns.removeLast(count)
            detail = ThreadDetail(thread: current.thread, turns: older + current.turns,
                                  hasMoreBefore: current.hasMoreBefore, nextBefore: current.nextBefore)
            await renderPreparationTask?.value
            if threadOpenGeneration == generation { isLoadingOlderTurns = false }
            return
        }
        guard let threadID = selectedThreadID,
              let current = detail,
              current.hasMoreBefore == true,
              let before = current.nextBefore,
              !isLoadingOlderTurns else { return }

        olderTurnsLoadGeneration += 1
        let generation = olderTurnsLoadGeneration
        let openGeneration = threadOpenGeneration
        isLoadingOlderTurns = true
        defer {
            if olderTurnsLoadGeneration == generation { isLoadingOlderTurns = false }
        }

        do {
            let result = try await olderTurnsPage(threadID: threadID, before: before)
            guard selectedThreadID == threadID,
                  threadOpenGeneration == openGeneration,
                  olderTurnsLoadGeneration == generation,
                  let latest = detail else { return }
            let existingIDs = Set(latest.turns.map(\.id))
            let older = result.turns.filter { !existingIDs.contains($0.id) }
            let updated = ThreadDetail(
                thread: latest.thread,
                turns: older + latest.turns,
                hasMoreBefore: result.hasMoreBefore,
                nextBefore: result.nextBefore
            )
            detail = updated
            rebuildMessageIndex(from: updated, threadID: threadID)
            checkpointConversation()
            // Keep the loading boundary aligned with publication, not just the HTTP response.
            await renderPreparationTask?.value
        } catch {
            guard selectedThreadID == threadID, threadOpenGeneration == openGeneration else { return }
            status = "读取更早消息失败：\(error.localizedDescription)"
        }
    }

    private func olderTurnsPage(threadID: String, before: String) async throws -> ThreadDetail {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-pagination-fixture"), let current = detail {
            try await Task.sleep(for: .milliseconds(300))
            let items: [[String: Any]] = [["id": "ui-older-turn", "status": "completed", "items": [
                ["type": "agentMessage", "id": "ui-older-answer",
                 "text": String(repeating: "**更早的历史**，加载后保留原来阅读的位置。\n\n", count: 100)]
            ]]]
            let data = try JSONSerialization.data(withJSONObject: items)
            return ThreadDetail(thread: current.thread, turns: try JSONDecoder().decode([CloudexTurn].self, from: data),
                                hasMoreBefore: false, nextBefore: nil)
        }
        #endif
        return try await client.get(client.threadPath(threadID), queryItems: [
            URLQueryItem(name: "limit", value: "12"), URLQueryItem(name: "before", value: before)
        ])
    }

    func loadMessageFromIndex(messageID: String, turnID: String) async -> Bool {
        if renderedMessages.contains(where: { $0.id == messageID }) { return true }
        guard let threadID = selectedThreadID else { return false }
        let generation = threadOpenGeneration
        if let index = cachedOlderTurns.firstIndex(where: { $0.id == turnID }), let current = detail {
            let revealed = Array(cachedOlderTurns[index...])
            cachedOlderTurns.removeSubrange(index...)
            detail = ThreadDetail(thread: current.thread, turns: revealed + current.turns,
                hasMoreBefore: current.hasMoreBefore, nextBefore: current.nextBefore)
            await renderPreparationTask?.value
            return threadOpenGeneration == generation && renderedMessages.contains { $0.id == messageID }
        }
        do {
            let page: ThreadDetail = try await client.get(client.threadPath(threadID), queryItems: [
                URLQueryItem(name: "limit", value: "12"), URLQueryItem(name: "around", value: turnID)
            ])
            guard selectedThreadID == threadID, threadOpenGeneration == generation else { return false }
            if searchReturnDetail == nil, let current = detail {
                searchReturnDetail = ThreadDetail(thread: current.thread, turns: cachedOlderTurns + current.turns,
                    hasMoreBefore: current.hasMoreBefore, nextBefore: current.nextBefore)
            }
            cachedOlderTurns = []
            detail = page
            await renderPreparationTask?.value
            guard selectedThreadID == threadID, threadOpenGeneration == generation else { return false }
            let found = renderedMessages.contains { $0.id == messageID }
            if !found { status = "目标消息已不可用，请刷新后重试" }
            return found
        } catch {
            guard selectedThreadID == threadID, threadOpenGeneration == generation else { return false }
            status = "跳转消息失败：\(error.localizedDescription)"
            return false
        }
    }

    func restoreLatestWindow() async {
        guard let retained = searchReturnDetail else { return }
        searchReturnDetail = nil
        cachedOlderTurns = Array(retained.turns.dropLast(12))
        detail = ThreadDetail(thread: retained.thread, turns: Array(retained.turns.suffix(12)),
            hasMoreBefore: retained.hasMoreBefore, nextBefore: retained.nextBefore)
        await renderPreparationTask?.value
    }

    func setProcessExpanded(_ id: String, expanded: Bool) {
        if expanded { expandedProcessIDs.insert(id) } else { expandedProcessIDs.remove(id) }
        rebuildRenderedMessages()
    }

    func loadTurnDetails(turnID: String) async -> Bool {
        guard let threadID = selectedThreadID,
              let current = detail,
              let index = current.turns.firstIndex(where: { $0.id == turnID }) else { return false }
        if current.turns[index].processDetailsAreLoaded { return true }
        let openGeneration = threadOpenGeneration
        do {
            let result = try await turnDetailsPage(threadID: threadID, turnID: turnID)
            guard selectedThreadID == threadID, threadOpenGeneration == openGeneration, let latest = detail,
                  let latestIndex = latest.turns.firstIndex(where: { $0.id == turnID }) else { return false }
            var turns = latest.turns
            let loaded = result.turn
            turns[latestIndex] = CloudexTurn(id: loaded.id, items: loaded.items, status: loaded.status,
                error: loaded.error, startedAt: loaded.startedAt, completedAt: loaded.completedAt,
                durationMs: loaded.durationMs, compressed: loaded.compressed, itemsView: "full",
                processItemCount: max(latest.turns[latestIndex].processItemCount ?? 0, loaded.processItemCount ?? 0),
                detailsLoaded: true)
            detail = ThreadDetail(
                thread: latest.thread,
                turns: turns,
                hasMoreBefore: latest.hasMoreBefore,
                nextBefore: latest.nextBefore
            )
            checkpointConversation()
            await renderPreparationTask?.value
            return selectedThreadID == threadID
        } catch {
            status = "读取过程详情失败：\(error.localizedDescription)"
            return false
        }
    }

    private func turnDetailsPage(threadID: String, turnID: String) async throws -> TurnDetailResponse {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-process-fixture"),
           let current = detail?.turns.first(where: { $0.id == turnID }) {
            uiProcessAttempts += 1
            try await Task.sleep(for: .milliseconds(200))
            if uiProcessAttempts == 1 { throw URLError(.notConnectedToInternet) }
            let process = ProcessInfo.processInfo.arguments.contains("--ui-process-empty-fixture") ? [] : [
                TurnItem(type: "agentMessage", id: "\(turnID)-analysis", text: "过程详情加载成功", content: nil,
                    command: nil, activity: nil, status: nil, exitCode: nil, duration: nil, phase: "commentary",
                    createdAt: 1_600_000_000, compressed: nil, diff: nil)
            ]
            return TurnDetailResponse(turn: CloudexTurn(id: current.id, items: process + (current.items ?? []),
                status: current.status, error: nil, startedAt: nil, completedAt: nil, durationMs: 12_000,
                compressed: nil, itemsView: "full", processItemCount: process.count, detailsLoaded: true))
        }
        #endif
        return try await client.get(client.threadTurnPath(threadID, turnID: turnID))
    }

    private func mergingLatestPage(_ latest: ThreadDetail, into current: ThreadDetail?) -> ThreadDetail {
        guard let current, !current.turns.isEmpty else { return latest }
        let revisionChanged = latest.thread.syncRevision?.isEmpty == false && latest.thread.syncRevision != current.thread.syncRevision
        if !revisionChanged, let incoming = latest.thread.updatedAt, let known = current.thread.updatedAt, incoming < known {
            return current
        }
        // A fresh page beyond the cached window has a gap. Its server cursor
        // must remain authoritative so the intervening turns stay reachable.
        if latest.hasMoreBefore == true, !latest.turns.isEmpty,
           revisionChanged || (latest.thread.updatedAt ?? 0) > (current.thread.updatedAt ?? 0),
           Set(current.turns.map(\.id)).isDisjoint(with: latest.turns.map(\.id)) { return latest }
        let currentByID = Dictionary(current.turns.map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })
        let turns = latest.turns.map { incomingTurn in
            guard let existing = currentByID[incomingTurn.id] else { return incomingTurn }
            var compactTurn = incomingTurn
            if !revisionChanged && (latest.thread.updatedAt ?? 0) <= (current.thread.updatedAt ?? 0) {
                if !isTurnInProgress(existing) && isTurnInProgress(incomingTurn) { return existing }
                let knownItems = Dictionary((existing.items ?? []).compactMap { item in
                    item.id.map { ($0, item) }
                }, uniquingKeysWith: { _, new in new })
                let items = (incomingTurn.items ?? []).map { item in
                    guard item.type == "agentMessage", let id = item.id, let known = knownItems[id],
                          known.renderedText.hasPrefix(item.renderedText) else { return item }
                    return known
                }
                compactTurn = CloudexTurn(id: incomingTurn.id, items: items, status: incomingTurn.status,
                    error: incomingTurn.error, startedAt: incomingTurn.startedAt, completedAt: incomingTurn.completedAt,
                    durationMs: incomingTurn.durationMs, compressed: incomingTurn.compressed,
                    itemsView: incomingTurn.itemsView, processItemCount: incomingTurn.processItemCount,
                    detailsLoaded: incomingTurn.detailsLoaded)
            }
            guard existing.processDetailsAreLoaded else { return compactTurn }
            // Active compact responses intentionally contain the complete,
            // growing timeline and are marked detailsLoaded. Reusing the
            // first loaded object here would discard every later desktop
            // polling snapshot until the conversation is reopened.
            if isTurnInProgress(compactTurn) || isTurnInProgress(existing) {
                return compactTurn
            }
            guard !compactTurn.processDetailsAreLoaded else { return compactTurn }
            // Keep loaded process rows, but replace visible user/final items with
            // the current server version (completed replies can still be corrected).
            let incomingIDs = Set((compactTurn.items ?? []).compactMap(\.id))
            let existingItems = existing.items ?? []
            let oldFinalIndex = existingItems.lastIndex { $0.type == "agentMessage" && $0.phase == "final_answer" }
                ?? existingItems.lastIndex { $0.type == "agentMessage" }
            let process = existingItems.enumerated().compactMap { index, item -> TurnItem? in
                guard item.type != "userMessage", index != oldFinalIndex, !incomingIDs.contains(item.id ?? "") else { return nil }
                return item
            }
            return CloudexTurn(id: compactTurn.id, items: process + (compactTurn.items ?? []),
                status: compactTurn.status, error: compactTurn.error, startedAt: compactTurn.startedAt,
                completedAt: compactTurn.completedAt, durationMs: compactTurn.durationMs,
                compressed: compactTurn.compressed, itemsView: "full", processItemCount: compactTurn.processItemCount,
                detailsLoaded: true)
        }
        let latestIDs = Set(turns.map(\.id))
        let latestByID = Dictionary(turns.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        let merged = revisionChanged && latest.hasMoreBefore == false ? turns
            : current.turns.map { latestByID[$0.id] ?? $0 } + turns.filter { currentByID[$0.id] == nil }
        let hasOlderLoadedTurns = !(revisionChanged && latest.hasMoreBefore == false)
            && (current.turns.first.map { !latestIDs.contains($0.id) } ?? false)
        return ThreadDetail(
            thread: latest.thread,
            turns: merged,
            hasMoreBefore: hasOlderLoadedTurns ? current.hasMoreBefore : latest.hasMoreBefore,
            nextBefore: hasOlderLoadedTurns ? current.nextBefore : latest.nextBefore
        )
    }

    private func rebuildMessageIndex(from detail: ThreadDetail, threadID: String) {
        let items = detail.turns.flatMap { turn in
            let turnItems = turn.items ?? []
            let finalAgentIndex = turnItems.lastIndex { $0.type == "agentMessage" && $0.phase == "final_answer" }
                ?? turnItems.lastIndex { $0.type == "agentMessage" }
            return turnItems.enumerated().compactMap { index, item -> MessageIndexItem? in
                guard item.type == "userMessage" || index == finalAgentIndex else { return nil }
                let text = item.renderedText
                    .prefix(240)
                    .split(whereSeparator: { $0.isWhitespace })
                    .joined(separator: " ")
                guard !text.isEmpty else { return nil }
                return MessageIndexItem(
                    id: item.id ?? "\(turn.id)-\(item.type)-\(index)",
                    turnId: turn.id,
                    role: item.type == "userMessage" ? "user" : "assistant",
                    text: text,
                    createdAt: item.createdAt ?? turn.startedAt
                )
            }
        }
        guard items != messageIndex else { return }
        messageIndex = items
    }

    func send() async {
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || !attachedFiles.isEmpty else { return }
        guard !active && queueItems.isEmpty else {
            queueSteerDraft()
            return
        }
        _ = await submitPrompt(prompt.isEmpty ? "请查看附件" : prompt, steering: false)
    }

    func sendBuiltInCommand(_ command: String) async {
        guard selectedAgentProvider != .codex else { return }
        let prompt = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        guard !active else {
            status = "当前任务仍在运行，命令将在任务结束后执行"
            return
        }
        _ = await submitPrompt(prompt, steering: false)
    }

    func queueSteerDraft() {
        guard !isReadOnlyConversation else { return }
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || !attachedFiles.isEmpty else { return }
        guard selectedThreadID != nil else {
            localError = "会话正在建立，请稍后再加入队列；输入和附件已保留。"
            return
        }
        if collaborationMode == "plan", !collaborationModes.contains("plan") {
            localError = "此主机尚未确认支持计划模式，请刷新模式列表"; return
        }
        let id = UUID().uuidString
        var body: [String: Any] = ["id": id, "message": prompt.isEmpty ? "请查看附件" : draft,
                                   "files": attachedFiles.map { ["path": $0.path] }]
        if !selectedModelID.isEmpty { body["model"] = selectedModelID }
        if !selectedEffortID.isEmpty { body["effort"] = selectedEffortID }
        body.merge(agentModePayload) { _, new in new }
        guard let data = try? JSONSerialization.data(withJSONObject: body),
              let display = try? JSONDecoder().decode(QueuedMessage.Body.self, from: data) else { return }
        let key = queueStorageKey
        var drafts = localQueueDrafts(key)
        drafts.append(LocalQueueDraft(id: id, payload: data))
        UserDefaults.standard.set(try? JSONEncoder().encode(drafts), forKey: key)
        queueItems.append(QueuedMessage(id: id, body: display, status: "uploading"))
        draft = ""
        attachedFiles = []
        Task { await uploadQueueDraft(id: id) }
    }

    private var queueStorageKey: String { "cloudex.outbox.\(selectedServerProfileID ?? serverURL).\(selectedThreadID ?? "new")" }
    private func localQueueDrafts(_ key: String) -> [LocalQueueDraft] {
        guard let data = UserDefaults.standard.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([LocalQueueDraft].self, from: data)) ?? []
    }
    private func acceptQueue(_ snapshot: MessageQueueSnapshot, key: String) {
        guard key == queueStorageKey else { return }
        if queueScope != key { queueScope = key; queueRevision = -1 }
        if let revision = snapshot.revision {
            guard revision >= queueRevision else { return }
            queueRevision = revision
        }
        let acknowledged = Set(snapshot.items.map(\.id))
        let drafts = localQueueDrafts(key).filter { !acknowledged.contains($0.id) }
        UserDefaults.standard.set(try? JSONEncoder().encode(drafts), forKey: key)
        queueItems = snapshot.items.filter { !["completed", "cancelled"].contains($0.status) }
        queueItems += drafts.compactMap { item in
            guard let body = try? JSONDecoder().decode(QueuedMessage.Body.self, from: item.payload) else { return nil }
            return QueuedMessage(id: item.id, body: body, status: "uploading")
        }
        queuePaused = snapshot.paused
    }
    func loadMessageQueue() async {
        guard !isReadOnlyConversation else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-fixture") && !ProcessInfo.processInfo.arguments.contains("--ui-queue-fixture") { return }
        #endif
        let key = queueStorageKey
        queueError = nil
        if queueScope != key { acceptQueue(MessageQueueSnapshot(paused: false, items: []), key: key) }
        guard let threadID = selectedThreadID else { return }
        do {
            let snapshot: MessageQueueSnapshot = try await client.get(client.threadPath(threadID, action: "queue"))
            acceptQueue(snapshot, key: key)
        } catch {
            if !Task.isCancelled && key == queueStorageKey { queueError = "无法同步队列：\(error.localizedDescription)" }
        }
    }
    func uploadQueueDraft(id: String) async {
        guard !isReadOnlyConversation else { return }
        let key = queueStorageKey
        guard let threadID = selectedThreadID, localQueueDrafts(key).contains(where: { $0.id == id }),
              queueUploads.insert(key).inserted else { return }
        let sourceClient = client
        defer { queueUploads.remove(key) }
        // A slow first POST must not let a later tap overtake it on the server.
        // Bind the entire drain to its original host/thread, even after navigation.
        while let item = localQueueDrafts(key).first {
            guard let body = (try? JSONSerialization.jsonObject(with: item.payload)) as? [String: Any] else { return }
            do {
                let snapshot: MessageQueueSnapshot = try await sourceClient.post(sourceClient.threadPath(threadID, action: "queue"), json: body)
                let drafts = localQueueDrafts(key).filter { $0.id != item.id }
                UserDefaults.standard.set(try? JSONEncoder().encode(drafts), forKey: key)
                acceptQueue(snapshot, key: key)
                if key == queueStorageKey { queueError = nil }
            } catch {
                if key == queueStorageKey { queueError = "尚未确认入队，可用同一消息重试：\(error.localizedDescription)" }
                return
            }
        }
    }
    func changeQueue(_ action: String, id: String? = nil, message: String? = nil) async {
        guard !isReadOnlyConversation else { return }
        let key = queueStorageKey
        guard let threadID = selectedThreadID else { return }
        var body: [String: Any] = ["action": action]
        if let id { body["id"] = id }
        if let message { body["message"] = message }
        do {
            let snapshot: MessageQueueSnapshot = try await client.post(client.threadPath(threadID, action: "queue"), json: body)
            acceptQueue(snapshot, key: key)
            if key == queueStorageKey { queueError = nil }
        } catch { if key == queueStorageKey { queueError = error.localizedDescription } }
    }

    func cancelLocalQueueDraft(id: String) async {
        let key = queueStorageKey
        guard let threadID = selectedThreadID, let item = localQueueDrafts(key).first(where: { $0.id == id }),
              let payload = (try? JSONSerialization.jsonObject(with: item.payload)) as? [String: Any] else { return }
        // The same ID is tombstoned server-side, including when an enqueue reply was lost.
        do {
            let snapshot: MessageQueueSnapshot = try await client.post(client.threadPath(threadID, action: "queue"), json: ["action": "cancel", "id": id, "message": payload["message"] ?? ""])
            acceptQueue(snapshot, key: key)
        } catch { if key == queueStorageKey { queueError = "尚未确认取消，请联网后重试：\(error.localizedDescription)" } }
    }

    func recoverLocalQueueDraft(id: String) {
        let key = queueStorageKey
        guard !queueUploads.contains(key), let item = localQueueDrafts(key).first(where: { $0.id == id }),
              let body = (try? JSONSerialization.jsonObject(with: item.payload)) as? [String: Any] else { return }
        // Restore for inspection only; the server may have accepted a timed-out enqueue.
        draft = [draft, body["message"] as? String ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
        for file in body["files"] as? [[String: Any]] ?? [] {
            guard let path = file["path"] as? String, !attachedFiles.contains(where: { $0.path == path }) else { continue }
            attachedFiles.append(RemoteFileEntry(name: (path as NSString).lastPathComponent, path: path, type: "file",
                                                size: nil, modifiedAt: nil, selectable: true))
        }
        localError = "已恢复草稿。请先同步队列核对是否已接收，避免重复发送。"
    }

    func sendDraftAsSteer() async {
        guard active, selectedAgentProvider == .codex else { return }
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        let generation = threadOpenGeneration
        if await submitPrompt(prompt, steering: true), generation == threadOpenGeneration, draft == prompt { draft = "" }
    }

    func editPendingSteer() {
        let prompt = pendingSteerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        pendingSteerDraft = ""
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            draft = prompt
        } else {
            draft += "\n\n\(prompt)"
        }
    }

    func deletePendingSteer() {
        pendingSteerDraft = ""
    }

    func sendPendingSteer() async {
        let generation = threadOpenGeneration
        let prompt = pendingSteerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty else { return }
        let steering = active
        guard await submitPrompt(prompt, steering: steering) else { return }
        guard generation == threadOpenGeneration else { return }
        if pendingSteerDraft.trimmingCharacters(in: .whitespacesAndNewlines) == prompt {
            pendingSteerDraft = ""
        }
    }


    private func submitPrompt(_ prompt: String, steering: Bool) async -> Bool {
        guard !isReadOnlyConversation, !isBusy else { return false }
        if !steering, selectedAgentProvider == .codex, collaborationMode == "plan", !collaborationModes.contains("plan") {
            localError = "此主机尚未确认支持计划模式，请刷新模式列表"; return false
        }
        if searchReturnDetail != nil {
            let generation = threadOpenGeneration
            await restoreLatestWindow()
            guard generation == threadOpenGeneration, !isBusy else { return false }
        }
        let generation = connectionGeneration
        let openGeneration = threadOpenGeneration
        let sourceThreadID = selectedThreadID
        let requestID = UUID()
        let sentAttachments = attachedFiles
        sendingRequestID = requestID
        func stillCurrent() -> Bool {
            generation == connectionGeneration && openGeneration == threadOpenGeneration
                && sourceThreadID == selectedThreadID && sendingRequestID == requestID
        }
        defer {
            if sendingRequestID == requestID { sendingRequestID = nil; isBusy = false }
        }
        let wasRunning = active
        isBusy = true
        liveRunning = true
        localError = nil
        if !steering {
            pendingOutgoing = ChatMessage(
                id: "outgoing-\(UUID().uuidString)",
                role: .user,
                text: prompt,
                executionStatus: "sending",
                createdAt: Date().timeIntervalSince1970,
                attachments: attachedFiles.map { MessageAttachment(name: $0.name, path: $0.path, kind: $0.isImage ? .image : .file) }
            )
            draft = ""
        }
        var body: [String: Any] = [:]
        if !steering {
            if !selectedModelID.isEmpty { body["model"] = selectedModelID }
            if !selectedEffortID.isEmpty { body["effort"] = selectedEffortID }
            body.merge(agentModePayload) { _, new in new }
        }
        if !sentAttachments.isEmpty { body["files"] = sentAttachments.map { ["path": $0.path] } }
        do {
            if let selectedThreadID {
                body["message"] = prompt
                let action = steering ? "steer" : "message"
                let turnID: String?
                if steering {
                    let _: EmptyResponse = try await postPrompt(client.threadPath(selectedThreadID, action: action), body: body)
                    turnID = nil
                } else {
                    let result: SendMessageResponse = try await postPrompt(client.threadPath(selectedThreadID, action: action), body: body)
                    turnID = result.turn?.id
                }
                guard stillCurrent() else { return false }
                attachedFiles.removeAll { file in sentAttachments.contains { $0.path == file.path } }
                if !steering {
                    pendingOutgoing?.sourceTurnID = turnID
                    pendingOutgoing?.executionStatus = "sent"
                    rebuildRenderedMessages()
                }
                await loadThread(selectedThreadID, force: true)
                guard stillCurrent() else { return false }
                isBusy = false
                return true
            } else {
                guard !steering else {
                    status = "当前没有可引导的任务"
                    isBusy = false
                    return false
                }
                body["prompt"] = prompt
                body["provider"] = selectedAgentProvider.rawValue
                if let selectedProjectCWD {
                    body["cwd"] = selectedProjectCWD
                } else {
                    body["noProject"] = true
                }
                let result: CreateThreadResponse = try await postPrompt("/api/threads", body: body)
                guard stillCurrent() else { return false }
                attachedFiles.removeAll { file in sentAttachments.contains { $0.path == file.path } }
                pendingOutgoing?.executionStatus = "sent"
                pendingOutgoing?.sourceTurnID = result.turn?.id
                rebuildRenderedMessages()
                isCreatingNew = false
                let sentMode = collaborationMode
                selectedThreadID = result.thread.id
                collaborationMode = sentMode
                UserDefaults.standard.set(sentMode, forKey: collaborationPreferenceKey)
                detail = ThreadDetail(thread: result.thread, turns: [])
                connectThreadStream(threadID: result.thread.id)
                startPolling(threadID: result.thread.id)
                await refresh()
                return generation == connectionGeneration && openGeneration == threadOpenGeneration
                    && selectedThreadID == result.thread.id && sendingRequestID == requestID
            }
        } catch {
            guard stillCurrent() else { return false }
            if (error as? URLError)?.code == .timedOut {
                if sourceThreadID == nil { liveRunning = wasRunning }
                if let sourceThreadID { await loadThread(sourceThreadID, force: true) }
                guard stillCurrent() else { return false }
                if let outgoing = pendingOutgoing,
                   (detail?.turns ?? []).contains(where: { turn in
                       (turn.startedAt ?? 0) >= (outgoing.createdAt ?? 0) - 2 &&
                       (turn.items ?? []).contains { $0.type == "userMessage" && $0.renderedText == prompt }
                   }) {
                    pendingOutgoing = nil
                    return true
                }
                pendingOutgoing?.executionStatus = "unconfirmed"
                localError = "发送结果尚未确认，请刷新核对后再决定是否重发"
                return false
            }
            liveRunning = wasRunning
            if !steering && draft.isEmpty { draft = prompt }
            pendingOutgoing = nil
            localError = error.localizedDescription
            status = "发送失败：\(error.localizedDescription)"
            isBusy = false
            return false
        }
    }

    private func postPrompt<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        #if DEBUG
        if let uiSubmitResult { return try JSONDecoder().decode(T.self, from: await uiSubmitResult.value) }
        #endif
        return try await client.post(path, json: body)
    }

    func forkAssistantMessage(_ message: ChatMessage) async -> Bool {
        guard let threadID = selectedThreadID,
              let turnID = message.sourceTurnID else {
            status = "无法确定这条回复所属的对话轮次"
            return false
        }
        return await forkThread(
            threadID: threadID,
            turnID: turnID,
            position: "through",
            editedMessage: nil
        )
    }

    func editUserMessage(_ message: ChatMessage, replacement: String) async -> Bool {
        guard let threadID = selectedThreadID,
              let turnID = message.sourceTurnID else {
            status = "无法确定这条消息所属的对话轮次"
            return false
        }
        let trimmed = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return await forkThread(
            threadID: threadID,
            turnID: turnID,
            position: "before",
            editedMessage: trimmed
        )
    }

    private func forkThread(
        threadID: String,
        turnID: String,
        position: String,
        editedMessage: String?
    ) async -> Bool {
        guard !isReadOnlyConversation else { return false }
        isBusy = true
        defer { isBusy = false }
        var payload: [String: Any] = [
            "turnId": turnID,
            "position": position,
        ]
        if let editedMessage { payload["message"] = editedMessage }
        if !selectedModelID.isEmpty { payload["model"] = selectedModelID }
        if !selectedEffortID.isEmpty { payload["effort"] = selectedEffortID }
        payload.merge(agentModePayload) { _, new in new }
        do {
            let result: ForkThreadResponse = try await client.post(
                client.threadPath(threadID, action: "fork"),
                json: payload
            )
            clearMessageJumpRequest()
            let projectCWD = selectedProjectCWD
            await openThread(result.thread, projectCWD: projectCWD)
            threadNavigationRequest = ThreadNavigationRequest(threadID: result.thread.id)
            await refresh()
            status = editedMessage == nil ? "已分叉对话" : "已从修改后的消息继续对话"
            return true
        } catch {
            status = "分叉对话失败：\(error.localizedDescription)"
            return false
        }
    }

    func clearThreadNavigationRequest() {
        threadNavigationRequest = nil
    }

    func stop() async {
        guard !isReadOnlyConversation else { return }
        guard let selectedThreadID, !isBusy else { return }
        let generation = threadOpenGeneration
        do {
            let _: EmptyResponse = try await client.post(client.threadPath(selectedThreadID, action: "stop"))
            guard threadOpenGeneration == generation else { return }
            status = "已请求停止当前任务"
        } catch {
            guard threadOpenGeneration == generation else { return }
            status = "停止失败：\(error.localizedDescription)"
        }
        await loadThread(selectedThreadID, force: true)
        await refresh()
    }

    func archive(_ threadID: String) async {
        do {
            let _: EmptyResponse = try await client.post(client.threadPath(threadID, action: "archive"))
            if selectedThreadID == threadID { startNewChat(projectCWD: selectedProjectCWD) }
            await refresh()
        } catch {
            status = "归档失败：\(error.localizedDescription)"
        }
    }

    func listFiles(path: String) async throws -> RemoteFilesResponse {
        try await client.get("/api/files", queryItems: [URLQueryItem(name: "path", value: path)])
    }

    func previewFile(path: String) async throws -> Data {
        try await client.download("/api/file", queryItems: [URLQueryItem(name: "path", value: path)])
    }

    func loadProjectReview(path: String) async throws -> ProjectReviewResponse {
        var lastError: Error?
        for candidate in connectionCandidates {
            do {
                let candidateClient = APIClient(serverURL: candidate, token: authToken)
                let response: ProjectReviewResponse = try await candidateClient.get(
                    "/api/review",
                    queryItems: [URLQueryItem(name: "path", value: path)]
                )
                if normalizedURL(serverURL) != candidate {
                    serverURL = candidate
                }
                return response
            } catch {
                lastError = error
            }
        }
        throw lastError ?? APIClientError.invalidServerURL
    }

    func searchConversationMessages(_ query: String) async -> [ConversationSearchMatch] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        for candidate in connectionCandidates {
            do {
                let candidateClient = APIClient(serverURL: candidate, token: authToken)
                let response: ConversationSearchResponse = try await candidateClient.get(
                    "/api/search/messages",
                    queryItems: [URLQueryItem(name: "q", value: trimmed)]
                )
                if normalizedURL(serverURL) != candidate { serverURL = candidate }
                return response.data
            } catch {
                continue
            }
        }
        return []
    }

    func requestMessageJump(threadID: String, messageID: String, turnID: String, query: String) {
        pendingMessageJump = PendingMessageJump(
            threadID: threadID,
            messageID: messageID,
            turnID: turnID,
            query: query
        )
    }

    func clearMessageJumpRequest() {
        pendingMessageJump = nil
    }

    func attach(_ file: RemoteFileEntry) {
        guard !attachedFiles.contains(where: { $0.path == file.path }) else { return }
        attachedFiles.append(file)
    }

    func attachPhoneImage(_ data: Data) async -> Bool {
        guard !isReadOnlyConversation else { return false }
        let generation = connectionGeneration
        let uploadClient = client
        let uploadServer = serverURL
        let uploadThread = selectedThreadID
        do {
            let file = try await uploadClient.uploadImage(data)
            _ = await AttachmentImageCache.prepare(data, path: file.path, server: uploadServer)
            guard generation == connectionGeneration, uploadThread == selectedThreadID else { return false }
            attach(file)
            return true
        } catch {
            status = "上传图片失败：\(error.localizedDescription)"
            return false
        }
    }

    func removeAttachment(_ file: RemoteFileEntry) {
        attachedFiles.removeAll { $0.path == file.path }
    }

    func selectModel(_ modelID: String) {
        selectedModelID = modelID
        normalizeEffortForSelectedModel()
        UserDefaults.standard.set(selectedModelID, forKey: "cloudex.model")
        UserDefaults.standard.set(selectedEffortID, forKey: "cloudex.effort")
    }

    func selectAgentProvider(_ provider: AgentProvider) {
        selectedAgentProvider = provider
        UserDefaults.standard.set(provider.rawValue, forKey: "cloudex.agentProvider")
        selectedModelID = models.first(where: { $0.agentProvider == provider && $0.isDefault == true })?.identifier
            ?? models.first(where: { $0.agentProvider == provider })?.identifier
            ?? ""
        normalizeEffortForSelectedModel()
        if selectedThread?.agentProvider != provider {
            startNewChat(projectCWD: selectedProjectCWD)
        }
    }

    func selectEffort(_ effortID: String) {
        guard availableEfforts.contains(where: { $0.reasoningEffort == effortID }) else { return }
        selectedEffortID = effortID
        UserDefaults.standard.set(selectedEffortID, forKey: "cloudex.effort")
        UserDefaults.standard.set(true, forKey: "cloudex.effort.userSelected")
    }

    func selectCodexMode(_ mode: CodexExecutionMode) {
        codexMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: "cloudex.codexMode")
        guard mode == .approveForMe || mode == .fullAccess else { return }
        let approvals = pendingApprovals
        guard !approvals.isEmpty else { return }
        Task { [weak self] in
            for approval in approvals {
                guard let self, self.codexMode == mode else { return }
                await self.respondToApproval(approval, decision: .accept)
            }
        }
    }

    func selectClaudeMode(_ mode: ClaudeExecutionMode) {
        claudeMode = mode
        UserDefaults.standard.set(mode.rawValue, forKey: "cloudex.claudeMode")
    }

    func isPinned(_ threadID: String) -> Bool {
        pinnedThreadIDs.contains(threadID)
    }

    func togglePinned(_ threadID: String) {
        if pinnedThreadIDs.contains(threadID) {
            pinnedThreadIDs.remove(threadID)
        } else {
            pinnedThreadIDs.insert(threadID)
        }
        UserDefaults.standard.set(Array(pinnedThreadIDs).sorted(), forKey: "cloudex.pinnedThreadIDs")
    }

    private var codexModePayload: [String: Any] {
        var payload: [String: Any] = [
            "sandbox": codexMode.sandbox,
            "approvalPolicy": codexMode.approvalPolicy,
            "approvalsReviewer": codexMode.approvalsReviewer,
            "sandboxPolicy": ["type": codexMode.sandboxPolicyType],
        ]
        if collaborationModes.contains(collaborationMode) { payload["collaborationMode"] = collaborationMode }
        return payload
    }

    private var collaborationPreferenceKey: String {
        "cloudex.collaboration.\(selectedServerProfileID ?? serverURL).\(selectedThreadID ?? "new")"
    }

    func selectCollaborationMode(_ mode: String) {
        guard collaborationModes.contains(mode) else { return }
        collaborationMode = mode
        UserDefaults.standard.set(mode, forKey: collaborationPreferenceKey)
    }

    func loadCollaborationModes() async {
        guard !isReadOnlyConversation else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-fixture") { collaborationModes = ["default", "plan"]; return }
        #endif
        let key = collaborationPreferenceKey
        collaborationMode = UserDefaults.standard.string(forKey: key) ?? "default"
        collaborationModes = []; collaborationModeError = nil
        guard selectedAgentProvider == .codex else { return }
        do {
            let result: CollaborationModesResponse = try await client.get("/api/collaboration-modes")
            guard key == collaborationPreferenceKey else { return }
            collaborationModes = result.data.compactMap(\.mode).filter { ["default", "plan"].contains($0) }
            if collaborationModes.isEmpty { collaborationModeError = "此主机不支持工作模式切换" }
        } catch {
            guard !Task.isCancelled, key == collaborationPreferenceKey else { return }
            collaborationModeError = "无法读取工作模式，请检查主机版本或连接"
        }
    }

    private var claudeModePayload: [String: Any] {
        ["claudePermissionMode": claudeMode.rawValue]
    }

    private var agentModePayload: [String: Any] {
        selectedAgentProvider == .claude ? claudeModePayload : codexModePayload
    }

    private func normalizeEffortForSelectedModel() {
        guard let model = models.first(where: { $0.identifier == selectedModelID }) else { return }
        let supported = model.supportedReasoningEfforts ?? []
        let userSelected = UserDefaults.standard.bool(forKey: "cloudex.effort.userSelected")
        if !userSelected || !supported.contains(where: { $0.reasoningEffort == selectedEffortID }) {
            selectedEffortID = model.defaultReasoningEffort ?? supported.first?.reasoningEffort ?? ""
        }
    }

    func respondToApproval(_ approval: ApprovalRequest, decision: ApprovalDecision) async {
        guard !isReadOnlyConversation else { return }
        guard approval.supports(decision) else {
            status = "当前审批不支持这个选项"
            return
        }
        do {
            let _: ApprovalResponse = try await client.post(
                client.approvalPath(approval.id),
                json: ["decision": decision.rawValue]
            )
            pendingApprovals.removeAll { $0.id == approval.id }
            CloudexAppDelegate.notifications.removeApproval(approval.id)
            appendApprovalSystemMessage(approval: approval, decision: decision)
            switch decision {
            case .accept: status = "已允许本次操作"
            case .acceptForSession: status = "已永久允许当前会话"
            case .decline: status = "已禁止操作"
            }
        } catch {
            if let apiError = error as? APIClientError,
               case let .server(status, _) = apiError,
               status == 409 {
                    pendingApprovals.removeAll { $0.id == approval.id }
            }
            status = "审批失败：\(error.localizedDescription)"
        }
    }

    func updateNotificationSettings(approvals: Bool, taskSuccess: Bool, taskFailure: Bool) {
        notifyApprovals = approvals
        notifyTaskSuccess = taskSuccess
        notifyTaskFailure = taskFailure
        let defaults = UserDefaults.standard
        defaults.set(approvals, forKey: "cloudex.notifyApprovals")
        defaults.set(taskSuccess, forKey: "cloudex.notifyTaskSuccess")
        defaults.set(taskFailure, forKey: "cloudex.notifyTaskFailure")
    }

    func respondToApproval(id: String, decision: ApprovalDecision) async {
        if let approval = pendingApprovals.first(where: { $0.id == id }) {
            await respondToApproval(approval, decision: decision)
            return
        }
        if let response: ApprovalsResponse = try? await client.get("/api/approvals"),
           let approval = response.data.first(where: { $0.id == id }) {
            pendingApprovals = response.data
            await respondToApproval(approval, decision: decision)
        }
    }

    private func applyProjects(_ value: [CloudexProject]) {
        if projects == value { return }
        projects = value
        if !isReadOnlyViewer {
            updateCurrentTaskSnapshot()
            conversationCache.saveProjects(value, profileID: selectedServerProfileID ?? "default")
        }
        if let selectedProjectCWD, !value.contains(where: { $0.cwd == selectedProjectCWD }) {
            self.selectedProjectCWD = nil
        }
    }

    private func updateCurrentTaskSnapshot() {
        let activeThreads = projects.flatMap(\.threads).filter(\.isActive)
        let title = activeThreads.first(where: { $0.id == selectedThreadID })?.title
            ?? activeThreads.first?.title ?? "无运行任务"
        let snapshot = CurrentTaskSnapshot(hostName: serverProfileTitle, title: title,
                                           activeCount: activeThreads.count, updatedAt: Date())
        if let data = try? JSONEncoder().encode(snapshot) {
            UserDefaults(suiteName: CloudexShared.groupID)?.set(data, forKey: "currentTask")
            WidgetCenter.shared.reloadTimelines(ofKind: "CloudexCurrentTask")
        }
    }

    private func synchronizeSelectedThreadIfNeeded(from snapshotProjects: [CloudexProject]) async {
        guard let selectedThreadID,
              let snapshotThread = snapshotProjects
                .lazy.flatMap(\.threads)
                .compactMap({ $0.descendant(withID: selectedThreadID) }).first,
              snapshotThread.isActive || active ||
                (snapshotThread.syncRevision?.isEmpty == false && snapshotThread.syncRevision != selectedThread?.syncRevision) ||
                (snapshotThread.updatedAt ?? 0) > (selectedThread?.updatedAt ?? 0) else { return }

        let wasActive = active
        guard self.selectedThreadID == selectedThreadID else { return }
        await loadThread(selectedThreadID, force: true)
        guard self.selectedThreadID == selectedThreadID else { return }

        if active, !wasActive {
            connectThreadStream(threadID: selectedThreadID)
            startPolling(threadID: selectedThreadID)
        } else if !active, wasActive {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private func connectGlobalStream() {
        guard isForeground else { return }
        do {
            let generation = connectionGeneration
            let url = try client.makeURL(path: "/api/events")
            globalSSE.onOpen = { [weak self] in
                Task { @MainActor in
                    guard self?.connectionGeneration == generation else { return }
                    self?.status = cloudexLocalized("已连接 · 实时同步")
                    if self?.isReadOnlyViewer != true { await self?.loadMessageQueue() }
                }
            }
            globalSSE.onEvent = { [weak self] event in
                MainActor.assumeIsolated {
                    guard self?.connectionGeneration == generation else { return }
                    self?.handleGlobalEvent(event)
                }
            }
            globalSSE.onDisconnect = { [weak self] message in
                Task { @MainActor in
                    guard self?.connectionGeneration == generation else { return }
                    self?.status = message.contains("401") ? "实时总线认证失败：请确认 Token" : "实时总线断开：\(message)"
                }
            }
            globalSSE.start(url: url, token: authToken)
        } catch {
            status = "实时总线启动失败：\(error.localizedDescription)"
        }
    }

    private func connectThreadStream(threadID: String) {
        guard isForeground, selectedThreadID == threadID else { return }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-cache-regression") { return }
        #endif
        threadSSE.stop()
        lastThreadEventID = 0
        threadStreamReplaying = true
        threadReplayIsIncremental = false
        replayedMessageText = [:]
        do {
            let generation = connectionGeneration
            let openGeneration = threadOpenGeneration
            let url = try client.makeURL(
                path: client.threadPath(threadID, action: "stream"),
                queryItems: [URLQueryItem(name: "lease", value: "1")]
            )
            threadSSE.onEvent = { [weak self] event in
                MainActor.assumeIsolated {
                    guard self?.connectionGeneration == generation, self?.threadOpenGeneration == openGeneration else { return }
                    self?.handleThreadEvent(event, expectedThreadID: threadID)
                }
            }
            threadSSE.onOpen = { [weak self] in
                MainActor.assumeIsolated {
                    guard self?.connectionGeneration == generation, self?.threadOpenGeneration == openGeneration else { return }
                    self?.threadStreamReplaying = true
                    self?.threadReplayIsIncremental = self?.threadSSE.lastEventID != nil
                    self?.replayedMessageText = [:]
                    self?.replayNeedsRefresh = false
                }
            }
            threadSSE.onDisconnect = { [weak self] message in
                Task { @MainActor in
                    guard self?.connectionGeneration == generation,
                          self?.threadOpenGeneration == openGeneration,
                          self?.selectedThreadID == threadID else { return }
                    self?.status = message.contains("401") ? "实时订阅认证失败：请确认 Token" : "实时连接断开：\(message)"
                }
            }
            threadSSE.start(url: url, token: authToken)
        } catch {
            status = "实时订阅启动失败：\(error.localizedDescription)"
        }
    }

    private func handleGlobalEvent(_ event: SSEEvent) {
        if event.name.hasPrefix("approval/") { approvalEventRevision += 1 }
        if event.name.hasPrefix("input/") { inputEventRevision += 1 }
        if event.name == "queue/changed",
           let object = (try? JSONSerialization.jsonObject(with: event.data)) as? [String: Any],
           object["threadId"] as? String == selectedThreadID,
           let snapshot = try? JSONDecoder().decode(MessageQueueSnapshot.self, from: event.data) {
            acceptQueue(snapshot, key: queueStorageKey)
            return
        }
        if event.name == "input/requested",
           let input = try? JSONDecoder().decode(InputRequest.self, from: event.data) {
            pendingInputs.removeAll { $0.id == input.id }
            pendingInputs.append(input)
            if !isReadOnlyConversation, input.threadId == selectedThreadID { presentedInput = input }
            return
        }
        if event.name == "input/resolved",
           let object = (try? JSONSerialization.jsonObject(with: event.data)) as? [String: String],
           let id = object["id"] {
            pendingInputs.removeAll { $0.id == id }
            if presentedInput?.id == id { presentedInput = nil }
            return
        }
        if event.name == "approval/requested",
           let approval = try? JSONDecoder().decode(ApprovalRequest.self, from: event.data) {
            pendingApprovals.removeAll { $0.id == approval.id }
            pendingApprovals.append(approval)
            guard !isReadOnlyViewer else { return }
            if codexMode == .approveForMe || codexMode == .fullAccess {
                Task { [weak self] in
                    guard let self else { return }
                    await self.respondToApproval(approval, decision: .accept)
                }
            } else {
                CloudexAppDelegate.notifications.scheduleApproval(approval)
                status = "Codex 正在等待审批"
            }
            return
        }
        if event.name == "approval/resolved",
           let resolved = try? JSONDecoder().decode(ApprovalResolvedEvent.self, from: event.data) {
            let approval = resolved.approval ?? pendingApprovals.first { $0.id == resolved.id }
            let threadID = resolved.threadId ?? approval?.threadId
            if let rawDecision = resolved.decision,
               let decision = ApprovalDecision(rawValue: rawDecision) {
                if let approval {
                    appendApprovalSystemMessage(approval: approval, decision: decision)
                } else {
                    appendApprovalSystemMessage(
                        approvalID: resolved.id,
                        threadID: threadID,
                        decision: decision,
                        requestedAt: nil
                    )
                }
            }
            pendingApprovals.removeAll { $0.id == resolved.id }
            if !isReadOnlyViewer { CloudexAppDelegate.notifications.removeApproval(resolved.id) }
            return
        }
        if event.name == "threads/changed",
           let snapshot = try? JSONDecoder().decode(ProjectSnapshot.self, from: event.data) {
            applyProjects(snapshot.projects)
            Task { await synchronizeSelectedThreadIfNeeded(from: snapshot.projects) }
        }
    }

    func respondToInput(_ input: InputRequest, response: [String: Any]) async throws {
        guard !isReadOnlyConversation else { return }
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let encoded = input.id.addingPercentEncoding(withAllowedCharacters: allowed) ?? input.id
        let _: EmptyResponse = try await client.post("/api/inputs/\(encoded)/respond", json: response)
        pendingInputs.removeAll { $0.id == input.id }
        if presentedInput?.id == input.id { presentedInput = nil }
    }

    private func appendApprovalSystemMessage(approval: ApprovalRequest, decision: ApprovalDecision) {
        let turnID = approval.turnId
            ?? approval.threadId.flatMap { activeTurnNotificationKeys[$0] }
        if approval.threadId == selectedThreadID, let turnID {
            let id = "approval-\(approval.id)-\(decision.rawValue)"
            let existingIndex = liveMessages.firstIndex { $0.id == id }
            let createdAt = existingIndex.flatMap { liveMessages[$0].createdAt } ?? nextLiveCreatedAt()
            let message = ChatMessage(
                id: id,
                role: .execution,
                text: approvalConfirmationText(approval: approval, decision: decision),
                executionStatus: decision == .decline ? "declined" : "completed",
                executionKind: "approval",
                createdAt: createdAt,
                threadID: approval.threadId
            )
            liveMessageTurnIDs[id] = turnID
            systemMessages.removeAll { $0.id == id }
            if let existingIndex {
                liveMessages[existingIndex] = message
            } else {
                liveMessages.append(message)
            }
            return
        }
        appendApprovalSystemMessage(
            approvalID: approval.id,
            threadID: approval.threadId,
            decision: decision,
            requestedAt: approval.requestedAt,
            text: approvalConfirmationText(approval: approval, decision: decision)
        )
    }

    private func appendApprovalSystemMessage(
        approvalID: String,
        threadID: String?,
        decision: ApprovalDecision,
        requestedAt: Double?,
        text: String? = nil
    ) {
        let id = "approval-\(approvalID)-\(decision.rawValue)"
        systemMessages.removeAll { $0.id == id }
        systemMessages.append(ChatMessage(
            id: id,
            role: .execution,
            text: text ?? decision.systemTitle,
            executionStatus: "completed",
            executionKind: "approval",
            createdAt: normalizedTimestamp(requestedAt) ?? Date().timeIntervalSince1970,
            threadID: threadID
        ))
    }

    private func approvalConfirmationText(approval: ApprovalRequest, decision: ApprovalDecision) -> String {
        var details: [String] = []
        if let reason = approval.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
            details.append("说明：\(reason)")
        }
        if let context = approval.networkApprovalContext, let host = context.host, !host.isEmpty {
            let scheme = context.protocolName.map { "\($0)://" } ?? ""
            let port = context.port.map { ":\($0)" } ?? ""
            details.append("网络：\(scheme)\(host)\(port)")
        }
        if let permissionSummary = approval.permissionSummary, !permissionSummary.isEmpty {
            details.append("权限：\(permissionSummary)")
        }
        if let command = approval.command, !command.isEmpty {
            details.append("命令：\(command)")
        }
        if let path = approval.grantRoot ?? approval.cwd, !path.isEmpty {
            details.append("路径：\(path)")
        }
        guard !details.isEmpty else { return decision.systemTitle }
        return "\(decision.systemTitle)\n\(details.joined(separator: "\n"))"
    }

    private func normalizedTimestamp(_ value: Double?) -> Double? {
        guard let value, value > 0 else { return nil }
        return value > 10_000_000_000 ? value / 1000 : value
    }

    private func handleThreadEvent(_ event: SSEEvent, expectedThreadID: String) {
        guard selectedThreadID == expectedThreadID else { return }
        if event.name == "replay-start" {
            let replay = (try? JSONSerialization.jsonObject(with: event.data)) as? [String: Any]
            threadStreamReplaying = true
            threadReplayIsIncremental = replay?["resumed"] as? Bool == true
            if replay?["resetRequired"] as? Bool == true || !threadReplayIsIncremental { lastThreadEventID = 0 }
            replayedMessageText = [:]
            return
        }
        if event.name == "replay-complete" {
            let replay = (try? JSONSerialization.jsonObject(with: event.data)) as? [String: Any]
            if let latest = replay?["latestEventId"] as? String ?? event.id {
                threadSSE.resume(after: latest)
                lastThreadEventID = Int(latest.split(separator: ":").last ?? "") ?? lastThreadEventID
            }
            threadStreamReplaying = false
            threadReplayIsIncremental = false
            if let detail { removePersistedLiveMessages(from: detail) }
            rebuildRenderedMessages()
            if replayNeedsRefresh || replay?["resetRequired"] as? Bool == true { reloadAfterEvent(expectedThreadID) }
            return
        }
        if event.name == "history/changed" {
            if let id = event.id.flatMap({ Int($0.split(separator: ":").last ?? "") }) {
                lastThreadEventID = max(lastThreadEventID, id)
            }
            reloadAfterEvent(expectedThreadID)
            return
        }
        if let id = event.id.flatMap({ Int($0.split(separator: ":").last ?? "") }) {
            guard id > lastThreadEventID else { return }
            lastThreadEventID = id
        }
        if event.name == "error" {
            let object = (try? JSONSerialization.jsonObject(with: event.data)) as? [String: Any]
            status = "实时订阅失败：\(object?["message"] as? String ?? "未知错误")"
            return
        }
        guard event.name == "notification",
              let object = (try? JSONSerialization.jsonObject(with: event.data)) as? [String: Any],
              let method = object["method"] as? String else { return }
        let params = object["params"] as? [String: Any] ?? [:]
        threadEventRevision += 1

        if ["item/started", "item/completed", "item/updated"].contains(method),
           let item = params["item"] as? [String: Any], let raw = item["attachments"],
           let data = try? JSONSerialization.data(withJSONObject: raw),
           let attachments = try? JSONDecoder().decode([MessageAttachment].self, from: data), !attachments.isEmpty {
            let turnID = liveTurnID(from: params, item: item, threadID: expectedThreadID)
            let id = item["id"] as? String ?? "\(turnID ?? expectedThreadID)-images"
            let message = ChatMessage(id: id, role: .assistant, text: "", sourceTurnID: turnID, attachments: attachments)
            if let index = liveMessages.firstIndex(where: { $0.id == id }) { liveMessages[index] = message }
            else { liveMessages.append(message) }
            reloadAfterEvent(expectedThreadID)
            return
        }
        if method == "turn/started" {
            if !liveRunning { liveRunning = true }
            let turnID = params["turnId"] as? String
                ?? (params["turn"] as? [String: Any])?["id"] as? String
                ?? UUID().uuidString
            activeTurnNotificationKeys[expectedThreadID] = turnID
            // Compaction resumes the same logical turn and can emit another
            // turn/started. Preserve everything already shown for that turn.
            localError = nil
        } else if method == "item/started" {
            let item = params["item"] as? [String: Any]
            let turnID = liveTurnID(from: params, item: item, threadID: expectedThreadID)
            if let item, isCompactionItem(item) {
                recordLiveCompaction(turnID: turnID)
                return
            }
            if let item, isLiveExecutionItem(item) {
                upsertLiveExecution(
                    item: item,
                    fallbackID: params["itemId"] as? String,
                    turnID: turnID,
                    status: "inProgress"
                )
                if !liveRunning { liveRunning = true }
                return
            }
            guard let item, ["agentMessage", "plan"].contains(item["type"] as? String ?? "") else { return }
            if !liveRunning { liveRunning = true }
            guard let itemID = item["id"] as? String else { return }
            beginLiveMessage(
                id: itemID,
                turnID: turnID,
                text: liveText(from: item),
                phase: item["type"] as? String == "plan" ? "final_answer" : item["phase"] as? String
            )
        } else if method == "item/agentMessage/delta" || method == "item/plan/delta" {
            if !liveRunning { liveRunning = true }
            guard let itemID = params["itemId"] as? String else { return }
            appendLiveDelta(
                id: itemID,
                turnID: liveTurnID(from: params, threadID: expectedThreadID),
                delta: params["delta"] as? String ?? ""
            )
            if method == "item/plan/delta", let index = liveMessages.firstIndex(where: { $0.id == itemID }) {
                liveMessages[index].phase = "final_answer"
            }
        } else if method == "item/completed" || method == "item/updated" {
            let item = params["item"] as? [String: Any]
            let turnID = liveTurnID(from: params, item: item, threadID: expectedThreadID)
            if let item, isCompactionItem(item) {
                recordLiveCompaction(turnID: turnID)
                return
            }
            if let item, isLiveExecutionItem(item) {
                upsertLiveExecution(
                    item: item,
                    fallbackID: params["itemId"] as? String,
                    turnID: turnID,
                    status: item["status"] as? String ?? "completed"
                )
                return
            }
            guard let item, ["agentMessage", "plan"].contains(item["type"] as? String ?? "") else { return }
            let text = liveText(from: item)
            if let completedID = item["id"] as? String, !text.isEmpty {
                beginLiveMessage(id: completedID, turnID: turnID, text: text,
                    phase: item["type"] as? String == "plan" ? "final_answer" : item["phase"] as? String,
                    authoritative: method == "item/completed" && item["type"] as? String == "plan")
            }
        } else if method.lowercased().contains("compact") || method.lowercased().contains("compress") {
            recordLiveCompaction(turnID: liveTurnID(from: params, threadID: expectedThreadID))
        } else if ["turn/failed", "turn/interrupted", "turn/cancelled", "turn/canceled"].contains(method) {
            liveRunning = false
            if let errorText = notificationErrorText(params) {
                localError = errorText
                status = cloudexLocalized("任务失败：%@", errorText)
                notifyTaskResultOnce(threadID: expectedThreadID, params: params, success: false, detail: errorText)
            } else {
                notifyTaskResultOnce(threadID: expectedThreadID, params: params, success: false)
            }
            reloadAfterEvent(expectedThreadID, waitForTerminalSnapshot: true)
        } else if method == "turn/completed" {
            liveRunning = false
            let turn = params["turn"] as? [String: Any]
            let turnStatus = turn?["status"] as? String
            if let errorText = notificationErrorText(params) {
                localError = errorText
                status = cloudexLocalized("任务失败：%@", errorText)
                notifyTaskResultOnce(threadID: expectedThreadID, params: params, success: false, detail: errorText)
            } else if turnStatus == "failed" || turnStatus == "interrupted" {
                let detail = turnStatus == "interrupted" ? "任务已中断" : "任务失败"
                localError = detail
                status = detail
                notifyTaskResultOnce(threadID: expectedThreadID, params: params, success: false, detail: detail)
            } else {
                localError = nil
                notifyTaskResultOnce(threadID: expectedThreadID, params: params, success: true)
            }
            reloadAfterEvent(expectedThreadID, waitForTerminalSnapshot: true)
        } else if method == "thread/archived" || method == "thread/name/updated" {
            reloadAfterEvent(expectedThreadID)
        }
    }

    private func notificationErrorText(_ params: [String: Any]) -> String? {
        let turn = params["turn"] as? [String: Any]
        let rawError = turn?["error"] ?? params["error"]
        if let text = rawError as? String, !text.isEmpty { return text }
        guard let error = rawError as? [String: Any] else { return nil }
        let message = error["message"] as? String ?? "任务执行失败"
        let code = error["codexErrorInfo"] ?? error["codex_error_info"] ?? error["code"] ?? error["type"]
        if let code = code as? String, !code.isEmpty { return "\(message)\n错误代码：\(code)" }
        return message
    }

    private func notifyTaskResultOnce(
        threadID: String,
        params: [String: Any],
        success: Bool,
        detail: String? = nil
    ) {
        guard !isReadOnlyViewer, !threadStreamReplaying else { return }
        let turnID = params["turnId"] as? String
            ?? (params["turn"] as? [String: Any])?["id"] as? String
        let key = activeTurnNotificationKeys[threadID]
            ?? turnID
            ?? "thread-\(threadID)"
        guard sentTaskResultNotificationKeys.insert("\(threadID):\(key)").inserted else { return }
        CloudexAppDelegate.notifications.scheduleTaskResult(
            threadID: threadID,
            title: selectedThread?.title ?? "当前对话",
            success: success,
            detail: detail
        )
    }

    private func reloadAfterEvent(_ threadID: String, waitForTerminalSnapshot: Bool = false) {
        checkpointConversation()
        terminalReloadPending = terminalReloadPending || waitForTerminalSnapshot
        guard eventReloadTask == nil else {
            if detailRequestInFlight != nil { detailRefreshPending = true }
            return
        }
        let openGeneration = threadOpenGeneration
        let connection = connectionGeneration
        let terminalTurnID = activeTurnNotificationKeys[threadID]
        eventReloadTask = Task { [weak self] in
            guard let self else { return }
            let terminal = self.terminalReloadPending
            self.terminalReloadPending = false
            defer {
                if self.threadOpenGeneration == openGeneration, self.connectionGeneration == connection {
                    self.eventReloadTask = nil
                    if self.terminalReloadPending { self.reloadAfterEvent(threadID, waitForTerminalSnapshot: true) }
                }
            }
            let delays: [Duration] = terminal
                ? [.milliseconds(100), .milliseconds(500), .seconds(1), .seconds(2)]
                : [.milliseconds(100)]
            for delay in delays {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, self.selectedThreadID == threadID,
                      self.threadOpenGeneration == openGeneration, self.connectionGeneration == connection else { return }
                await self.loadThread(threadID, force: true)
                if !terminal || self.hasTerminalSnapshot(for: threadID, turnID: terminalTurnID) {
                    break
                }
            }
            if terminal { await self.refresh() }
        }
    }

    private func hasTerminalSnapshot(for threadID: String, turnID: String?) -> Bool {
        guard selectedThreadID == threadID,
              !liveRunning,
              selectedThread?.isActive != true,
              let lastTurn = detail?.turns.last,
              lastTurn.status != nil else { return false }
        return (turnID == nil || lastTurn.id == turnID) && !isTurnInProgress(lastTurn)
            && !liveMessages.contains { $0.role == .assistant && $0.phase != "commentary" && liveMessageTurnIDs[$0.id] == lastTurn.id }
    }

    private func startPolling(threadID: String) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled, let self, self.selectedThreadID == threadID else { return }
                guard self.active else { return }
                // Desktop-started turns can update the persisted session
                // without emitting notifications on this app-server stream.
                // Keep the selected conversation current with a snapshot
                // fallback. ContentView merges these rows without issuing a
                // scroll request when the user is not following the bottom.
                await self.loadThread(threadID, force: true)
            }
        }
    }

    deinit {
        cacheCheckpointTask?.cancel()
        pollTask?.cancel()
        globalSSE.stop()
        threadSSE.stop()
    }
}
