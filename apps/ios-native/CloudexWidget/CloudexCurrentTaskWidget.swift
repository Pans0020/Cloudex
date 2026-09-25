import SwiftUI
import WidgetKit

struct CurrentTaskEntry: TimelineEntry {
    let date: Date
    let snapshot: CurrentTaskSnapshot?
}

struct CurrentTaskProvider: TimelineProvider {
    func placeholder(in context: Context) -> CurrentTaskEntry {
        CurrentTaskEntry(date: Date(), snapshot: CurrentTaskSnapshot(
            hostName: "Mac", title: "正在运行的任务", activeCount: 1, updatedAt: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (CurrentTaskEntry) -> Void) {
        completion(CurrentTaskEntry(date: Date(), snapshot: CurrentTaskSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CurrentTaskEntry>) -> Void) {
        completion(Timeline(entries: [CurrentTaskEntry(date: Date(), snapshot: CurrentTaskSnapshot.load())],
                            policy: .after(Date().addingTimeInterval(15 * 60))))
    }
}

struct CurrentTaskWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: CurrentTaskEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Image(systemName: "server.rack")
                Text(entry.snapshot?.hostName ?? "Cloudex").lineLimit(1)
            }
            .font(.caption.weight(.semibold))
            Text(entry.snapshot?.title ?? "打开 Cloudex 查看任务")
                .font(family == .accessoryRectangular ? .caption : .headline)
                .lineLimit(family == .accessoryRectangular ? 2 : 3)
            if family != .accessoryRectangular {
                Text("\(entry.snapshot?.activeCount ?? 0) 个运行中")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let updatedAt = entry.snapshot?.updatedAt {
                    Text("上次同步 \(updatedAt, style: .relative)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

@main
struct CloudexCurrentTaskWidget: Widget {
    let kind = "CloudexCurrentTask"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CurrentTaskProvider()) { entry in
            CurrentTaskWidgetView(entry: entry)
        }
        .configurationDisplayName("当前任务")
        .description("查看最近同步的主机和任务状态")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}
