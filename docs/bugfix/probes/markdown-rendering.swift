import Foundation

// swiftc -parse-as-library -target arm64-apple-macosx14.0 apps/ios-native/CloudexNative/MarkdownRendering.swift docs/bugfix/probes/markdown-rendering.swift -o /tmp/cloudex-markdown-check
@main
struct MarkdownRenderingCheck {
    static func main() async throws {
        let source = "**粗体**与[链接](https://example.com)\n\n> 引用\n\n- 第一项\n- 第二项\n\n```swift\nlet x = 1\n```\n\n| A | B |\n| --- | --- |\n| a\\|b | c<br>d |"
        let document = try await MarkdownRenderer.shared.prepare(source)
        precondition(document.blocks.count == 5)
        guard case let .paragraph(paragraph) = document.blocks[0].content,
              case let .quote(quote) = document.blocks[1].content,
              case let .list(list) = document.blocks[2].content,
              case let .code(code, language) = document.blocks[3].content,
              case let .table(table) = document.blocks[4].content else { fatalError("Lost Markdown block types") }
        precondition(paragraph.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        precondition(paragraph.runs.contains { $0.link == URL(string: "https://example.com") })
        precondition(String(quote.characters) == "引用" && list.count == 2)
        precondition(code == "let x = 1" && language == "swift")
        precondition(table.count == 2 && String(table[1][0].characters) == "a|b")
        let cached = try await MarkdownRenderer.shared.prepare(source)
        precondition(cached === document, "Unchanged history must reuse prepared output")
        let literal = try await MarkdownRenderer.shared.prepare(source, markdown: false)
        guard case let .paragraph(plain) = literal.blocks[0].content else { fatalError() }
        precondition(String(plain.characters) == source, "User text must remain literal")
        let unfinished = try await MarkdownRenderer.shared.prepare("```swift\nlet x =")
        let finished = try await MarkdownRenderer.shared.prepare("```swift\nlet x = 1\n```\n\n完成")
        precondition(unfinished.blocks.count == 1 && finished.blocks.count == 2)
        guard case let .code(finalCode, _) = finished.blocks[0].content else { fatalError() }
        precondition(finalCode == "let x = 1", "Streaming completion must not reuse an older revision")
        let long = String(repeating: source + "\n\n", count: 100)
        let start = ContinuousClock.now
        let longDocument = try await MarkdownRenderer.shared.prepare(long)
        precondition(longDocument.blocks.count == 500)
        print("Markdown correctness/cache checks passed; 500 mixed blocks: \(start.duration(to: .now))")
    }
}
