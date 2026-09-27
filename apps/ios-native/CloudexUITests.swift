import XCTest

final class CloudexUITests: XCTestCase {
    func testQueuedMessagesStaySeparateAfterRelaunch() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixture", "--ui-queue-fixture", "-AppleLanguages", "(zh-Hans)"]
        app.launch()
        XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()
        let input = app.textViews["message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        let token = String(UUID().uuidString.prefix(6))
        for index in 1...3 {
            input.tap(); input.typeText("queue-\(token)-\(index)")
            app.buttons["等待发送"].tap()
            XCTAssertTrue(app.staticTexts["queue-\(token)-\(index)"].waitForExistence(timeout: 5))
        }
        snapshot("three-independent-queued-messages")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "无法同步队列")).firstMatch.exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()
        XCTAssertTrue(app.staticTexts["queue-\(token)-3"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", "queue-\(token)-1", "queue-\(token)-2")).firstMatch.exists)
        snapshot("queue-restored-after-relaunch")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "无法同步队列")).firstMatch.exists)
    }
    func testFilePreviewAndPlanMode() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixture", "--ui-preview-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()
        let link = app.links["查看实际界面截图"]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
        XCTAssertTrue(app.staticTexts["这是内置 Markdown 文档。"].waitForExistence(timeout: 10))
        snapshot("rendered-markdown-preview")
        app.buttons["预览图片"].tap()
        XCTAssertTrue(app.navigationBars["picture.png"].waitForExistence(timeout: 10))
        snapshot("image-preview")
        app.buttons["完成"].firstMatch.tap()
        app.links["打开 HTML"].tap()
        XCTAssertTrue(app.webViews.staticTexts["HTML 预览成功"].waitForExistence(timeout: 10))
        app.switches["交互脚本"].tap()
        XCTAssertTrue(app.webViews.buttons["测试交互"].waitForExistence(timeout: 10))
        app.webViews.buttons["测试交互"].tap()
        XCTAssertTrue(app.webViews.staticTexts["交互成功"].waitForExistence(timeout: 5))
        snapshot("html-preview")
        app.buttons["完成"].firstMatch.tap()
        app.links["播放 GIF"].tap()
        XCTAssertTrue(app.buttons["暂停"].waitForExistence(timeout: 10))
        app.buttons["暂停"].tap()
        XCTAssertTrue(app.buttons["播放"].exists)
        snapshot("gif-preview")
        app.buttons["完成"].firstMatch.tap()
        app.links["打开 PPT"].tap()
        XCTAssertTrue(app.navigationBars["slides.pptx"].waitForExistence(timeout: 10))
        let slide = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Cloudex PPT Preview")).firstMatch
        XCTAssertTrue(slide.waitForExistence(timeout: 15))
        snapshot("ppt-preview")
        app.buttons["完成"].firstMatch.tap()
        app.buttons["完成"].firstMatch.tap()
        let model = app.buttons["切换模型和推理强度"]
        XCTAssertTrue(model.exists); model.tap()
        let plan = app.buttons["计划模式"]
        XCTAssertTrue(plan.waitForExistence(timeout: 5)); plan.tap()
        XCTAssertTrue(app.buttons["按此计划执行"].waitForExistence(timeout: 5))
        snapshot("plan-mode-menu")
        app.buttons["按此计划执行"].tap()
        XCTAssertTrue((app.textViews["message-input"].value as? String)?.contains("请按刚才确认的计划开始执行") == true)
        XCTAssertFalse(app.buttons["按此计划执行"].exists)
    }
    func testGlassAppearanceInLightAndDark() {
        continueAfterFailure = false
        for dark in [false, true] {
            let app = XCUIApplication()
            app.launchArguments = ["--ui-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
            if dark { app.launchArguments.append("--ui-dark-fixture") }
            app.launch()
            XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
            let mode = dark ? "dark" : "light"
            snapshot("glass-\(mode)-home-collapsed")
            app.buttons["展开CV"].tap()
            snapshot("glass-\(mode)-home-expanded")
            app.buttons["打开设置"].tap()
            XCTAssertTrue(app.staticTexts["扫描服务器二维码"].waitForExistence(timeout: 5))
            snapshot("glass-\(mode)-settings")
            app.buttons["完成"].tap()
            app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()
            let chat = app.collectionViews["chat-history"]
            XCTAssertTrue(chat.waitForExistence(timeout: 10))
            XCTAssertTrue(app.buttons["发送消息"].exists)
            snapshot("glass-\(mode)-conversation")
            XCTAssertTrue(chat.staticTexts.allElementsBoundByIndex.contains { $0.isHittable })
            app.terminate()
        }
    }

    func testProcessPositionSurvivesLoadingFailureAndExpansion() {
        verifyProcessPosition(empty: false)
    }

    func testEmptyProcessDetailsKeepTheirHeader() {
        verifyProcessPosition(empty: true)
    }

    private func verifyProcessPosition(empty: Bool) {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixture", "--ui-process-fixture", "-AppleLanguages", "(zh-Hans)"]
        if empty { app.launchArguments.append("--ui-process-empty-fixture") }
        app.launch()
        XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()
        let process = app.buttons["process-toggle-ui-turn-5"]
        XCTAssertTrue(process.waitForExistence(timeout: 10))
        let answer = app.descendants(matching: .any)["message-ui-answer-5"].firstMatch
        XCTAssertLessThan(process.frame.minY, answer.frame.minY)
        process.tap()
        XCTAssertTrue(app.staticTexts["过程详情加载失败，点击重试"].waitForExistence(timeout: 5))
        XCTAssertTrue(process.isHittable, "Failed load must not remove the header")
        let y = process.frame.minY
        process.tap()
        XCTAssertTrue(app.staticTexts[empty ? "暂无过程详情" : "过程详情加载成功"].waitForExistence(timeout: 5))
        XCTAssertTrue(process.isHittable)
        XCTAssertEqual(process.frame.minY, y, accuracy: 10, "Loading details must not move the process header")
        snapshot(empty ? "empty-process-header-retained" : "process-order-after-load")
    }

    func testFastScrollingNeverNeedsARecoveryGesture() {
        let app = scrollingApp(extraArguments: ["--ui-uneven-fixture"])
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "滚动回归 0").firstMatch.tap()
        let chat = app.collectionViews["chat-history"]
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        for index in 0..<12 {
            if index % 4 < 2 { chat.swipeDown(velocity: .fast) } else { chat.swipeUp(velocity: .fast) }
            // Check BEFORE any recovery gesture; a blank viewport is a failure.
            snapshot("immediate-scroll-\(index)")
            XCTAssertTrue(chat.staticTexts.allElementsBoundByIndex.contains { $0.isHittable && !$0.label.isEmpty })
            XCTAssertTrue(app.navigationBars.firstMatch.isHittable)
            XCTAssertTrue(app.descendants(matching: .any)["message-input"].firstMatch.isHittable)
        }
    }

    func testConversationCacheSurvivesReopenAndStaleSnapshots() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-cache-regression", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["展开缓存回归通过"].waitForExistence(timeout: 20))
    }

    func testLoadingOlderMarkdownKeepsReadingPosition() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixture", "--ui-pagination-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()
        let chat = app.collectionViews["chat-history"]
        let first = app.staticTexts["检查第 1 轮消息"]
        for _ in 0..<8 {
            if first.isHittable { break }
            chat.swipeDown(velocity: .slow)
        }
        XCTAssertTrue(first.isHittable)
        let before = first.frame.minY
        // Wait for the existing page's loading state to settle without another gesture.
        let moved = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !first.isHittable || abs(first.frame.minY - before) > 80
        }, object: nil)
        moved.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [moved], timeout: 2), .completed)
        chat.swipeDown(velocity: .slow)
        let older = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "更早的历史")).firstMatch
        XCTAssertTrue(older.waitForExistence(timeout: 5))
        snapshot("older-markdown-page")
    }

    func testSwitchingDuringStreamDoesNotLeakIntoEmptyConversation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixture", "--ui-stream-fixture", "--ui-empty-second-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()
        app.buttons["模拟连续回复"].tap()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["展开Calcu"].tap()
        app.buttons.containing(.staticText, identifier: "布局回归 Calcu").firstMatch.tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "message-input").firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.collectionViews["chat-history"].isHittable, "An empty conversation must finish initial positioning")
        let stale = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "流式输出：")).firstMatch
        let leaked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true"), object: stale)
        leaked.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [leaked], timeout: 6), .completed)
        snapshot("empty-conversation-after-stream-switch")
    }

    func testContinuousStreamingPublishesBeforeCompletion() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-fixture", "--ui-stream-fixture", "-AppleLanguages", "(zh-Hans)", "-AppleLocale", "zh_CN"]
        app.launch()
        XCTAssertTrue(app.buttons["展开CV"].waitForExistence(timeout: 10))
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "布局回归 CV").firstMatch.tap()
        app.buttons["模拟连续回复"].tap()
        let partial = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND NOT label CONTAINS %@", "流式输出：文", "终态已到达")).firstMatch
        XCTAssertTrue(partial.waitForExistence(timeout: 3), "Continuous 10 ms deltas must publish before the stream ends")
        XCTAssertTrue(app.buttons["流式进行中"].exists)
        let terminal = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "终态已到达")).firstMatch
        XCTAssertTrue(terminal.waitForExistence(timeout: 10))
        snapshot("streaming-final-markdown")
    }

    func testBottomRemainsVisibleAfterRepeatedFlicks() {
        let app = scrollingApp(extraArguments: ["--ui-uneven-fixture"])
        app.buttons["展开CV"].tap()
        app.buttons.containing(.staticText, identifier: "滚动回归 0").firstMatch.tap()
        let chat = app.collectionViews["chat-history"]
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
        let chat = app.collectionViews["chat-history"]
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
        let chat = app.collectionViews["chat-history"]
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
        XCTAssertLessThanOrEqual(app.collectionViews["chat-history"].frame.maxY, attachment.frame.minY)
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
        XCTAssertLessThanOrEqual(app.collectionViews["chat-history"].frame.maxY, attachment.frame.minY)
        snapshot("chat-long-input-keyboard")

        let chat = app.collectionViews["chat-history"]
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
