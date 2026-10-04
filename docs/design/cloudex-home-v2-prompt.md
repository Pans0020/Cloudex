Use case: ui-mockup
Asset type: one high-fidelity portrait iOS homepage concept for the existing Cloudex app.

Primary request: Generate a substantially more beautiful and refined Cloudex homepage. The attached screenshot is a FUNCTIONAL REFERENCE, not an edit target: preserve its meaningful functions but redesign its visual hierarchy, proportions, typography and spacing. Create one complete straight-on screen, not a collage, angled phone render, advertising scene or website.

Canvas: portrait approximately 1179 x 2556 pixels, iPhone 14 Pro proportions (logical width 393 pt). Show the complete screen including a believable restrained iOS status bar and bottom home indicator. No outer phone hardware, labels or annotations. Edge-to-edge UI image.

Visual direction: a premium native iOS utility with understated translucent glass. Warm pearl-white background, graphite text, muted sea-glass teal accents, thin soft translucent edges. Subtle material depth at fixed controls; clean lightweight project surfaces. The impression should be quiet, precise, practical and inviting. Avoid saturated blue/purple gradients, neon, excessive shadows, expensive-looking blurs on every row, huge decorative hero areas, stock artwork and ornamental graphics.

Layout:
- A compact, well-composed top header: left-aligned "Cloudex" in confident system typography, about 28 pt, with a small server connection capsule immediately below, displaying a green dot and "Tailscale · 已连接". Top-right circular settings control with a crisp SF Symbols-style gear icon and at least a 44 pt hit area.
- Section heading "项目", with subtle count "2 个项目". Balanced 20 pt horizontal gutters and consistent 12–16 pt vertical rhythm.
- Expanded project group "CV": a 44 pt rounded-square CV monogram tile, project title, a small count "3", and downward chevron. Moderate corner radius around 20 pt, restrained insets, no enormous padding. Under it, a small teal compose icon and "新对话" action. Three compact but comfortably tappable conversation rows with very subtle dividers. Use exact sample titles: "布局回归 CV", "适配 Codex 更新", "优化实时同步". The first row has a light sea-glass selected fill. Small secondary metadata "今天" or "昨天", discrete chevrons, and one subtle running indicator beside "优化实时同步". Project names use about 18 pt semibold; conversation titles about 16 pt regular; metadata about 12–13 pt with clearly readable contrast. This is sample content for a concept, not claims about actual live conversations.
- A compact collapsed "Calcu" project card with CA monogram, project title, small count "1" and right chevron. Same corner radii, border weight and alignment as CV.
- Preserve useful breathing room below the project list. Do not fill it with invented dashboards, notifications, statistics, pricing, features or a decorative image.
- Near the bottom safe area, an elegant floating frosted-glass search capsule labeled "搜索对话", with a clean magnifying-glass icon. Roughly 50–54 pt tall, 20 pt horizontal margins; low-key edge highlight and readable gray text. No content overlaps. The home indicator sits below it with proper safe-area spacing.

Quality criteria: polished product-design proportions; consistent icon strokes; crisp Chinese typography without gibberish; natural touch targets; stronger information hierarchy and less wasted space than the reference; restrained and cohesive light theme. No chat composer on this homepage. No code or engineering details in the interface.

Execution: This is image generation only. Do not change application source, configuration, credentials or authentication files. If the built-in tool exposes an explicit model selector, prefer gpt-image-2.5-sunburst; otherwise use its available default and do not claim an exact model. In qa_note, report a model name only if the tool actually identifies it.

Use the installed $imagegen skill and the built-in image_gen tool only.
Do not call an image API or scripts/image_gen.py.
Inspect the result against the request. Save the selected image locally.
Return exactly:
selected_source=/absolute/path/to/image.png
qa_note=<one concise sentence>
