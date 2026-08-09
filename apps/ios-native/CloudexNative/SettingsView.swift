import AVFoundation
import SwiftUI
import UIKit

struct SettingsView: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @Binding var isPresented: Bool
    @State private var notifyApprovals: Bool
    @State private var notifyTaskSuccess: Bool
    @State private var notifyTaskFailure: Bool
    @State private var editingProfile: ServerProfile?
    @State private var showingNewProfile = false

    init(isPresented: Binding<Bool>, viewModel: AppViewModel? = nil) {
        _isPresented = isPresented
        _notifyApprovals = State(initialValue: viewModel?.notifyApprovals ?? true)
        _notifyTaskSuccess = State(initialValue: viewModel?.notifyTaskSuccess ?? true)
        _notifyTaskFailure = State(initialValue: viewModel?.notifyTaskFailure ?? true)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        showingNewProfile = true
                    } label: {
                        Label("新建服务器", systemImage: "plus.circle.fill")
                    }
                    if viewModel.serverProfiles.isEmpty {
                        Text("添加一个局域网或 Tailscale 服务器")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(viewModel.serverProfiles) { profile in
                            Button {
                                editingProfile = profile
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "server.rack")
                                        .foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(profile.name)
                                            .fontWeight(.medium)
                                        Text(profile.preferredURL.isEmpty ? "未配置地址" : profile.preferredURL)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        Text("\(profile.connectionMode.title) · Token \(profile.maskedToken)")
                                            .font(.caption2)
                                            .foregroundStyle(.tertiary)
                                    }
                                    Spacer(minLength: 0)
                                    if viewModel.selectedServerProfileID == profile.id {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.tint)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Section("当前连接") {
                    LabeledContent("服务器", value: viewModel.serverProfileTitle)
                    LabeledContent("地址", value: viewModel.serverURL)
                    LabeledContent("状态", value: viewModel.status)
                    Text("自动模式会优先尝试局域网，失败后切换到 Tailscale。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("通知") {
                    Toggle("需要确认", isOn: $notifyApprovals)
                    Toggle("任务成功", isOn: $notifyTaskSuccess)
                    Toggle("任务失败", isOn: $notifyTaskFailure)
                    Text("关闭后不会显示对应的系统通知；应用内过程和审批卡片仍然保留。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

            }
            .navigationTitle("设置")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task {
                            await viewModel.reconnect()
                        }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("重新连接")
                }
            }
            .onAppear {
                notifyApprovals = viewModel.notifyApprovals
                notifyTaskSuccess = viewModel.notifyTaskSuccess
                notifyTaskFailure = viewModel.notifyTaskFailure
            }
            .onChange(of: notifyApprovals) { _, _ in viewModel.updateNotificationSettings(approvals: notifyApprovals, taskSuccess: notifyTaskSuccess, taskFailure: notifyTaskFailure) }
            .onChange(of: notifyTaskSuccess) { _, _ in viewModel.updateNotificationSettings(approvals: notifyApprovals, taskSuccess: notifyTaskSuccess, taskFailure: notifyTaskFailure) }
            .onChange(of: notifyTaskFailure) { _, _ in viewModel.updateNotificationSettings(approvals: notifyApprovals, taskSuccess: notifyTaskSuccess, taskFailure: notifyTaskFailure) }
            .sheet(item: $editingProfile) { profile in
                ServerProfileEditorView(profile: profile, isNew: false)
                    .environmentObject(viewModel)
            }
            .sheet(isPresented: $showingNewProfile) {
                ServerProfileEditorView(profile: nil, isNew: true)
                    .environmentObject(viewModel)
            }
        }
    }
}

private struct ServerProfileEditorView: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @Environment(\.dismiss) private var dismiss
    let profile: ServerProfile?
    let isNew: Bool
    @State private var name = ""
    @State private var lanURL = ""
    @State private var tailscaleURL = ""
    @State private var token = ""
    @State private var mode: ConnectionMode = .automatic
    @State private var showingDeleteConfirmation = false

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器") {
                    TextField("名称", text: $name)
                    Picker("默认连接方式", selection: $mode) {
                        ForEach(ConnectionMode.allCases) { Text($0.title).tag($0) }
                    }
                }
                Section("地址") {
                    TextField("局域网地址", text: $lanURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    TextField("Tailscale 地址", text: $tailscaleURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                }
                Section("认证") {
                    SecureField("AUTH_TOKEN", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if !isNew {
                    Section {
                        Button("删除服务器", role: .destructive) { showingDeleteConfirmation = true }
                    }
                }
            }
            .navigationTitle(isNew ? "新建服务器" : "编辑服务器")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        Task {
                            await viewModel.saveServerProfile(id: profile?.id, name: name, lanURL: lanURL, tailscaleURL: tailscaleURL, connectionMode: mode, token: token)
                            dismiss()
                        }
                    }
                    .disabled(lanURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && tailscaleURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                guard let profile else { return }
                name = profile.name
                lanURL = profile.lanURL
                tailscaleURL = profile.tailscaleURL
                token = profile.token
                mode = profile.connectionMode
            }
            .confirmationDialog("删除这个服务器？", isPresented: $showingDeleteConfirmation, titleVisibility: .visible) {
                Button("删除", role: .destructive) {
                    if let profile { viewModel.deleteServerProfile(profile) }
                    dismiss()
                }
            }
        }
    }
}

struct CloudexConnectionPayload {
    let serverURL: String
    let token: String

    init?(code: String) {
        guard let components = URLComponents(string: code),
              components.scheme?.lowercased() == "cloudex",
              components.host?.lowercased() == "connect",
              let serverURL = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let parsedServerURL = URL(string: serverURL),
              ["http", "https"].contains(parsedServerURL.scheme?.lowercased() ?? ""),
              parsedServerURL.host != nil else { return nil }

        self.serverURL = serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        token = components.queryItems?.first(where: { $0.name == "token" })?.value ?? ""
    }

    var preferredConnectionMode: ConnectionMode {
        guard let host = URL(string: serverURL)?.host?.lowercased() else { return .lan }
        if host.hasSuffix(".ts.net") { return .tailscale }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4, parts[0] == 100, (64...127).contains(parts[1]) { return .tailscale }
        return .lan
    }
}

struct QRCodeScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    let onFailure: (String) -> Void

    func makeUIViewController(context: Context) -> QRCodeScannerViewController {
        let controller = QRCodeScannerViewController()
        controller.onScan = onScan
        controller.onFailure = onFailure
        return controller
    }

    func updateUIViewController(_ uiViewController: QRCodeScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: QRCodeScannerViewController, coordinator: ()) {
        uiViewController.stopScanning()
    }
}

final class QRCodeScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    var onFailure: ((String) -> Void)?

    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var isConfigured = false
    private var didFinish = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        requestAccessAndStart()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
        updateVideoOrientation()
    }

    override func viewWillTransition(
        to size: CGSize,
        with coordinator: UIViewControllerTransitionCoordinator
    ) {
        super.viewWillTransition(to: size, with: coordinator)
        coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            self?.updateVideoOrientation()
        }
    }

    func stopScanning() {
        if captureSession.isRunning { captureSession.stopRunning() }
    }

    private func requestAccessAndStart() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureAndStart()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.configureAndStart()
                    } else {
                        self?.fail("请在系统设置中允许 Cloudex 使用相机。")
                    }
                }
            }
        case .denied, .restricted:
            fail("请在系统设置中允许 Cloudex 使用相机。")
        @unknown default:
            fail("当前设备无法使用相机扫描二维码。")
        }
    }

    private func configureAndStart() {
        if !isConfigured {
            guard let camera = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera),
                  captureSession.canAddInput(input) else {
                fail("当前设备没有可用的相机。")
                return
            }
            captureSession.addInput(input)

            let output = AVCaptureMetadataOutput()
            guard captureSession.canAddOutput(output) else {
                fail("无法启动二维码扫描。")
                return
            }
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: captureSession)
            layer.videoGravity = .resizeAspectFill
            view.layer.insertSublayer(layer, at: 0)
            previewLayer = layer
            isConfigured = true
            view.setNeedsLayout()
        }

        updateVideoOrientation()
        if !captureSession.isRunning { captureSession.startRunning() }
    }

    private func updateVideoOrientation() {
        guard let interfaceOrientation = view.window?.windowScene?.interfaceOrientation else { return }
        let videoOrientation: AVCaptureVideoOrientation
        switch interfaceOrientation {
        case .portrait:
            videoOrientation = .portrait
        case .portraitUpsideDown:
            videoOrientation = .portraitUpsideDown
        case .landscapeLeft:
            videoOrientation = .landscapeLeft
        case .landscapeRight:
            videoOrientation = .landscapeRight
        default:
            return
        }

        if let connection = previewLayer?.connection,
           connection.isVideoOrientationSupported {
            connection.videoOrientation = videoOrientation
        }
        for connection in captureSession.connections where connection.isVideoOrientationSupported {
            connection.videoOrientation = videoOrientation
        }
    }

    private func fail(_ message: String) {
        guard !didFinish else { return }
        didFinish = true
        onFailure?(message)
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didFinish,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue else { return }
        didFinish = true
        stopScanning()
        onScan?(value)
    }
}
