import Cocoa
import WebKit
import Carbon

// Native macOS Right-Side Quick-Toggle File Tree Drawer for AGY Finder.
// Uses Carbon RegisterEventHotKey scoped exclusively to Antigravity / this drawer
// (zero Accessibility TCC prompts, zero VS Code shortcut conflict, zero TCP ports).

struct HotkeySpec {
  let preset: String
  let keyCode: UInt32
  let carbonModifiers: UInt32
  let eventModifiers: NSEvent.ModifierFlags
  let lowerChar: String
  let displayLabel: String
}

let kHotKeySignature: OSType = 0x41475946 // 'AGYF'
let kHotKeyId: UInt32 = 1

func parseHotkeyPreset(_ raw: String) -> HotkeySpec? {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "cmd+shift+e":
    return HotkeySpec(
      preset: "cmd+shift+e",
      keyCode: UInt32(kVK_ANSI_E),
      carbonModifiers: UInt32(cmdKey | shiftKey),
      eventModifiers: [.command, .shift],
      lowerChar: "e",
      displayLabel: "⌘⇧E"
    )
  case "cmd+alt+e":
    return HotkeySpec(
      preset: "cmd+alt+e",
      keyCode: UInt32(kVK_ANSI_E),
      carbonModifiers: UInt32(cmdKey | optionKey),
      eventModifiers: [.command, .option],
      lowerChar: "e",
      displayLabel: "⌘⌥E"
    )
  case "ctrl+shift+e":
    return HotkeySpec(
      preset: "ctrl+shift+e",
      keyCode: UInt32(kVK_ANSI_E),
      carbonModifiers: UInt32(controlKey | shiftKey),
      eventModifiers: [.control, .shift],
      lowerChar: "e",
      displayLabel: "⌃⇧E"
    )
  case "cmd+shift+y":
    return HotkeySpec(
      preset: "cmd+shift+y",
      keyCode: UInt32(kVK_ANSI_Y),
      carbonModifiers: UInt32(cmdKey | shiftKey),
      eventModifiers: [.command, .shift],
      lowerChar: "y",
      displayLabel: "⌘⇧Y"
    )
  default:
    return nil
  }
}

private func carbonHotkeyCallback(
  _ nextHandler: EventHandlerCallRef?,
  _ event: EventRef?,
  _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
  guard let userData = userData, let event = event else {
    return OSStatus(eventNotHandledErr)
  }
  var hotKeyID = EventHotKeyID()
  let status = GetEventParameter(
    event,
    EventParamName(kEventParamDirectObject),
    EventParamType(typeEventHotKeyID),
    nil,
    MemoryLayout<EventHotKeyID>.size,
    nil,
    &hotKeyID
  )
  guard status == noErr,
        hotKeyID.signature == kHotKeySignature,
        hotKeyID.id == kHotKeyId else {
    return OSStatus(eventNotHandledErr)
  }
  let controller = Unmanaged<DrawerWindowController>.fromOpaque(userData).takeUnretainedValue()
  controller.handleHotKeyTriggered()
  return noErr
}

final class DrawerBridge: NSObject, WKScriptMessageHandler {
  weak var controller: DrawerWindowController?

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? String else { return }
    controller?.handleWebMessage(body)
  }
}

final class DrawerWindowController: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var pinAccessoryButton: NSButton!
  let bridge = DrawerBridge()

  var isPinned: Bool
  var isWindowVisible: Bool
  var hotkeyPreset: String
  var hotkeySpec: HotkeySpec?

  var eventHandlerRef: EventHandlerRef?
  var hotKeyRef: EventHotKeyRef?
  var localKeyMonitor: Any?
  var workspaceObserver: NSObjectProtocol?
  weak var lastAntigravityApp: NSRunningApplication?

  init(initialPinned: Bool, initialVisible: Bool, initialPreset: String) {
    self.isPinned = initialPinned
    self.isWindowVisible = initialVisible
    self.hotkeyPreset = initialPreset
    self.hotkeySpec = parseHotkeyPreset(initialPreset)
    super.init()
    bridge.controller = self
  }

  deinit {
    unregisterHotKey()
    if let obs = workspaceObserver {
      NSWorkspace.shared.notificationCenter.removeObserver(obs)
    }
    if let mon = localKeyMonitor {
      NSEvent.removeMonitor(mon)
    }
    if let handler = eventHandlerRef {
      RemoveEventHandler(handler)
    }
  }

  func emitJson(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    if let outData = line.data(using: .utf8) {
      FileHandle.standardOutput.write(outData)
    }
  }

  func setupMenus() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu()
    let hideAppItem = NSMenuItem(title: "隐藏目录树抽屉", action: #selector(hideWindowAction), keyEquivalent: "h")
    hideAppItem.target = self
    appMenu.addItem(hideAppItem)
    appMenu.addItem(NSMenuItem.separator())
    let quitAppItem = NSMenuItem(title: "退出目录树助手", action: #selector(quitAction), keyEquivalent: "q")
    quitAppItem.target = self
    appMenu.addItem(quitAppItem)
    appMenuItem.submenu = appMenu

    let editMenuItem = NSMenuItem()
    mainMenu.addItem(editMenuItem)
    let editMenu = NSMenu(title: "编辑")
    editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editMenuItem.submenu = editMenu

    let winMenuItem = NSMenuItem()
    mainMenu.addItem(winMenuItem)
    let winMenu = NSMenu(title: "窗口")
    let pinItem = NSMenuItem(title: "切换置顶状态", action: #selector(togglePinnedAction), keyEquivalent: "p")
    pinItem.keyEquivalentModifierMask = [.command, .shift]
    pinItem.target = self
    winMenu.addItem(pinItem)
    winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    winMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    winMenuItem.submenu = winMenu

    NSApp.mainMenu = mainMenu
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    setupMenus()

    let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let defaultWidth: CGFloat = 340
    let defaultHeight: CGFloat = min(860, max(480, screenFrame.height - 28))
    let defaultX: CGFloat = max(screenFrame.minX + 12, screenFrame.maxX - defaultWidth - 8)
    let defaultY: CGFloat = screenFrame.minY + (screenFrame.height - defaultHeight) / 2.0
    let initialRect = NSRect(x: defaultX, y: defaultY, width: defaultWidth, height: defaultHeight)

    window = NSWindow(
      contentRect: initialRect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.minSize = NSSize(width: 280, height: 360)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.setFrameAutosaveName("AntigravityFinderDrawerV1")

    let accVC = NSTitlebarAccessoryViewController()
    accVC.layoutAttribute = .right
    let container = NSView(frame: NSRect(x: 0, y: 0, width: 82, height: 26))
    pinAccessoryButton = NSButton(frame: NSRect(x: 4, y: 2, width: 74, height: 22))
    pinAccessoryButton.bezelStyle = .inline
    pinAccessoryButton.font = NSFont.systemFont(ofSize: 11, weight: .medium)
    pinAccessoryButton.target = self
    pinAccessoryButton.action = #selector(togglePinnedAction)
    container.addSubview(pinAccessoryButton)
    accVC.view = container
    window.addTitlebarAccessoryViewController(accVC)

    let config = WKWebViewConfiguration()
    config.userContentController.add(bridge, name: "afBridge")
    webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
    webView.autoresizingMask = [.width, .height]
    window.contentView?.addSubview(webView)

    applyPinnedState(isPinned, notifyWeb: false)
    installHotKeyEngine()
    installLocalKeyMonitor()

    if isWindowVisible {
      showWindow(notifyParent: false)
    }

    startStdinReader()
    emitJson([
      "type": "ready",
      "pinned": isPinned,
      "hotkeyPreset": hotkeyPreset,
      "windowVisible": isWindowVisible
    ])
  }

  // MARK: - App-Scoped Carbon Hotkey

  func installHotKeyEngine() {
    var eventType = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )
    let selfPtr = Unmanaged.passUnretained(self).toOpaque()
    InstallEventHandler(
      GetApplicationEventTarget(),
      carbonHotkeyCallback,
      1,
      &eventType,
      selfPtr,
      &eventHandlerRef
    )

    workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      self?.syncHotKeyForFrontmostApp(app)
    }

    syncHotKeyForFrontmostApp(NSWorkspace.shared.frontmostApplication)
  }

  func installLocalKeyMonitor() {
    localKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self = self, let spec = self.hotkeySpec else { return event }
      let relevantFlags = event.modifierFlags.intersection([.command, .option, .control, .shift])
      let chars = (event.charactersIgnoringModifiers ?? "").lowercased()
      if relevantFlags == spec.eventModifiers && chars == spec.lowerChar {
        self.toggleWindowAction()
        return nil
      }
      return event
    }
  }

  func isTargetHostApp(_ app: NSRunningApplication?) -> Bool {
    guard let app = app else { return false }
    if app.processIdentifier == ProcessInfo.processInfo.processIdentifier {
      return true
    }
    let bundle = (app.bundleIdentifier ?? "").lowercased()
    let name = (app.localizedName ?? "").lowercased()
    let exePath = (app.executableURL?.path ?? "").lowercased()
    if bundle.contains("antigravity") || name.contains("antigravity") || exePath.contains("antigravity.app") {
      lastAntigravityApp = app
      return true
    }
    return false
  }

  func syncHotKeyForFrontmostApp(_ app: NSRunningApplication?) {
    if isTargetHostApp(app), hotkeySpec != nil {
      registerHotKey()
    } else {
      unregisterHotKey()
    }
  }

  func registerHotKey() {
    guard hotKeyRef == nil, let spec = hotkeySpec else { return }
    let hotKeyID = EventHotKeyID(signature: kHotKeySignature, id: kHotKeyId)
    var ref: EventHotKeyRef?
    let err = RegisterEventHotKey(
      spec.keyCode,
      spec.carbonModifiers,
      hotKeyID,
      GetApplicationEventTarget(),
      0,
      &ref
    )
    if err == noErr {
      hotKeyRef = ref
    }
  }

  func unregisterHotKey() {
    if let ref = hotKeyRef {
      UnregisterEventHotKey(ref)
      hotKeyRef = nil
    }
  }

  func applyHotkeyPreset(_ rawPreset: String, notifyWeb: Bool) {
    let trimmed = rawPreset.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let spec = parseHotkeyPreset(trimmed)
    hotkeyPreset = spec?.preset ?? "off"
    hotkeySpec = spec
    unregisterHotKey()
    syncHotKeyForFrontmostApp(NSWorkspace.shared.frontmostApplication)
    emitJson(["type": "hotkeyChanged", "hotkeyPreset": hotkeyPreset])
    if notifyWeb {
      let js = "window.__afOnHostEvent && window.__afOnHostEvent({type:'hotkeyChanged',hotkeyPreset:'\(hotkeyPreset)'});"
      webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  func handleHotKeyTriggered() {
    toggleWindowAction()
  }

  // MARK: - Window & Pin Controls

  func updateWindowTitle() {
    let suffix = hotkeySpec.map { " (\($0.displayLabel))" } ?? ""
    window?.title = isPinned ? "AGY Finder · 已置顶\(suffix)" : "AGY Finder\(suffix)"
  }

  func ensureWindowOnVisibleScreen() {
    guard let window = window else { return }
    let visible = (window.screen ?? NSScreen.main)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    var frame = window.frame
    if !visible.intersects(frame) {
      let w = min(max(frame.width, 300), visible.width - 24)
      let h = min(max(frame.height, 420), visible.height - 28)
      frame = NSRect(
        x: max(visible.minX + 8, visible.maxX - w - 8),
        y: visible.minY + (visible.height - h) / 2.0,
        width: w,
        height: h
      )
      window.setFrame(frame, display: true)
    }
  }

  func showWindow(notifyParent: Bool, revealPath: String? = nil) {
    if let front = NSWorkspace.shared.frontmostApplication {
      _ = isTargetHostApp(front)
    }
    ensureWindowOnVisibleScreen()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    isWindowVisible = true

    if let revealPath = revealPath, !revealPath.isEmpty,
       let data = try? JSONSerialization.data(withJSONObject: ["type": "windowShown", "revealPath": revealPath], options: []),
       let jsonStr = String(data: data, encoding: .utf8) {
      webView?.evaluateJavaScript("window.__afOnHostEvent && window.__afOnHostEvent(\(jsonStr));", completionHandler: nil)
    } else {
      webView?.evaluateJavaScript("window.__afOnHostEvent && window.__afOnHostEvent({type:'windowShown'});", completionHandler: nil)
    }

    if notifyParent {
      emitJson(["type": "visibilityChanged", "windowVisible": true])
    }
  }

  func hideWindow(restoreHostFocus: Bool, notifyParent: Bool) {
    window.orderOut(nil)
    isWindowVisible = false
    if restoreHostFocus, let hostApp = lastAntigravityApp, !hostApp.isTerminated {
      hostApp.activate(options: [])
    }
    if notifyParent {
      emitJson(["type": "visibilityChanged", "windowVisible": false])
    }
  }

  @objc func hideWindowAction() {
    hideWindow(restoreHostFocus: true, notifyParent: true)
  }

  @objc func toggleWindowAction() {
    if window.isVisible {
      hideWindow(restoreHostFocus: true, notifyParent: true)
    } else {
      showWindow(notifyParent: true)
    }
  }

  @objc func togglePinnedAction() {
    applyPinnedState(!isPinned, notifyWeb: true)
  }

  @objc func quitAction() {
    emitJson(["type": "closed"])
    NSApp.terminate(nil)
  }

  func applyPinnedState(_ pinned: Bool, notifyWeb: Bool) {
    isPinned = pinned
    if pinned {
      window.level = .floating
      window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      pinAccessoryButton?.title = "📌 已置顶"
    } else {
      window.level = .normal
      window.collectionBehavior = []
      pinAccessoryButton?.title = "📍 置顶"
    }
    updateWindowTitle()
    emitJson(["type": "pinChanged", "pinned": pinned])
    if notifyWeb {
      let js = "window.__afOnHostEvent && window.__afOnHostEvent({type:'pinChanged',pinned:\(pinned ? "true" : "false")});"
      webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if hotkeySpec != nil {
      hideWindow(restoreHostFocus: true, notifyParent: true)
      return false
    } else {
      emitJson(["type": "closed"])
      NSApp.terminate(nil)
      return true
    }
  }

  // MARK: - Web & Parent IPC

  func handleWebMessage(_ raw: String) {
    guard let data = raw.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let kind = obj["kind"] as? String else { return }

    if kind == "togglePin" {
      let next = (obj["pinned"] as? Bool) ?? (!isPinned)
      applyPinnedState(next, notifyWeb: true)
    } else if kind == "closeWindow" {
      hideWindow(restoreHostFocus: true, notifyParent: true)
    } else if kind == "rpc" {
      emitJson([
        "type": "rpcRequest",
        "id": obj["id"] ?? 0,
        "path": obj["path"] ?? "",
        "method": obj["method"] ?? "GET",
        "body": obj["body"] ?? NSNull()
      ])
    }
  }

  func startStdinReader() {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var buffer = Data()
      let stdinHandle = FileHandle.standardInput
      while true {
        let chunk = stdinHandle.availableData
        if chunk.isEmpty {
          DispatchQueue.main.async { NSApp.terminate(nil) }
          break
        }
        buffer.append(chunk)
        while let nlRange = buffer.range(of: Data([0x0a])) {
          let lineData = buffer.subdata(in: 0..<nlRange.lowerBound)
          buffer.removeSubrange(0..<nlRange.upperBound)
          if lineData.isEmpty { continue }
          if let msg = (try? JSONSerialization.jsonObject(with: lineData)) as? [String: Any] {
            DispatchQueue.main.async {
              self?.handleParentCommand(msg)
            }
          }
        }
      }
    }
  }

  func handleParentCommand(_ msg: [String: Any]) {
    guard let type = msg["type"] as? String else { return }
    switch type {
    case "loadHtml":
      if let html = msg["html"] as? String {
        webView.loadHTMLString(html, baseURL: nil)
      }
    case "rpcReply":
      guard let id = msg["id"],
            let payloadData = try? JSONSerialization.data(withJSONObject: msg["payload"] ?? [:], options: []),
            let payloadJson = String(data: payloadData, encoding: .utf8) else { return }
      let ok = (msg["ok"] as? Bool) ?? true
      let status = (msg["status"] as? Int) ?? (ok ? 200 : 500)
      let js = "window.__afResolveRpc && window.__afResolveRpc(\(id), \(status), \(payloadJson));"
      webView.evaluateJavaScript(js, completionHandler: nil)
    case "setPinned":
      if let p = msg["pinned"] as? Bool {
        applyPinnedState(p, notifyWeb: true)
      }
    case "setHotkey":
      if let preset = msg["hotkeyPreset"] as? String {
        applyHotkeyPreset(preset, notifyWeb: true)
      }
    case "showWindow", "focus":
      showWindow(notifyParent: true, revealPath: msg["revealPath"] as? String)
    case "hideWindow":
      hideWindow(restoreHostFocus: true, notifyParent: true)
    case "toggleWindow":
      toggleWindowAction()
    case "revealPath":
      if let revealPath = msg["revealPath"] as? String, !revealPath.isEmpty {
        if !window.isVisible {
          showWindow(notifyParent: true, revealPath: revealPath)
        } else if let data = try? JSONSerialization.data(withJSONObject: ["type": "revealPath", "revealPath": revealPath], options: []),
                  let jsonStr = String(data: data, encoding: .utf8) {
          webView?.evaluateJavaScript("window.__afOnHostEvent && window.__afOnHostEvent(\(jsonStr));", completionHandler: nil)
        }
      }
    case "quit":
      NSApp.terminate(nil)
    default:
      break
    }
  }
}

let args = CommandLine.arguments
let initialPinned = !args.contains("--unpinned")
let initialVisible = !args.contains("--hidden-window")
var initialPreset = "cmd+shift+e"
if let idx = args.firstIndex(of: "--preset"), idx + 1 < args.count {
  initialPreset = args[idx + 1]
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = DrawerWindowController(
  initialPinned: initialPinned,
  initialVisible: initialVisible,
  initialPreset: initialPreset
)
app.delegate = delegate
app.run()
