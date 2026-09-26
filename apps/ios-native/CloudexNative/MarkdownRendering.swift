import Foundation
import os

// Immutable, theme-independent output. Parsing never runs from SwiftUI.body.
final class PreparedMarkdown: Sendable, Equatable {
    struct Block: Identifiable, Sendable {
        enum Content: Sendable {
            case paragraph(AttributedString)
            case quote(AttributedString)
            case list([Item])
            case code(String, String)
            case table([[AttributedString]])
        }
        let id: Int
        let content: Content
    }
    struct Item: Identifiable, Sendable {
        let id: Int
        let marker: String
        let text: AttributedString
    }
    let blocks: [Block]
    init(blocks: [Block]) { self.blocks = blocks }
    static func == (lhs: PreparedMarkdown, rhs: PreparedMarkdown) -> Bool { lhs === rhs }
}

actor MarkdownRenderer {
    static let shared = MarkdownRenderer()
    private let cache: NSCache<NSString, PreparedMarkdown> = {
        let cache = NSCache<NSString, PreparedMarkdown>()
        cache.countLimit = 128
        cache.totalCostLimit = 8 * 1024 * 1024
        return cache
    }()
    private let log = OSLog(subsystem: "com.cloudex.native", category: "Markdown")
    func prepare(_ text: String, markdown: Bool = true) throws -> PreparedMarkdown {
        let key = "\(markdown ? "md" : "plain"):\(text)" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        try Task.checkCancellation()
        let signpost = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "MarkdownPrepare", signpostID: signpost)
        defer { os_signpost(.end, log: log, name: "MarkdownPrepare", signpostID: signpost) }
        let result = try MarkdownParser.prepare(text, markdown: markdown)
        cache.setObject(result, forKey: key, cost: text.utf8.count * 4)
        return result
    }
}

enum MarkdownParser {
    static func prepare(_ text: String, markdown: Bool = true) throws -> PreparedMarkdown {
        if !markdown {
            return PreparedMarkdown(blocks: [.init(id: 0, content: .paragraph(AttributedString(text)))])
        }
        let prepared = try blocks(from: text).map { block -> PreparedMarkdown.Block in
            try Task.checkCancellation()
            let content: PreparedMarkdown.Block.Content
            switch block.content {
            case let .paragraph(value): content = .paragraph(inline(value))
            case let .quote(value): content = .quote(inline(value))
            case let .list(items):
                content = .list(items.map { .init(id: $0.id, marker: $0.marker, text: inline($0.text)) })
            case let .code(value, language): content = .code(value, language)
            case let .table(rows):
                content = .table(rows.map { row in row.map {
                    inline($0.replacingOccurrences(of: #"(?i)<br\s*/?>"#, with: "\n", options: .regularExpression))
                } })
            }
            return .init(id: block.id, content: content)
        }
        return PreparedMarkdown(blocks: prepared)
    }

    private static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    private static func blocks(from source: String) -> [MarkdownBlock] {
        let lines = source
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var index = 0
        var blockID = 0

        func appendBlock(_ content: MarkdownBlock.Content) {
            blocks.append(MarkdownBlock(id: blockID, content: content))
            blockID += 1
        }

        func flushParagraph() {
            let value = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty {
                appendBlock(.paragraph(value))
            }
            paragraph.removeAll(keepingCapacity: true)
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if let language = Self.fenceLanguage(in: trimmed) {
                flushParagraph()
                index += 1
                var codeLines: [String] = []
                while index < lines.count {
                    let codeLine = lines[index]
                    if codeLine.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                        index += 1
                        break
                    }
                    codeLines.append(codeLine)
                    index += 1
                }
                appendBlock(.code(codeLines.joined(separator: "\n"), language))
                continue
            }

            if index + 1 < lines.count,
               trimmed.contains("|"),
               Self.isTableSeparator(lines[index + 1]) {
                flushParagraph()
                var rows = [Self.tableRow(from: line)]
                index += 2
                while index < lines.count {
                    let row = lines[index]
                    let rowTrimmed = row.trimmingCharacters(in: .whitespaces)
                    guard !rowTrimmed.isEmpty, rowTrimmed.contains("|") else { break }
                    rows.append(Self.tableRow(from: row))
                    index += 1
                }
                if rows.first?.count ?? 0 > 0 {
                    appendBlock(.table(rows))
                }
                continue
            }

            if let item = Self.listItem(from: line, id: blockID) {
                flushParagraph()
                var items = [item]
                index += 1
                while index < lines.count {
                    let nextLine = lines[index]
                    guard let nextItem = Self.listItem(from: nextLine, id: blockID + items.count) else { break }
                    items.append(nextItem)
                    index += 1
                }
                appendBlock(.list(items))
                continue
            }

            if Self.isQuoteLine(line) {
                flushParagraph()
                var quoteLines: [String] = []
                while index < lines.count, Self.isQuoteLine(lines[index]) {
                    quoteLines.append(Self.quoteText(from: lines[index]))
                    index += 1
                }
                appendBlock(.quote(quoteLines.joined(separator: "\n")))
                continue
            }

            if Self.isIndentedCode(line) {
                flushParagraph()
                var codeLines: [String] = []
                while index < lines.count {
                    let codeLine = lines[index]
                    if codeLine.isEmpty {
                        codeLines.append("")
                        index += 1
                    } else if Self.isIndentedCode(codeLine) {
                        let indentation = codeLine.hasPrefix("\t") ? 1 : min(4, codeLine.count)
                        codeLines.append(String(codeLine.dropFirst(indentation)))
                        index += 1
                    } else {
                        break
                    }
                }
                while codeLines.last?.isEmpty == true { codeLines.removeLast() }
                appendBlock(.code(codeLines.joined(separator: "\n"), ""))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
            } else {
                paragraph.append(line)
            }
            index += 1
        }
        flushParagraph()
        return blocks
    }

    private static func fenceLanguage(in line: String) -> String? {
        guard line.hasPrefix("```") else { return nil }
        return String(line.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isIndentedCode(_ line: String) -> Bool {
        line.hasPrefix("    ") || line.hasPrefix("\t")
    }

    private static func isQuoteLine(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix(">")
    }

    private static func quoteText(from line: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces)
    }

    private static func listItem(from line: String, id: Int) -> MarkdownListItem? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }

        if let first = trimmed.first, ["-", "*", "+"].contains(first) {
            let remainder = trimmed.dropFirst()
            guard remainder.first?.isWhitespace == true else { return nil }
            let text = remainder.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return nil }
            return MarkdownListItem(id: id, marker: "•", text: text)
        }

        var digits = ""
        var index = trimmed.startIndex
        while index < trimmed.endIndex, trimmed[index].isNumber {
            digits.append(trimmed[index])
            index = trimmed.index(after: index)
        }
        guard !digits.isEmpty, index < trimmed.endIndex else { return nil }
        let separator = trimmed[index]
        guard separator == "." || separator == ")" else { return nil }
        index = trimmed.index(after: index)
        guard index < trimmed.endIndex, trimmed[index].isWhitespace else { return nil }
        let text = trimmed[index...].trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        return MarkdownListItem(id: id, marker: "\(digits).", text: text)
    }

    private static func isTableSeparator(_ line: String) -> Bool {
        let cells = tableRow(from: line)
        guard cells.count >= 2 else { return false }
        return cells.allSatisfy { cell in
            let value = cell.trimmingCharacters(in: .whitespaces)
            let withoutEdges = value.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return withoutEdges.count >= 3 && withoutEdges.allSatisfy { $0 == "-" }
        }
    }

    private static func tableRow(from line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }

        var cells: [String] = []
        var current = ""
        var escaped = false
        for character in value {
            if character == "|" && !escaped {
                cells.append(current.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\\|", with: "|"))
                current = ""
            } else {
                current.append(character)
            }
            escaped = character == "\\" && !escaped
        }
        cells.append(current.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\\|", with: "|"))
        return cells
    }
}

private struct MarkdownBlock: Identifiable {
    enum Content {
        case paragraph(String)
        case quote(String)
        case list([MarkdownListItem])
        case code(String, String)
        case table([[String]])
    }
    let id: Int
    let content: Content
}
private struct MarkdownListItem: Identifiable {
    let id: Int
    let marker: String
    let text: String
}
