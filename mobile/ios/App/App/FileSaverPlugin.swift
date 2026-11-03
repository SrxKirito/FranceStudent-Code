import Foundation
import Capacitor
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import QuickLook
import Security

// L’association IDE Link reste dans le Trousseau de cet appareil.
@objc(IDELinkVaultPlugin)
public final class IDELinkVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IDELinkVaultPlugin"
    public let jsName = "IDELinkVault"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)]
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "org.francestudent.chat.ide-link", kSecAttrAccount as String: "remembered-computer"] }
    @objc func read(_ call: CAPPluginCall) {
        var request = query; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve([:]); return }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 16384, let value = String(data: data, encoding: .utf8) else { call.reject("Le coffre iPhone est indisponible. Déverrouille l’appareil puis réessaie."); return }
        call.resolve(["value": value])
    }
    @objc func save(_ call: CAPPluginCall) {
        guard let value = call.getString("value"), let data = value.data(using: .utf8), data.count <= 16384,
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { call.reject("Association IDE Link invalide."); return }
        let changes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound { var item = query; item.merge(changes) { _, value in value }; status = SecItemAdd(item as CFDictionary, nil) }
        guard status == errSecSuccess else { call.reject("L’association ne peut pas être mémorisée dans le coffre iPhone."); return }
        call.resolve([:])
    }
    @objc func remove(_ call: CAPPluginCall) {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { call.reject("L’association ne peut pas être retirée du coffre iPhone."); return }
        call.resolve([:])
    }
}

// Les fichiers restent dans Documents, accessible depuis l'app Fichiers d'iOS.
@objc(FileSaverPlugin)
public final class FileSaverPlugin: CAPPlugin, CAPBridgedPlugin, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
    public let identifier = "FileSaverPlugin"
    public let jsName = "FileSaver"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preview", returnType: CAPPluginReturnPromise)
    ]
    private var previewURL: URL?

    @objc func preview(_ call: CAPPluginCall) {
        guard let base64 = call.getString("data"), let data = Data(base64Encoded: base64), data.count <= 50 * 1024 * 1024 else {
            call.reject("Le fichier est invalide ou dépasse 50 Mo."); return
        }
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController, host.presentedViewController == nil else {
                call.reject("Ferme l’aperçu actuel avant d’en ouvrir un autre."); return
            }
            do {
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("preview-" + UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let requested = (call.getString("name") ?? "document.pdf") as NSString
                let name = requested.lastPathComponent
                let url = folder.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "document" : name)
                try data.write(to: url, options: .atomic)
                guard QLPreviewController.canPreview(url as NSURL) else {
                    try? FileManager.default.removeItem(at: folder)
                    call.reject("Ce format ne possède pas d’aperçu natif."); return
                }
                self.previewURL = url
                let viewer = QLPreviewController()
                viewer.dataSource = self
                viewer.delegate = self
                viewer.modalPresentationStyle = .fullScreen
                host.present(viewer, animated: true) { call.resolve() }
            } catch { call.reject("Impossible d’ouvrir le document : " + error.localizedDescription) }
        }
    }

    public func numberOfPreviewItems(in controller: QLPreviewController) -> Int { previewURL == nil ? 0 : 1 }
    public func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { previewURL! as NSURL }
    public func previewControllerDidDismiss(_ controller: QLPreviewController) {
        if let url = previewURL { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        previewURL = nil
    }

    @objc func save(_ call: CAPPluginCall) {
        guard let base64 = call.getString("data"),
              let data = Data(base64Encoded: base64) else {
            call.reject("Le contenu du fichier est invalide.")
            return
        }
        let requested = call.getString("name") ?? "fichier.txt"
        let component = (requested as NSString).lastPathComponent
        let clean = component.components(separatedBy: .controlCharacters).joined()
        let name = clean.isEmpty || clean == "." || clean == ".." ? "fichier.txt" : clean
        do {
            let manager = FileManager.default
            let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            var target = documents.appendingPathComponent(name, isDirectory: false)
            let stem = (name as NSString).deletingPathExtension
            let ext = (name as NSString).pathExtension
            var suffix = 1
            while manager.fileExists(atPath: target.path) {
                let candidate = "\(stem)-\(suffix)" + (ext.isEmpty ? "" : ".\(ext)")
                target = documents.appendingPathComponent(candidate, isDirectory: false)
                suffix += 1
            }
            try data.write(to: target, options: .atomic)
            call.resolve([
                "path": "Fichiers/Sur mon iPhone/FranceStudent Chat/" + target.lastPathComponent,
                "uri": target.absoluteString
            ])
        } catch {
            call.reject("Impossible d’enregistrer le fichier : " + error.localizedDescription)
        }
    }
}

// Sélecteurs explicites : ne passent pas par la feuille de choix du WebView.
@objc(AttachmentPickerPlugin)
public final class AttachmentPickerPlugin: CAPPlugin, CAPBridgedPlugin, PHPickerViewControllerDelegate, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    public let identifier = "AttachmentPickerPlugin"
    public let jsName = "AttachmentPicker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise)
    ]
    private var pending: CAPPluginCall?
    private let limit = 50 * 1024 * 1024

    private func present(_ call: CAPPluginCall, photos: Bool) {
        DispatchQueue.main.async {
            guard self.pending == nil, let host = self.bridge?.viewController,
                  host.presentedViewController == nil else {
                call.reject("Une sélection est déjà ouverte.")
                return
            }
            self.pending = call
            let controller: UIViewController
            if photos {
                var config = PHPickerConfiguration()
                config.filter = .images
                config.selectionLimit = 10
                let picker = PHPickerViewController(configuration: config)
                picker.delegate = self
                controller = picker
            } else {
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                picker.allowsMultipleSelection = true
                picker.delegate = self
                controller = picker
            }
            host.present(controller, animated: true)
            controller.presentationController?.delegate = self
        }
    }

    @objc func pickPhotos(_ call: CAPPluginCall) { present(call, photos: true) }
    @objc func pickFiles(_ call: CAPPluginCall) { present(call, photos: false) }

    private func finish(_ files: [[String: Any]], error: String? = nil) {
        DispatchQueue.main.async {
            guard let call = self.pending else { return }
            self.pending = nil
            if let error = error { call.reject(error) }
            else { call.resolve(["files": files]) }
        }
    }

    public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish([]) }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish([]) }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                var files: [[String: Any]] = []
                var total = 0
                for url in urls {
                    let accessed = url.startAccessingSecurityScopedResource()
                    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= self.limit - total else { throw PickerError.tooLarge }
                    let data = try Data(contentsOf: url, options: .mappedIfSafe)
                    total += data.count
                    guard total <= self.limit else { throw PickerError.tooLarge }
                    let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    files.append(["name": url.lastPathComponent, "mime": mime, "data": data.base64EncodedString()])
                }
                self.finish(files)
            } catch { self.finish([], error: error.localizedDescription) }
        }
    }

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true) {
            self.loadPhotos(results, index: 0, files: [], total: 0)
        }
    }

    private func loadPhotos(_ results: [PHPickerResult], index: Int, files: [[String: Any]], total: Int) {
        guard index < results.count else { finish(files); return }
        let provider = results[index].itemProvider
        provider.loadObject(ofClass: UIImage.self) { object, error in
            guard let image = object as? UIImage, error == nil else {
                self.finish([], error: "Impossible de lire cette photo."); return
            }
            let scale = min(1, 2048 / max(image.size.width, image.size.height))
            let size = CGSize(width: max(1, image.size.width * scale), height: max(1, image.size.height * scale))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let resized = UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: size))
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            guard let data = resized.jpegData(compressionQuality: 0.9), data.count <= self.limit - total else {
                self.finish([], error: "La sélection dépasse 50 Mo."); return
            }
            var next = files
            next.append(["name": "photo-\(index + 1).jpg", "mime": "image/jpeg", "data": data.base64EncodedString()])
            self.loadPhotos(results, index: index + 1, files: next, total: total + data.count)
        }
    }

    private enum PickerError: LocalizedError {
        case tooLarge
        var errorDescription: String? { "La sélection dépasse 50 Mo." }
    }
}

import AVFoundation
import VisionKit

@available(iOS 16.0, *)
@objc(QRScannerPlugin)
public final class QRScannerPlugin: CAPPlugin, CAPBridgedPlugin, DataScannerViewControllerDelegate {
    public let identifier = "QRScannerPlugin"
    public let jsName = "QRScanner"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)]
    private var pending: CAPPluginCall?
    private var scanner: DataScannerViewController?

    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pending == nil else { call.reject("Un scan est déjà ouvert."); return }
            guard DataScannerViewController.isSupported else { call.reject("Le scan QR n’est pas disponible sur cet iPhone. Colle l’adresse IDE Link."); return }
            self.pending = call
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    guard granted else { self.finish(error: "Autorise la caméra dans les réglages iOS pour scanner le QR code."); return }
                    guard DataScannerViewController.isAvailable, let host = self.bridge?.viewController, host.presentedViewController == nil else {
                        self.finish(error: "La caméra est indisponible. Ferme les autres fenêtres puis réessaie."); return
                    }
                    let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
                    controller.delegate = self
                    controller.modalPresentationStyle = .fullScreen
                    self.scanner = controller
                    let cancel = UIButton(type: .system)
                    cancel.setTitle("Annuler", for: .normal)
                    cancel.setTitleColor(.white, for: .normal)
                    cancel.backgroundColor = UIColor.black.withAlphaComponent(0.7)
                    cancel.layer.cornerRadius = 12
                    cancel.translatesAutoresizingMaskIntoConstraints = false
                    cancel.addTarget(self, action: #selector(self.cancelScan), for: .touchUpInside)
                    controller.view.addSubview(cancel)
                    NSLayoutConstraint.activate([cancel.topAnchor.constraint(equalTo: controller.view.safeAreaLayoutGuide.topAnchor, constant: 12), cancel.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor, constant: 16), cancel.widthAnchor.constraint(equalToConstant: 110), cancel.heightAnchor.constraint(equalToConstant: 48)])
                    host.present(controller, animated: true) {
                        do { try controller.startScanning() }
                        catch { self.finish(error: "Impossible de démarrer la caméra : " + error.localizedDescription) }
                    }
                }
            }
        }
    }
    @objc private func cancelScan() { finish() }
    private func finish(value: String? = nil, error: String? = nil) {
        guard let call = pending else { return }
        pending = nil
        let controller = scanner
        scanner = nil
        controller?.stopScanning()
        let complete = {
            if let error = error { call.reject(error) }
            else if let value = value { call.resolve(["value": value]) }
            else { call.resolve(["cancelled": true]) }
        }
        if let controller = controller { controller.dismiss(animated: true, completion: complete) }
        else { complete() }
    }
    public func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        for item in addedItems { if case .barcode(let barcode) = item, let value = barcode.payloadStringValue { finish(value: value); return } }
    }
    public func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
        finish(error: "La caméra est devenue indisponible. Réessaie ou colle l’adresse.")
    }
}
