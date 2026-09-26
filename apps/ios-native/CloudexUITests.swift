import XCTest

final class CloudexUITests: XCTestCase {
    func testBottomRemainsVisibleAfterRepeatedFlicks() {
        let app = scrollingApp(extraArguments: ["--ui-uneven-fixture"])
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "滚动回归 0").firstMatch.tap()
        let chat = app.scrollViews["chat-history"]
        let last = app.staticTexts["这是实际的最后一条回复。"]
        XCTAssertTrue(last.waitForExistence(timeout: 10))
        for iteration in 0..<3 {
            chat.swipeDown(velocity: .fast)
            chat.swipeDown(velocity: .fast)
            let latest = app.buttons["滚动到最新消息"]
            XCTAssertTrue(latest.waitForExistence(timeout: 5))
            latest.tap()
            for _ in 0..<3 { chat.swipeUp(velocity: .fast) }
            snapshot("bottom-after-flicks-\(iteration)")
            XCTAssertTrue(last.isHittable, "The last reply must remain visible at the bottom")
            XCTAssertLessThan(chat.frame.maxY - last.frame.maxY, 100, "No empty viewport below the final reply")
        }
    }

    func testScrollToLatestAfterBrowsing() {
        let app = scrollingApp()
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "滚动回归 0").firstMatch.tap()
        let chat = app.scrollViews["chat-history"]
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        let latestCode = app.staticTexts["let count = 35\nprint(count)"]
        XCTAssertTrue(latestCode.waitForExistence(timeout: 5))
        chat.swipeDown(velocity: .fast)
        chat.swipeDown(velocity: .fast)
        XCTAssertFalse(latestCode.isHittable)
        let latest = app.buttons["滚动到最新消息"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        latest.tap()
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: latestCode)
        XCTAssertEqual(XCTWaiter.wait(for: [visible], timeout: 5), .completed)
        snapshot("markdown-after-scroll-to-latest")
    }

    func testHomeScrollPerformance() {
        let app = scrollingApp()
        app.buttons["展开CV"].tap()
        let list = app.collectionViews.firstMatch
        XCTAssertTrue(list.exists)
        measureScrolling(app, element: list)
    }

    func testConversationScrollPerformance() {
        let app = scrollingApp()
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "滚动回归 0").firstMatch.tap()
        let chat = app.scrollViews["chat-history"]
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.waitForExistence(timeout: 10))
        measureScrolling(app, element: chat)
    }

    private func scrollingApp(extraArguments: [String] = []) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixture", "--ui-scroll-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launchArguments += extraArguments
        app.launch()
        XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
        return app
    }

    private func measureScrolling(_ app: XCUIApplication, element: XCUIElement) {
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTOSSignpostMetric.scrollDecelerationMetric, XCTCPUMetric(application: app)], options: options) {
            element.swipeUp(velocity: .fast)
            element.swipeUp(velocity: .fast)
            element.swipeDown(velocity: .fast)
            element.swipeDown(velocity: .fast)
        }
    }

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
