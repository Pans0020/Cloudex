import SwiftUI
import UIKit

// Shared semantic colours also drive UIKit's chat canvas. Scrolling rows use
// translucent fills; live glass is reserved for the small, fixed controls.
enum CloudexTheme {
    static let canvasUI = adaptive(light: (0.955, 0.963, 0.959), dark: (0.067, 0.080, 0.086))
    static let canvas = Color(canvasUI)
    static let homeCanvas = Color(adaptive(light: (0.982, 0.984, 0.980), dark: (0.067, 0.080, 0.086)))
    static let surface = Color(adaptive(light: (1, 1, 1), dark: (0.12, 0.14, 0.15)))
    static let accent = Color(adaptive(light: (0.08, 0.40, 0.37), dark: (0.49, 0.83, 0.77)))
    static let userBubble = Color(adaptive(light: (0.89, 0.95, 0.93), dark: (0.12, 0.23, 0.22)))
    static let line = Color(adaptive(light: (0.75, 0.80, 0.78), dark: (0.29, 0.36, 0.36)))
    static let onAction = Color(adaptive(light: (1, 1, 1), dark: (0.07, 0.09, 0.09)))

    private static func adaptive(light: (CGFloat, CGFloat, CGFloat), dark: (CGFloat, CGFloat, CGFloat)) -> UIColor {
        UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: value.0, green: value.1, blue: value.2, alpha: 1)
        }
    }
}

private struct CloudexSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    var radius: CGFloat
    var selected: Bool

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background(CloudexTheme.surface.opacity(reduceTransparency ? 1 : 0.76), in: shape)
            .background(selected ? CloudexTheme.accent.opacity(0.07) : .clear, in: shape)
            .overlay(shape.strokeBorder(selected ? CloudexTheme.accent.opacity(0.42)
                : CloudexTheme.line.opacity(contrast == .increased ? 0.9 : 0.45), lineWidth: contrast == .increased ? 1 : 0.7))
    }
}

extension View {
    func cloudexSurface(radius: CGFloat = 20, selected: Bool = false) -> some View {
        modifier(CloudexSurface(radius: radius, selected: selected))
    }
}

struct CloudexGlassModifier<S: Shape>: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    let shape: S
    let interactive: Bool
    let tint: Color?

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency || contrast == .increased {
            content.background(CloudexTheme.surface, in: shape)
                .overlay(shape.stroke(CloudexTheme.line, lineWidth: 1))
        } else if #available(iOS 26.0, *) {
            content.glassEffect(.regular.tint(tint).interactive(interactive), in: shape)
        } else {
            content.background(.ultraThinMaterial, in: shape)
                .background(tint ?? .clear, in: shape)
                .overlay(shape.stroke(CloudexTheme.line.opacity(0.5), lineWidth: 0.7))
        }
    }
}

struct CloudexEmptyState: View {
    let symbol: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: symbol)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(CloudexTheme.accent)
                .frame(width: 76, height: 76)
                .cloudexSurface(radius: 25)
                .accessibilityHidden(true)
            VStack(spacing: 7) {
                Text(cloudexLocalized(title)).font(.headline)
                Text(cloudexLocalized(detail))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(28)
        .frame(maxWidth: 360)
    }
}
