import Foundation

// Each connection owns its parser; chunks can split UTF-8 characters or CRLF.
final class SSEParser {
    private var lineBytes: [UInt8] = []
    private var previousWasCR = false
    private var firstLine = true
    private var eventID: String?
    private var eventName = "message"
    private var dataLines: [String] = []

    func append(_ data: Data) -> [SSEEvent] {
        var events: [SSEEvent] = []
        for byte in data {
            if byte == 0x0A && previousWasCR { previousWasCR = false; continue }
            previousWasCR = byte == 0x0D
            guard byte == 0x0A || byte == 0x0D else { lineBytes.append(byte); continue }
            var line = String(decoding: lineBytes, as: UTF8.self)
            lineBytes.removeAll(keepingCapacity: true)
            if firstLine { firstLine = false; if line.hasPrefix("\u{FEFF}") { line.removeFirst() } }
            if line.isEmpty {
                if !dataLines.isEmpty {
                    events.append(SSEEvent(id: eventID, name: eventName.isEmpty ? "message" : eventName,
                                           data: Data(dataLines.joined(separator: "\n").utf8)))
                }
                eventID = nil; eventName = "message"; dataLines.removeAll(keepingCapacity: true)
                continue
            }
            guard !line.hasPrefix(":") else { continue }
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            var value = parts.count > 1 ? String(parts[1]) : ""
            if value.hasPrefix(" ") { value.removeFirst() }
            switch parts[0] {
            case "id": if !value.contains("\0") { eventID = value }
            case "event": eventName = value
            case "data": dataLines.append(value)
            default: break
            }
        }
        return events
    }
}

final class SSEClient: NSObject, URLSessionDataDelegate {
    var onOpen: (() -> Void)?
    var onEvent: ((SSEEvent) -> Void)?
    var onDisconnect: ((String) -> Void)?

    private var session: URLSession?
    private let configuration: URLSessionConfiguration
    private var task: URLSessionDataTask?
    private let parsingQueue = DispatchQueue(label: "cloudex.sse-parser", qos: .userInitiated)
    private var parser = SSEParser()
    private var endpoint: URL?
    private var token = ""
    private var intentionallyStopped = true
    private var reconnectScheduled = false
    private var reportedStatusError: String?
    private var connectionGeneration = 0
    private var reconnectAttempt = 0
    private(set) var lastEventID: String?

    func resume(after eventID: String) { lastEventID = eventID }

    init(configuration: URLSessionConfiguration = .default) {
        self.configuration = configuration
        super.init()
    }

    func start(url: URL, token: String) {
        stop()
        endpoint = url
        self.token = token
        intentionallyStopped = false
        reconnectAttempt = 0
        lastEventID = nil
        connect()
    }

    func stop() {
        intentionallyStopped = true
        connectionGeneration += 1
        reconnectScheduled = false
        task?.cancel()
        session?.invalidateAndCancel()
        task = nil
        session = nil
        parser = SSEParser()
    }

    private func connect() {
        guard !intentionallyStopped, let endpoint else { return }
        parser = SSEParser()
        reportedStatusError = nil
        let configuration = configuration
        // Both server streams send a heartbeat every 15 seconds.
        configuration.timeoutIntervalForRequest = 45
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        var request = URLRequest(url: endpoint)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let lastEventID, !lastEventID.isEmpty {
            request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID")
        }
        let task = session.dataTask(with: request)
        self.task = task
        task.resume()
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard dataTask === task else {
            completionHandler(.cancel)
            return
        }
        guard let http = response as? HTTPURLResponse else {
            reportedStatusError = "实时连接响应无效"
            completionHandler(.cancel)
            return
        }
        guard (200..<300).contains(http.statusCode) else {
            reportedStatusError = "实时连接已关闭 (\(http.statusCode))"
            completionHandler(.cancel)
            return
        }
        guard http.mimeType?.lowercased() == "text/event-stream" else {
            reportedStatusError = "实时连接返回了非事件流响应"
            completionHandler(.cancel)
            return
        }
        reconnectAttempt = 0
        onOpen?()
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard dataTask === task else { return }
        let parser = parser
        parsingQueue.async { [weak self] in
            let events = parser.append(data)
            guard !events.isEmpty else { return }
            DispatchQueue.main.async { [weak self] in
                guard let self, dataTask === self.task, !self.intentionallyStopped else { return }
                for event in events {
                    if let id = event.id { self.lastEventID = id }
                    self.onEvent?(event)
                }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        // Cancelling an old stream is asynchronous. Its completion callback
        // can arrive after start() has already installed a replacement task.
        // Ignore that stale callback so it cannot report or reconnect over
        // the healthy replacement stream.
        guard task === self.task else { return }
        guard !intentionallyStopped else { return }
        let message = reportedStatusError ?? error?.localizedDescription ?? "实时连接已关闭"
        onDisconnect?(message)
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !intentionallyStopped, !reconnectScheduled else { return }
        reconnectScheduled = true
        let generation = connectionGeneration
        let delay = min(0.5 * pow(2, Double(reconnectAttempt)), 30)
        reconnectAttempt = min(reconnectAttempt + 1, 6)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.reconnect(ifCurrent: generation)
        }
    }

    private func reconnect(ifCurrent generation: Int) {
        guard !intentionallyStopped, connectionGeneration == generation else { return }
        reconnectScheduled = false
        session?.invalidateAndCancel()
        session = nil
        task = nil
        connect()
    }

    #if DEBUG
    static func checkReconnectIsolation() {
        let client = SSEClient()
        let oldGeneration = client.connectionGeneration
        client.stop()
        client.intentionallyStopped = false
        client.endpoint = URL(string: "http://127.0.0.1:1")!
        client.reconnect(ifCurrent: oldGeneration)
        precondition(client.task == nil, "A stale retry replaced a newer connection")
        client.stop()
    }
    #endif

    deinit { stop() }
}
