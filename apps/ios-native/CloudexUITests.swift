import XCTest

final class CloudexUITests: XCTestCase {
    func testComposerAndProjectLayout() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        let project = app.buttons["展开CV"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["展开Calcu"].exists)
        snapshot("home-collapsed")
        project.tap()
        XCTAssertTrue(app.buttons["折叠CV"].exists)
        snapshot("home-expanded")
        app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()

        let input = app.descendants(matching: .any).matching(identifier: "message-input").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let attachment = app.buttons["添加附件"]
        let voice = app.buttons["开始语音输入"]
        let model = app.buttons["切换模型和推理强度"]
        XCTAssertEqual(attachment.frame.midY, voice.frame.midY, accuracy: 3)
        XCTAssertEqual(attachment.frame.midY, model.frame.midY, accuracy: 3)
        XCTAssertLessThan(attachment.frame.maxY, input.frame.minY + 2)
        XCTAssertLessThanOrEqual(app.scrollViews["chat-history"].frame.maxY, attachment.frame.minY)
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "attachment-thumbnail").firstMatch.exists)
        snapshot("chat-attachment")

        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let longText = String(repeating: "Long input stays within five lines.\n", count: 12)
        input.typeText(longText)
        XCTAssertEqual(input.value as? String, longText)
        snapshot("chat-long-input-before-geometry-check")
        XCTAssertLessThan(input.frame.height, 170)
        XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        XCTAssertLessThan(attachment.frame.maxY, input.frame.minY + 2)
        XCTAssertLessThanOrEqual(app.scrollViews["chat-history"].frame.maxY, attachment.frame.minY)
        snapshot("chat-long-input-keyboard")

        let chat = app.scrollViews["chat-history"]
        print("UI_GEOMETRY chat=\(chat.frame) input=\(input.frame) toolbar=\(attachment.frame) app=\(app.frame)")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        snapshot("chat-after-keyboard-drag")
        let disappeared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [disappeared], timeout: 5), .completed)
        XCTAssertLessThan(input.frame.height, 170)
        snapshot("chat-long-input-dismissed")
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(input.frame.maxY, app.keyboards.firstMatch.frame.minY + 2)
        snapshot("chat-long-input-refocused")
    }

    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
