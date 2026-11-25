import Cocoa
import WebKit
import Carbon
import QuartzCore

// Native macOS Right-Side Quick-Toggle File Tree Drawer for AGY Finder.
// Uses Carbon RegisterEventHotKey scoped exclusively to Antigravity / this drawer
// (zero Accessibility TCC prompts, zero VS Code shortcut conflict, zero TCP ports).

struct HotkeySpec {
  let accelerator: String
  let keyCode: UInt32
  let carbonModifiers: UInt32
  let eventModifiers: NSEvent.ModifierFlags
  let displayLabel: String
}

let kHotKeySignature: OSType = 0x41475946 // 'AGYF'
let kDrawerHotKeyId: UInt32 = 1
let kAuxHotKeyId: UInt32 = 2

func carbonModsToNSEventFlags(_ mods: UInt32) -> NSEvent.ModifierFlags {
  var flags: NSEvent.ModifierFlags = []
  if (mods & UInt32(cmdKey)) != 0 { flags.insert(.command) }
  if (mods & UInt32(optionKey)) != 0 { flags.insert(.option) }
  if (mods & UInt32(controlKey)) != 0 { flags.insert(.control) }
  if (mods & UInt32(shiftKey)) != 0 { flags.insert(.shift) }
  return flags
}

func parseHotkeyPreset(_ raw: String) -> HotkeySpec? {
  switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
  case "cmd+shift+e":
    return HotkeySpec(
      accelerator: "Shift+Meta+E",
      keyCode: UInt32(kVK_ANSI_E),
      carbonModifiers: UInt32(cmdKey | shiftKey),
      eventModifiers: [.command, .shift],
      displayLabel: "⇧⌘E"
    )
  case "cmd+alt+e":
    return HotkeySpec(
      accelerator: "Alt+Meta+E",
      keyCode: UInt32(kVK_ANSI_E),
      carbonModifiers: UInt32(cmdKey | optionKey),
      eventModifiers: [.command, .option],
      displayLabel: "⌥⌘E"
    )
  case "ctrl+shift+e":
    return HotkeySpec(
      accelerator: "Ctrl+Shift+E",
      keyCode: UInt32(kVK_ANSI_E),
      carbonModifiers: UInt32(controlKey | shiftKey),
      eventModifiers: [.control, .shift],
      displayLabel: "⌃⇧E"
    )
  case "cmd+shift+y":
    return HotkeySpec(
      accelerator: "Shift+Meta+Y",
      keyCode: UInt32(kVK_ANSI_Y),
      carbonModifiers: UInt32(cmdKey | shiftKey),
      eventModifiers: [.command, .shift],
      displayLabel: "⇧⌘Y"
    )
  default:
    return nil
  }
}

func parseShortcutCommand(_ msg: [String: Any]) -> HotkeySpec? {
  let enabled = (msg["enabled"] as? Bool) ?? true
  guard enabled,
        let keyCode = (msg["keyCode"] as? NSNumber)?.uint32Value,
        let carbonMods = (msg["carbonModifiers"] as? NSNumber)?.uint32Value else {
    return nil
  }
  return HotkeySpec(
    accelerator: (msg["accelerator"] as? String) ?? "",
    keyCode: keyCode,
    carbonModifiers: carbonMods,
    eventModifiers: carbonModsToNSEventFlags(carbonMods),
    displayLabel: (msg["displayLabel"] as? String) ?? ""
  )
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
  guard status == noErr, hotKeyID.signature == kHotKeySignature else {
    return OSStatus(eventNotHandledErr)
  }
  let controller = Unmanaged<DrawerWindowController>.fromOpaque(userData).takeUnretainedValue()
  if hotKeyID.id == kDrawerHotKeyId {
    controller.handleDrawerHotKeyTriggered()
    return noErr
  }
  if hotKeyID.id == kAuxHotKeyId {
    controller.handleAuxHotKeyTriggered()
    return noErr
  }
  return OSStatus(eventNotHandledErr)
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
  var auxHotkeySpec: HotkeySpec?
  var shortcutScope: String
  var isRecordingShortcut: Bool = false
  var lastAuxHotkeyAt: TimeInterval = 0

  var eventHandlerRef: EventHandlerRef?
  var hotKeyRef: EventHotKeyRef?
  var auxHotKeyRef: EventHotKeyRef?
  var localKeyMonitor: Any?
  var workspaceObserver: NSObjectProtocol?
  weak var lastAntigravityApp: NSRunningApplication?
  var hudPanel: NSPanel?
  var hudLabel: NSTextField?
  var hudHideWorkItem: DispatchWorkItem?
  var hudToken: Int = 0
  var isHudShowing: Bool = false
  var visibilityToken: Int = 0
  var isAnimatingVisibility: Bool = false
  var restingOriginX: CGFloat? = nil

  func shouldReduceMotion() -> Bool {
    return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }

  var shouldStayResident: Bool {
    return hotkeySpec != nil || auxHotkeySpec != nil
  }

  init(
    initialPinned: Bool,
    initialVisible: Bool,
    initialPreset: String,
    initialDrawerSpec: HotkeySpec?,
    initialAuxSpec: HotkeySpec?,
    initialScope: String
  ) {
    self.isPinned = initialPinned
    self.isWindowVisible = initialVisible
    self.hotkeyPreset = initialPreset
    self.hotkeySpec = initialDrawerSpec
    self.auxHotkeySpec = initialAuxSpec
    self.shortcutScope = initialScope
    super.init()
    bridge.controller = self
  }

  deinit {
    unregisterHotKeys()
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
    let auxItem = NSMenuItem(title: "在 AGY 侧栏切换文件树", action: #selector(triggerAuxPaneFromMenuAction), keyEquivalent: "")
    auxItem.target = self
    winMenu.addItem(auxItem)
    let pinItem = NSMenuItem(title: "切换置顶状态", action: #selector(togglePinnedAction), keyEquivalent: "p")
    pinItem.keyEquivalentModifierMask = [.command, .shift]
    pinItem.target = self
    winMenu.addItem(pinItem)
    winMenu.addItem(NSMenuItem.separator())
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
    window.backgroundColor = NSColor.windowBackgroundColor
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
    webView.setValue(false, forKey: "drawsBackground")
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
      guard let self = self, !self.isRecordingShortcut else { return event }
      let relevantFlags = event.modifierFlags.intersection([.command, .option, .control, .shift])
      let keyCode = UInt32(event.keyCode)
      if let dSpec = self.hotkeySpec,
         keyCode == dSpec.keyCode && relevantFlags == dSpec.eventModifiers {
        self.toggleWindowAction()
        return nil
      }
      if let aSpec = self.auxHotkeySpec,
         keyCode == aSpec.keyCode && relevantFlags == aSpec.eventModifiers {
        self.handleAuxHotKeyTriggered()
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

  func findAntigravityApp() -> NSRunningApplication? {
    let myPid = ProcessInfo.processInfo.processIdentifier
    if let front = NSWorkspace.shared.frontmostApplication,
       front.processIdentifier != myPid,
       isTargetHostApp(front) {
      return front
    }
    if let remembered = lastAntigravityApp, !remembered.isTerminated, isTargetHostApp(remembered) {
      return remembered
    }
    for app in NSWorkspace.shared.runningApplications {
      if app.processIdentifier == myPid || app.isTerminated { continue }
      if isTargetHostApp(app) { return app }
    }
    return nil
  }

  func syncHotKeyForFrontmostApp(_ app: NSRunningApplication?) {
    let inTarget = isTargetHostApp(app)
    let active = !isRecordingShortcut && ((shortcutScope == "global") || inTarget)
    unregisterHotKeys()
    if active {
      if hotkeySpec != nil {
        registerDrawerHotKey()
      }
      if auxHotkeySpec != nil {
        registerAuxHotKey()
      }
    }
  }

  func registerDrawerHotKey() {
    guard hotKeyRef == nil, let spec = hotkeySpec else { return }
    let hotKeyID = EventHotKeyID(signature: kHotKeySignature, id: kDrawerHotKeyId)
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

  func registerAuxHotKey() {
    guard auxHotKeyRef == nil, let spec = auxHotkeySpec else { return }
    let hotKeyID = EventHotKeyID(signature: kHotKeySignature, id: kAuxHotKeyId)
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
      auxHotKeyRef = ref
    }
  }

  func unregisterHotKeys() {
    if let ref = hotKeyRef {
      UnregisterEventHotKey(ref)
      hotKeyRef = nil
    }
    if let ref = auxHotKeyRef {
      UnregisterEventHotKey(ref)
      auxHotKeyRef = nil
    }
  }

  func applyHotkeyPreset(_ rawPreset: String, notifyWeb: Bool) {
    let trimmed = rawPreset.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let spec = parseHotkeyPreset(trimmed)
    hotkeyPreset = spec != nil ? trimmed : "off"
    hotkeySpec = spec
    updateWindowTitle()
    syncHotKeyForFrontmostApp(NSWorkspace.shared.frontmostApplication)
    emitJson(["type": "hotkeyChanged", "hotkeyPreset": hotkeyPreset])
    if notifyWeb {
      let js = "window.__afOnHostEvent && window.__afOnHostEvent({type:'hotkeyChanged',hotkeyPreset:'\(hotkeyPreset)'});"
      webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  func applyDrawerShortcut(spec: HotkeySpec?, scope: String?, notifyWeb: Bool) {
    if let scope = scope, !scope.isEmpty {
      shortcutScope = scope
    }
    hotkeySpec = spec
    isRecordingShortcut = false
    updateWindowTitle()
    syncHotKeyForFrontmostApp(NSWorkspace.shared.frontmostApplication)
    if notifyWeb,
       let data = try? JSONSerialization.data(withJSONObject: [
         "type": "drawerShortcutChanged",
         "enabled": spec != nil,
         "accelerator": spec?.accelerator ?? "",
         "display": spec?.displayLabel ?? "已关闭",
         "scope": shortcutScope
       ], options: []),
       let jsonStr = String(data: data, encoding: .utf8) {
      webView?.evaluateJavaScript("window.__afOnHostEvent && window.__afOnHostEvent(\(jsonStr));", completionHandler: nil)
    }
  }

  func applyAuxShortcut(spec: HotkeySpec?, scope: String?, notifyWeb: Bool) {
    if let scope = scope, !scope.isEmpty {
      shortcutScope = scope
    }
    auxHotkeySpec = spec
    isRecordingShortcut = false
    syncHotKeyForFrontmostApp(NSWorkspace.shared.frontmostApplication)
    if notifyWeb,
       let data = try? JSONSerialization.data(withJSONObject: [
         "type": "auxShortcutChanged",
         "enabled": spec != nil,
         "accelerator": spec?.accelerator ?? "",
         "display": spec?.displayLabel ?? "已关闭",
         "scope": shortcutScope
       ], options: []),
       let jsonStr = String(data: data, encoding: .utf8) {
      webView?.evaluateJavaScript("window.__afOnHostEvent && window.__afOnHostEvent(\(jsonStr));", completionHandler: nil)
    }
  }

  func handleDrawerHotKeyTriggered() {
    toggleWindowAction()
  }

  func handleAuxHotKeyTriggered() {
    let now = ProcessInfo.processInfo.systemUptime
    if now - lastAuxHotkeyAt < 0.14 { return }
    lastAuxHotkeyAt = now

    guard let targetApp = findAntigravityApp() else {
      showHudNotice("未检测到运行中的 Antigravity")
      return
    }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != targetApp.processIdentifier {
      targetApp.activate(options: [])
    }
    emitJson([
      "type": "auxHotkeyTriggered",
      "accelerator": auxHotkeySpec?.accelerator ?? ""
    ])
  }

  @objc func triggerAuxPaneFromMenuAction() {
    handleAuxHotKeyTriggered()
  }

  func showHudNotice(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    if hudPanel == nil {
      let panel = NSPanel(
        contentRect: NSRect(x: 0, y: 0, width: 380, height: 42),
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
      )
      panel.level = .statusBar
      panel.backgroundColor = .clear
      panel.isOpaque = false
      panel.hasShadow = true
      panel.ignoresMouseEvents = true
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

      let bg = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 42))
      bg.wantsLayer = true
      bg.layer?.cornerRadius = 10
      bg.layer?.backgroundColor = NSColor(calibratedWhite: 0.10, alpha: 0.90).cgColor
      bg.layer?.borderWidth = 1
      bg.layer?.borderColor = NSColor(calibratedWhite: 1.0, alpha: 0.14).cgColor

      let label = NSTextField(labelWithString: "")
      label.textColor = .white
      label.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
      label.alignment = .center
      label.lineBreakMode = .byTruncatingTail
      label.frame = NSRect(x: 14, y: 11, width: 352, height: 20)
      bg.addSubview(label)
      panel.contentView = bg
      hudPanel = panel
      hudLabel = label
    }

    guard let panel = hudPanel, let label = hudLabel else { return }
    hudToken += 1
    let token = hudToken
    hudHideWorkItem?.cancel()

    label.stringValue = trimmed
    let textWidth = min(max(ceil(label.attributedStringValue.size().width) + 36, 220), 660)
    let height: CGFloat = 42
    let screenFrame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let x = screenFrame.midX - textWidth / 2.0
    let y = screenFrame.minY + 78
    panel.setFrame(NSRect(x: x, y: y, width: textWidth, height: height), display: true)
    panel.contentView?.frame = NSRect(x: 0, y: 0, width: textWidth, height: height)
    label.frame = NSRect(x: 16, y: 11, width: textWidth - 32, height: 20)

    if isHudShowing && panel.isVisible {
      panel.alphaValue = 1.0
      panel.orderFrontRegardless()
    } else {
      isHudShowing = true
      if shouldReduceMotion() {
        panel.alphaValue = 1.0
        panel.orderFrontRegardless()
      } else {
        panel.alphaValue = 0.0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup({ ctx in
          ctx.duration = 0.15
          ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
          panel.animator().alphaValue = 1.0
        }, completionHandler: nil)
      }
    }

    let item = DispatchWorkItem { [weak self] in
      guard let self = self, self.hudToken == token, let activePanel = self.hudPanel else { return }
      if self.shouldReduceMotion() {
        self.isHudShowing = false
        activePanel.orderOut(nil)
        activePanel.alphaValue = 1.0
      } else {
        NSAnimationContext.runAnimationGroup({ ctx in
          ctx.duration = 0.20
          ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0.0, 1.0, 1.0)
          activePanel.animator().alphaValue = 0.0
        }, completionHandler: { [weak self] in
          guard let self = self, self.hudToken == token else { return }
          self.isHudShowing = false
          self.hudPanel?.orderOut(nil)
          self.hudPanel?.alphaValue = 1.0
        })
      }
    }
    hudHideWorkItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: item)
  }

  // MARK: - Window & Pin Controls

  func windowDidMove(_ notification: Notification) {
    if !isAnimatingVisibility {
      restingOriginX = window?.frame.origin.x
    }
  }

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
      restingOriginX = frame.origin.x
    }
  }

  func showWindow(notifyParent: Bool, revealPath: String? = nil) {
    if let front = NSWorkspace.shared.frontmostApplication {
      _ = isTargetHostApp(front)
    }
    ensureWindowOnVisibleScreen()

    visibilityToken += 1
    let token = visibilityToken
    let targetX = restingOriginX ?? window.frame.origin.x
    restingOriginX = targetX
    let targetOrigin = NSPoint(x: targetX, y: window.frame.origin.y)

    if shouldReduceMotion() {
      isAnimatingVisibility = false
      window.setFrameOrigin(targetOrigin)
      window.alphaValue = 1.0
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    } else if !window.isVisible || window.alphaValue < 0.99 || isAnimatingVisibility {
      if !window.isVisible {
        window.alphaValue = 0.0
        window.setFrameOrigin(NSPoint(x: targetOrigin.x + 12.0, y: targetOrigin.y))
      }
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      isAnimatingVisibility = true
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.18
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
        ctx.allowsImplicitAnimation = true
        window.animator().alphaValue = 1.0
        window.animator().setFrameOrigin(targetOrigin)
      }, completionHandler: { [weak self] in
        guard let self = self, self.visibilityToken == token else { return }
        self.isAnimatingVisibility = false
        self.window.alphaValue = 1.0
        self.window.setFrameOrigin(targetOrigin)
      })
    } else {
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    }

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
    visibilityToken += 1
    let token = visibilityToken
    isWindowVisible = false

    let restX = restingOriginX ?? window.frame.origin.x
    restingOriginX = restX
    let restOrigin = NSPoint(x: restX, y: window.frame.origin.y)

    if shouldReduceMotion() || !window.isVisible {
      isAnimatingVisibility = false
      window.orderOut(nil)
      window.alphaValue = 1.0
      window.setFrameOrigin(restOrigin)
    } else {
      let endOrigin = NSPoint(x: restOrigin.x + 8.0, y: restOrigin.y)
      isAnimatingVisibility = true
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.13
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0.0, 1.0, 1.0)
        ctx.allowsImplicitAnimation = true
        window.animator().alphaValue = 0.0
        window.animator().setFrameOrigin(endOrigin)
      }, completionHandler: { [weak self] in
        guard let self = self, self.visibilityToken == token else { return }
        self.isAnimatingVisibility = false
        self.window.orderOut(nil)
        self.window.alphaValue = 1.0
        self.window.setFrameOrigin(restOrigin)
      })
    }

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
    if isWindowVisible {
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
    if shouldStayResident {
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
    } else if kind == "setRecording" {
      isRecordingShortcut = (obj["recording"] as? Bool) ?? false
      syncHotKeyForFrontmostApp(NSWorkspace.shared.frontmostApplication)
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
    case "setDrawerShortcut":
      applyDrawerShortcut(spec: parseShortcutCommand(msg), scope: msg["scope"] as? String, notifyWeb: true)
    case "setAuxShortcut":
      applyAuxShortcut(spec: parseShortcutCommand(msg), scope: msg["scope"] as? String, notifyWeb: true)
    case "setShortcutRecording":
      isRecordingShortcut = (msg["recording"] as? Bool) ?? false
      syncHotKeyForFrontmostApp(NSWorkspace.shared.frontmostApplication)
    case "activateHost":
      if let targetApp = findAntigravityApp(),
         NSWorkspace.shared.frontmostApplication?.processIdentifier != targetApp.processIdentifier {
        targetApp.activate(options: [])
      }
    case "showHud":
      if let text = msg["message"] as? String {
        showHudNotice(text)
      }
    case "showWindow", "focus":
      showWindow(notifyParent: true, revealPath: msg["revealPath"] as? String)
    case "hideWindow":
      hideWindow(restoreHostFocus: true, notifyParent: true)
    case "toggleWindow":
      toggleWindowAction()
    case "revealPath":
      if let revealPath = msg["revealPath"] as? String, !revealPath.isEmpty {
        if !isWindowVisible {
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

func cliArgValue(_ args: [String], _ flag: String) -> String? {
  guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
  return args[idx + 1]
}

let args = CommandLine.arguments
let initialPinned = !args.contains("--unpinned")
let initialVisible = !args.contains("--hidden-window")
let initialPreset = cliArgValue(args, "--preset") ?? "cmd+shift+e"
let initialScope = cliArgValue(args, "--scope") ?? "app"

var initialDrawerSpec: HotkeySpec? = nil
if !args.contains("--no-drawer-shortcut") {
  if let kcStr = cliArgValue(args, "--drawer-keycode"), let kc = UInt32(kcStr),
     let modsStr = cliArgValue(args, "--drawer-mods"), let mods = UInt32(modsStr) {
    initialDrawerSpec = HotkeySpec(
      accelerator: cliArgValue(args, "--drawer-acc") ?? "",
      keyCode: kc,
      carbonModifiers: mods,
      eventModifiers: carbonModsToNSEventFlags(mods),
      displayLabel: cliArgValue(args, "--drawer-label") ?? ""
    )
  } else {
    initialDrawerSpec = parseHotkeyPreset(initialPreset)
  }
}

var initialAuxSpec: HotkeySpec? = nil
if !args.contains("--no-aux-shortcut") {
  if let kcStr = cliArgValue(args, "--aux-keycode"), let kc = UInt32(kcStr),
     let modsStr = cliArgValue(args, "--aux-mods"), let mods = UInt32(modsStr) {
    initialAuxSpec = HotkeySpec(
      accelerator: cliArgValue(args, "--aux-acc") ?? "",
      keyCode: kc,
      carbonModifiers: mods,
      eventModifiers: carbonModsToNSEventFlags(mods),
      displayLabel: cliArgValue(args, "--aux-label") ?? ""
    )
  } else if initialDrawerSpec?.accelerator == "Alt+Meta+E" {
    initialAuxSpec = HotkeySpec(
      accelerator: "Ctrl+Alt+E",
      keyCode: UInt32(kVK_ANSI_E),
      carbonModifiers: UInt32(controlKey | optionKey),
      eventModifiers: [.control, .option],
      displayLabel: "⌃⌥E"
    )
  } else {
    initialAuxSpec = HotkeySpec(
      accelerator: "Alt+Meta+E",
      keyCode: UInt32(kVK_ANSI_E),
      carbonModifiers: UInt32(cmdKey | optionKey),
      eventModifiers: [.command, .option],
      displayLabel: "⌥⌘E"
    )
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = DrawerWindowController(
  initialPinned: initialPinned,
  initialVisible: initialVisible,
  initialPreset: initialPreset,
  initialDrawerSpec: initialDrawerSpec,
  initialAuxSpec: initialAuxSpec,
  initialScope: initialScope
)
app.delegate = delegate
app.run()
