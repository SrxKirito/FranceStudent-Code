import Capacitor

@objc(FranceStudentViewController)
final class FranceStudentViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FileSaverPlugin())
        bridge?.registerPluginInstance(AttachmentPickerPlugin())
        bridge?.registerPluginInstance(ChatStreamPlugin())
        bridge?.registerPluginInstance(IDELinkVaultPlugin())
        if #available(iOS 16.0, *) { bridge?.registerPluginInstance(QRScannerPlugin()) }
        webView?.scrollView.bounces = false
        webView?.scrollView.contentInsetAdjustmentBehavior = .never
    }
}
