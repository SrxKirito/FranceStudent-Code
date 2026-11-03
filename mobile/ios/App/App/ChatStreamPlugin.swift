import Foundation
import UIKit
import Capacitor
import UserNotifications

// Les octets restent dans le processus natif lorsque JavaScript est suspendu.
@objc(ChatStreamPlugin)
public final class ChatStreamPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {
    public let identifier = "ChatStreamPlugin"
    public let jsName = "ChatStream"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configureNotifications", returnType: CAPPluginReturnPromise)
    ]
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var startCall: CAPPluginCall?
    private var readCall: CAPPluginCall?
    private var chunks: [Data] = []
    private var buffered = 0
    private var streamID = ""
    private var finished = false
    private var failure: String?
    private var wasBackgrounded = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var observer: NSObjectProtocol?
    private var notificationBuffer = Data()
    private var notificationEvent = ""
    private var notificationPayload = ""
    private var notificationSent = false
    private var notificationChat = ""

    @objc func configureNotifications(_ call: CAPPluginCall) {
        if call.getBool("enabled") == false {
            UserDefaults.standard.set(false, forKey: "completion-notifications")
            call.resolve(["enabled": false]); return
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            UserDefaults.standard.set(granted, forKey: "completion-notifications")
            if let error = error { call.reject(error.localizedDescription) }
            else { call.resolve(["enabled": granted]) }
        }
    }

    private func inspectCompletion(_ data: Data) {
        notificationBuffer.append(data)
        while let newline = notificationBuffer.firstIndex(of: 10) {
            let line = String(decoding: notificationBuffer[..<newline], as: UTF8.self).trimmingCharacters(in: .newlines)
            notificationBuffer.removeSubrange(...newline)
            if line.hasPrefix("event:") { notificationEvent = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
            else if line.hasPrefix("data:") && ["stream.open", "completed", "response.completed"].contains(notificationEvent) {
                notificationPayload += String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            } else if line.isEmpty {
                let json = notificationPayload.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                if let id = json?["chat_id"] as? String { notificationChat = id }
                let response = json?["response"] as? [String: Any]
                let failed = (json?["error"] != nil && !(json?["error"] is NSNull)) || (response?["error"] != nil && !(response?["error"] is NSNull))
                if ["completed", "response.completed"].contains(notificationEvent), !failed, !notificationSent {
                    notificationSent = true
                    if UIApplication.shared.applicationState != .active && UserDefaults.standard.bool(forKey: "completion-notifications") {
                        let content = UNMutableNotificationContent()
                        content.title = "FranceStudent"
                        content.body = "Ta réponse est prête. Ouvre l’app pour la retrouver."
                        content.sound = .default
                        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "reply-" + (notificationChat.isEmpty ? streamID : notificationChat), content: content, trigger: nil), withCompletionHandler: nil)
                    }
                }
                notificationEvent = ""; notificationPayload = ""
            }
        }
    }

    public override func load() {
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self, self.task != nil else { return }
            self.wasBackgrounded = true
        }
    }

    private func endBackgroundTime() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let method = call.getString("method") ?? "POST"
        guard let value = call.getString("url"), let url = URL(string: value),
              url.scheme == "https", url.host == "api.francestudent.ai",
              (method == "POST" && url.path == "/chats/stream" || method == "GET" && url.path.range(of: "^/chats/[^/]+/stream$", options: .regularExpression) != nil) else {
            call.reject("Adresse de génération invalide."); return
        }
        DispatchQueue.main.async {
            guard self.task == nil else { call.reject("Une réponse est déjà en cours."); return }
            self.streamID = UUID().uuidString
            self.chunks = []; self.buffered = 0; self.finished = false; self.failure = nil
            self.notificationBuffer = Data(); self.notificationEvent = ""; self.notificationPayload = ""; self.notificationSent = false; self.notificationChat = ""
            self.wasBackgrounded = UIApplication.shared.applicationState != .active
            self.startCall = call
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Chat response") { [weak self] in
                self?.wasBackgrounded = true
                self?.endBackgroundTime()
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            if method == "POST" { request.httpBody = (call.getString("body") ?? "").data(using: .utf8) }
            for (key, value) in call.getObject("headers") ?? [:] {
                if let text = value as? String { request.setValue(text, forHTTPHeaderField: key) }
            }
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 330
            config.timeoutIntervalForResource = 900
            config.waitsForConnectivity = true
            self.session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
            self.task = self.session!.dataTask(with: request)
            self.task!.resume()
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("id") == self.streamID else { call.reject("Flux expiré."); return }
            guard self.readCall == nil else { call.reject("Lecture déjà en cours."); return }
            self.readCall = call
            self.flush()
        }
    }

    private func flush() {
        guard let call = readCall else { return }
        if !chunks.isEmpty {
            let chunk = chunks.removeFirst(); buffered -= chunk.count
            readCall = nil
            call.resolve(["data": chunk.base64EncodedString(), "done": false])
        } else if finished {
            readCall = nil
            var result: [String: Any] = ["done": true, "backgrounded": wasBackgrounded]
            if let failure = failure { result["error"] = failure }
            call.resolve(result)
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if call.getString("id") == self.streamID {
                self.task?.cancel(); self.task = nil
                self.session?.invalidateAndCancel(); self.session = nil
                self.chunks = []; self.buffered = 0; self.finished = true
                self.flush(); self.endBackgroundTime()
            }
            call.resolve()
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard session === self.session, let http = response as? HTTPURLResponse else { completionHandler(.cancel); return }
        startCall?.resolve(["id": streamID, "status": http.statusCode, "backgrounded": wasBackgrounded])
        startCall = nil
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard session === self.session else { return }
        guard buffered + data.count <= 32 * 1024 * 1024 else {
            failure = "La réponse dépasse la capacité du tampon."; dataTask.cancel(); return
        }
        chunks.append(data); buffered += data.count; flush()
        inspectCompletion(data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard session === self.session else { return }
        if failure == nil { failure = error?.localizedDescription }
        finished = true; self.task = nil
        if let call = startCall {
            call.resolve(["status": 0, "error": failure ?? "Connexion interrompue.", "backgrounded": wasBackgrounded])
            startCall = nil
        }
        flush(); endBackgroundTime(); session.finishTasksAndInvalidate(); self.session = nil
    }

    deinit { if let observer = observer { NotificationCenter.default.removeObserver(observer) } }
}
