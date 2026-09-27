import SwiftUI
import UIKit

@MainActor
final class ChatListActions: ObservableObject {
    var scroll: ((String?) -> Void)?
    var preserve: (() -> Void)?
    func showLatest() { scroll?(nil) }
    func showMessage(_ id: String) { scroll?(id) }
    func preserveReadingPosition() { preserve?() }
}

// UIKit owns measurement, reuse and scrolling. SwiftUI owns only each row's content.
struct NativeChatList<Row: Identifiable & Equatable, RowView: View>: UIViewRepresentable where Row.ID == String {
    let conversationID: String
    let rows: [Row]
    let ready: Bool
    let hasMore: Bool
    let loadingOlder: Bool
    let presentationKey: String
    let actions: ChatListActions
    let onFollowingChanged: (Bool) -> Void
    let onLoadOlder: () -> Void
    @ViewBuilder let rowContent: (Row) -> RowView

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ChatCollectionView {
        let item = NSCollectionLayoutItem(layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .estimated(120)))
        let group = NSCollectionLayoutGroup.vertical(layoutSize: item.layoutSize, subitems: [item])
        let section = NSCollectionLayoutSection(group: group)
        section.interGroupSpacing = 18
        section.contentInsets = .init(top: 16, leading: 16, bottom: 12, trailing: 16)
        let view = ChatCollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout(section: section))
        view.backgroundColor = CloudexTheme.canvasUI
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        view.accessibilityIdentifier = "chat-history"
        view.delegate = context.coordinator
        view.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "message")
        view.selfSizingInvalidation = .enabledIncludingConstraints
        context.coordinator.attach(view)
        return view
    }

    func updateUIView(_ view: ChatCollectionView, context: Context) { context.coordinator.update(self) }

    static func dismantleUIView(_ view: ChatCollectionView, coordinator: Coordinator) {
        view.delegate = nil
        view.afterLayout = nil
        coordinator.parent.actions.scroll = nil
        coordinator.parent.actions.preserve = nil
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDelegate {
        var parent: NativeChatList
        weak var view: ChatCollectionView?
        var dataSource: UICollectionViewDiffableDataSource<Int, String>!
        var values: [String: Row] = [:]
        var ordered: [Row] = []
        var conversationID = ""
        var presentationKey = ""
        var following = true
        var positioned = false
        var applying = false
        var needsUpdate = false
        var adjusting = false
        var requestedOlder = false
        var pendingTarget: String?
        var anchor: (id: String, distance: CGFloat)?
        var interactionGeneration = 0

        init(_ parent: NativeChatList) { self.parent = parent }

        func attach(_ view: ChatCollectionView) {
            self.view = view
            dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: view) { [weak self] collection, path, id in
                guard let self, let row = self.values[id] else { return nil }
                let cell = collection.dequeueReusableCell(withReuseIdentifier: "message", for: path)
                cell.contentConfiguration = UIHostingConfiguration { self.parent.rowContent(row).id(id) }.margins(.all, 0)
                cell.backgroundColor = .clear
                return cell
            }
            view.afterLayout = { [weak self] in self?.settlePosition() }
            parent.actions.scroll = { [weak self] id in self?.scroll(to: id) }
            parent.actions.preserve = { [weak self] in self?.preservePosition() }
        }

        func update(_ next: NativeChatList) {
            parent = next
            guard let view else { return }
            if conversationID != next.conversationID {
                conversationID = next.conversationID
                interactionGeneration += 1
                positioned = false
                following = true
                anchor = nil
                pendingTarget = nil
                requestedOlder = false
            }
            if !next.loadingOlder { requestedOlder = false }
            guard !applying else { needsUpdate = true; return }
            // Never insert/resize rows under an active gesture. Capture its final
            // visible ID before applying the queued snapshot at gesture end.
            guard !view.isDragging, !view.isDecelerating else { needsUpdate = true; return }
            let presentationChanged = presentationKey != next.presentationKey
            presentationKey = next.presentationKey
            guard ordered != next.rows || presentationChanged else { settlePosition(); return }
            if positioned && !following && anchor == nil { anchor = visibleAnchor() }
            let previous = values
            values = Dictionary(next.rows.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
            ordered = next.rows
            var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
            snapshot.appendSections([0])
            snapshot.appendItems(ordered.map(\.id))
            snapshot.reconfigureItems(ordered.filter { previous[$0.id] != nil && (presentationChanged || previous[$0.id] != $0) }.map(\.id))
            applying = true
            let generation = interactionGeneration
            dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
                guard let self else { return }
                self.applying = false
                if generation != self.interactionGeneration { self.anchor = nil }
                view.layoutIfNeeded()
                self.settlePosition()
                if self.needsUpdate {
                    self.needsUpdate = false
                    self.update(self.parent)
                }
            }
        }

        func visibleAnchor() -> (id: String, distance: CGFloat)? {
            guard let view else { return nil }
            for path in view.indexPathsForVisibleItems.sorted() {
                guard let attributes = view.layoutAttributesForItem(at: path),
                      attributes.frame.maxY > view.contentOffset.y + view.adjustedContentInset.top,
                      let id = dataSource.itemIdentifier(for: path) else { continue }
                return (id, attributes.frame.minY - view.contentOffset.y)
            }
            return nil
        }

        func preservePosition() {
            following = false
            anchor = visibleAnchor()
            reportFollowing()
        }

        func scroll(to id: String?) {
            interactionGeneration += 1
            anchor = nil
            pendingTarget = id
            following = id == nil
            view?.setContentOffset(view?.contentOffset ?? .zero, animated: false)
            settlePosition()
            reportFollowing()
        }

        func settlePosition() {
            guard let view, view.bounds.height > 0, view.bounds.width > 0,
                  !applying, !adjusting, parent.ready, !ordered.isEmpty,
                  !view.isDragging, !view.isDecelerating else { return }
            adjusting = true
            defer { adjusting = false }
            if let target = pendingTarget, let path = dataSource.indexPath(for: target) {
                view.scrollToItem(at: path, at: .top, animated: false)
                pendingTarget = nil
                positioned = true
                anchor = visibleAnchor()
            } else if !positioned {
                view.scrollToItem(at: IndexPath(item: ordered.count - 1, section: 0), at: .bottom, animated: false)
                positioned = true
                anchor = nil
            } else if following {
                let bottom = max(-view.adjustedContentInset.top,
                    view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
                if abs(bottom - view.contentOffset.y) > 0.5 {
                    view.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
                }
            } else if let anchor, let path = dataSource.indexPath(for: anchor.id),
                      let attributes = view.layoutAttributesForItem(at: path) {
                let minimum = -view.adjustedContentInset.top
                let maximum = max(minimum, view.contentSize.height - view.bounds.height + view.adjustedContentInset.bottom)
                let y = min(maximum, max(minimum, attributes.frame.minY - anchor.distance))
                if abs(y - view.contentOffset.y) > 0.5 { view.setContentOffset(CGPoint(x: 0, y: y), animated: false) }
            }
        }

        func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
            interactionGeneration += 1
            following = false
            pendingTarget = nil
            anchor = nil
            reportFollowing()
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            guard positioned, !adjusting, scrollView.isDragging || scrollView.isDecelerating else { return }
            anchor = nil
            if scrollView.contentOffset.y + scrollView.adjustedContentInset.top < 180,
               parent.hasMore, !parent.loadingOlder, !requestedOlder {
                requestedOlder = true
                parent.onLoadOlder()
            }
        }

        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
            if !decelerate { finishGesture(scrollView) }
        }
        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { finishGesture(scrollView) }

        func finishGesture(_ scrollView: UIScrollView) {
            let bottom = max(-scrollView.adjustedContentInset.top,
                scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
            following = bottom - scrollView.contentOffset.y <= 24
            anchor = following ? nil : visibleAnchor()
            if needsUpdate {
                needsUpdate = false
                update(parent)
            }
            reportFollowing()
        }

        func reportFollowing() {
            let value = following
            DispatchQueue.main.async { [weak self] in
                guard let self, self.following == value else { return }
                self.parent.onFollowingChanged(value)
            }
        }
    }
}

final class ChatCollectionView: UICollectionView {
    var afterLayout: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        afterLayout?()
    }
}
