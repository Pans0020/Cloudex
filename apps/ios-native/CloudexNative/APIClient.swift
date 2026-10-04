import Foundation

enum APIClientError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case server(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            return "服务器地址无效"
        case .invalidResponse:
            return "服务器返回了无法识别的响应"
        case let .server(status, message):
            return message.isEmpty ? "HTTP \(status)" : message
        }
    }
}

struct APIClient {
    let serverURL: String
    let token: String

    private var normalizedBaseURL: String {
        serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    func makeURL(path: String, queryItems: [URLQueryItem] = []) throws -> URL {
        guard let base = URLComponents(string: normalizedBaseURL),
              ["http", "https"].contains(base.scheme?.lowercased() ?? ""),
              let host = base.host, !host.isEmpty, base.query == nil, base.fragment == nil,
              var components = URLComponents(string: normalizedBaseURL + path) else {
            throw APIClientError.invalidServerURL
        }
        if !queryItems.isEmpty { components.queryItems = queryItems }
        guard let url = components.url else { throw APIClientError.invalidServerURL }
        return url
    }

    func threadPath(_ threadID: String, action: String? = nil) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let encoded = threadID.addingPercentEncoding(withAllowedCharacters: allowed) ?? threadID
        return "/api/threads/\(encoded)" + (action.map { "/\($0)" } ?? "")
    }

    func threadTurnPath(_ threadID: String, turnID: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let encodedTurnID = turnID.addingPercentEncoding(withAllowedCharacters: allowed) ?? turnID
        return threadPath(threadID, action: "turns/\(encodedTurnID)")
    }

    func approvalPath(_ approvalID: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        let encoded = approvalID.addingPercentEncoding(withAllowedCharacters: allowed) ?? approvalID
        return "/api/approvals/\(encoded)/respond"
    }

    func get<T: Decodable>(_ path: String, queryItems: [URLQueryItem] = [], timeout: TimeInterval = 15) async throws -> T {
        var request = URLRequest(url: try makeURL(path: path, queryItems: queryItems))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return try await send(request, timeout: timeout)
    }

    // Reads can race routes safely; a dead LAN must not delay a working VPN.
    static func getFirstAvailable<T: Decodable>(_ path: String, servers: [String], token: String,
                                                timeout: TimeInterval = 15) async throws -> (APIClient, T) {
        try await withThrowingTaskGroup(of: (APIClient, Result<T, Error>).self) { group in
            for (index, server) in servers.enumerated() {
                group.addTask {
                    let client = APIClient(serverURL: server, token: token)
                    do {
                        // Keep a healthy route stable; fall back promptly when it stalls.
                        if index > 0 { try await Task.sleep(for: .milliseconds(250)) }
                        try Task.checkCancellation()
                        return (client, .success(try await client.get(path, timeout: timeout)))
                    }
                    catch { return (client, .failure(error)) }
                }
            }
            var lastError: Error = APIClientError.invalidServerURL
            for try await (client, result) in group {
                switch result {
                case .success(let value):
                    group.cancelAll()
                    return (client, value)
                case .failure(let error): lastError = error
                }
            }
            throw lastError
        }
    }

    func post<T: Decodable>(_ path: String, json: [String: Any] = [:]) async throws -> T {
        var request = URLRequest(url: try makeURL(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: json)
        return try await send(request)
    }

    func download(_ path: String, queryItems: [URLQueryItem] = []) async throws -> Data {
        var request = URLRequest(url: try makeURL(path: path, queryItems: queryItems))
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = object?["error"] as? String ?? String(data: data, encoding: .utf8) ?? ""
            throw APIClientError.server(status: http.statusCode, message: message)
        }
        return data
    }

    func uploadImage(_ data: Data) async throws -> RemoteFileEntry {
        var request = URLRequest(url: try makeURL(path: "/api/uploads/image"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (responseData, response) = try await URLSession.shared.upload(for: request, from: data)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        guard http.statusCode == 201 else {
            let object = (try? JSONSerialization.jsonObject(with: responseData)) as? [String: Any]
            throw APIClientError.server(status: http.statusCode, message: object?["error"] as? String ?? "上传失败")
        }
        return try JSONDecoder().decode(RemoteFileEntry.self, from: responseData)
    }

    private func send<T: Decodable>(_ requestValue: URLRequest, timeout: TimeInterval? = nil) async throws -> T {
        var request = requestValue
        // A cold history read and the server's 30-second write RPC can exceed 6s.
        request.timeoutInterval = timeout ?? (request.httpMethod == "GET" ? 15 : 45)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = object?["error"] as? String ?? String(data: data, encoding: .utf8) ?? ""
            throw APIClientError.server(status: http.statusCode, message: message)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIClientError.invalidResponse
        }
    }
}
