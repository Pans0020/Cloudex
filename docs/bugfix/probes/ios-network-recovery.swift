import Foundation

// Standalone transport check: no simulator, app install, server or credentials.
// swiftc -DDEBUG -parse-as-library apps/ios-native/CloudexNative/APIClient.swift apps/ios-native/CloudexNative/SSEClient.swift docs/bugfix/probes/ios-network-recovery.swift -o /tmp/cloudex-network-check
struct SSEEvent { let id: String?; let name: String; let data: Data }
struct RemoteFileEntry: Decodable { let name: String }
private struct ValueResponse: Decodable { let value: String }

private final class ProbeState: @unchecked Sendable {
    let lock = NSLock()
    var requests: [URLRequest] = []
    var cancellations = 0
    func record(_ request: URLRequest) -> Int {
        lock.withLock {
            requests.append(request)
            return requests.filter { $0.url?.host == request.url?.host }.count
        }
    }
}

private final class ProbeProtocol: URLProtocol, @unchecked Sendable {
    static let state = ProbeState()
    private var delivery: DispatchWorkItem?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let attempt = Self.state.record(request)
        let stream = request.url?.host == "stream.invalid"
        let fail = request.url?.host == "fail.invalid"
        let work = DispatchWorkItem { [self] in
            let response = HTTPURLResponse(url: request.url!, statusCode: fail ? 503 : 200,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": stream ? "text/event-stream" : "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            let body = stream ? "id: epoch:\(attempt + 6)\nevent: notification\ndata: \(attempt)\n\n"
                : #"{"value":""# + (request.url?.host == "fast.invalid" ? "fast" : "slow") + #""}"#
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            if !stream || attempt == 1 { client?.urlProtocolDidFinishLoading(self) }
        }
        delivery = work
        DispatchQueue.global().asyncAfter(deadline: .now() + (request.url?.host == "slow.invalid" ? 2 : 0.01), execute: work)
    }
    override func stopLoading() {
        delivery?.cancel()
        Self.state.lock.withLock { Self.state.cancellations += 1 }
    }
}

@main
private struct NetworkRecoveryCheck {
    @MainActor static func main() async throws {
        URLProtocol.registerClass(ProbeProtocol.self)
        defer { URLProtocol.unregisterClass(ProbeProtocol.self) }
        let start = ContinuousClock.now
        let (available, value): (APIClient, ValueResponse) = try await APIClient.getFirstAvailable(
            "/read", servers: ["http://slow.invalid", "http://fast.invalid"], token: "")
        precondition(available.serverURL == "http://fast.invalid" && value.value == "fast")
        precondition(start.duration(to: .now) < .seconds(1), "A stalled LAN delayed the usable route")
        precondition(ProbeProtocol.state.lock.withLock { ProbeProtocol.state.cancellations > 0 }, "Losing reads were left running")
        let (_, fallback): (APIClient, ValueResponse) = try await APIClient.getFirstAvailable(
            "/read", servers: ["http://fail.invalid", "http://fast.invalid"], token: "")
        precondition(fallback.value == "fast", "The first route failure cancelled a usable fallback")
        do {
            let _: ValueResponse = try await APIClient(serverURL: "http://fail.invalid", token: "").post("/write")
            preconditionFailure("Expected the write failure")
        } catch APIClientError.server(let status, _) { precondition(status == 503) }
        let reads = ProbeProtocol.state.lock.withLock { ProbeProtocol.state.requests.filter { $0.httpMethod == "GET" } }
        precondition(reads.allSatisfy { $0.cachePolicy == .reloadIgnoringLocalCacheData }, "Live snapshots used an HTTP cache")
        let writes = ProbeProtocol.state.lock.withLock { ProbeProtocol.state.requests.filter { $0.httpMethod == "POST" } }
        precondition(writes.count == 1 && writes[0].timeoutInterval == 45, "A side-effecting write was retried or timed out early")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProbeProtocol.self]
        let stream = SSEClient(configuration: configuration)
        var values: [String] = []
        var resolved = false
        let resumed = await withCheckedContinuation { continuation in
            let deadline = Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled, !resolved else { return }
                resolved = true
                continuation.resume(returning: false)
            }
            stream.onEvent = { event in
                MainActor.assumeIsolated {
                    values.append(String(decoding: event.data, as: UTF8.self))
                    if values.count == 2 && !resolved {
                        resolved = true
                        deadline.cancel()
                        continuation.resume(returning: true)
                    }
                }
            }
            stream.start(url: URL(string: "http://stream.invalid/events")!, token: "")
        }
        stream.stop()
        precondition(resumed && values == ["1", "2"], "SSE EOF did not reconnect promptly and preserve event order")
        let subscriptions = ProbeProtocol.state.lock.withLock { ProbeProtocol.state.requests.filter { $0.url?.host == "stream.invalid" } }
        precondition(subscriptions.count == 2 && subscriptions[0].value(forHTTPHeaderField: "Last-Event-ID") == nil
            && subscriptions[1].value(forHTTPHeaderField: "Last-Event-ID") == "epoch:7", "SSE reconnect lost its cursor")
        SSEClient.checkReconnectIsolation()
        print("Transport recovery passed: stalled/failed routes, loser cancellation, fresh GETs, single-attempt POST, ordered SSE resume")
    }
}
