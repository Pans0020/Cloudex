Use case: ui-mockup
Asset type: high-fidelity visual reference for an existing native iOS app, Cloudex.
Primary request: a refined, usable system-wide redesign for a mobile coding-assistant client. Show three iPhone screens side by side: project home in light mode, a conversation in light mode, and settings in dark mode. Front-facing, straight-on flat interface designs; no angled devices or marketing scene.
Style: restrained Apple-native glass, pearl-white and warm mist backgrounds, graphite typography, very subtle ice-teal accents, delicate translucent borders. Cards should look light and translucent, not solid blue. Dark mode uses charcoal and softly lit glass edges, not pure black or neon.
Home: compact server-name pill, small connection dot, Cloudex title; Codex/Claude segmented control; distinct rounded project groups labeled CV and Calcu with monogram tiles, project name, session count, expandable rows; an understated bottom search field. Clear selected states, generous but practical spacing. No dashboard charts or fabricated metrics.
Conversation: readable Chinese text, right-aligned softly tinted user bubble, left-aligned spacious neutral assistant card, slim collapsible process/status row above its answer, small footer actions. Example text: 用户 “帮我优化这个页面”; assistant “已整理页面层次，并保留原生交互。” Composer has attachment, microphone, model and access controls in one compact row ABOVE the text input; input and send button on their own row. Do not overlap chat content and composer.
Settings: grouped server connections, first-row QR scan/add actions, calm toggles, a compact app/build information footer. Clear accessible contrast.
Constraints: consistent typography, corner radii, spacing and icons across all three screens; keep practical 44-point touch targets; no saturated blue/purple gradients, no excessive glows, no large decorative hero taking space from projects, no patterned chat background, no text embedded in actual UI assets. This is a visual reference only; do not edit source code or inspect credentials.
Output: one landscape PNG concept sheet with the three full-height screens on a plain neutral backdrop. Save locally and return its path.

Use the installed $imagegen skill and the built-in image_gen tool only.
Do not call an image API or scripts/image_gen.py.
Inspect the result against the request. Save the selected image locally.
Return exactly:
selected_source=/absolute/path/to/image.png
qa_note=<one concise sentence>
