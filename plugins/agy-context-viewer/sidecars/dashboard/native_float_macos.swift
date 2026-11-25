import Cocoa
import WebKit
import Carbon
import QuartzCore

// Native macOS Menu Bar (`NSStatusItem`), Carbon HotKey & Right-Side Floating Window Host
// for Antigravity Context & Token Viewer.
// Communicates with `float_window.mjs` strictly over stdin/stdout JSON lines
// (zero TCP ports, zero proxy interference, zero Accessibility/TCC prompts).

private func carbonHotKeyHandler(
  _ nextHandler: EventHandlerCallRef?,
  _ event: EventRef?,
  _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
  guard let ptr = userData, let ev = event else { return OSStatus(eventNotHandledErr) }
  var hkID = EventHotKeyID()
  let status = GetEventParameter(
    ev,
    EventParamName(kEventParamDirectObject),
    EventParamType(typeEventHotKeyID),
    nil,
    MemoryLayout<EventHotKeyID>.size,
    nil,
    &hkID
  )
  let keyId = (status == noErr) ? hkID.id : 1
  let controller = Unmanaged<FloatWindowController>.fromOpaque(ptr).takeUnretainedValue()
  DispatchQueue.main.async {
    if keyId == 2 {
      controller.triggerAuxPaneFromHotkey()
    } else {
      controller.toggleWindowFromHotkey()
    }
  }
  return noErr
}

final class FloatBridge: NSObject, WKScriptMessageHandler {
  weak var controller: FloatWindowController?

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? String else { return }
    controller?.handleWebMessage(body)
  }
}

final class FloatWindowController: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var webView: WKWebView!
  var pinAccessoryButton: NSButton!
  var statusItem: NSStatusItem?
  let bridge = FloatBridge()

  var isPinned: Bool
  var isMenubarEnabled: Bool
  var isWindowVisible: Bool
  var menubarMode: String
  var statusTitle: String
  var statusTooltip: String = "上下文与 Token 看板\n\n左键显隐看板 · 右键切换模式与置顶"

  var isShortcutEnabled: Bool
  var shortcutKeyCode: Int
  var shortcutModifiers: Int
  var shortcutLabel: String
  var isAuxShortcutEnabled: Bool
  var auxShortcutKeyCode: Int
  var auxShortcutModifiers: Int
  var auxShortcutLabel: String
  var shortcutScope: String
  var isRecordingShortcut: Bool = false
  var hotKeyRef: EventHotKeyRef?
  var registeredKeyCode: Int = -1
  var registeredModifiers: Int = -1
  var auxHotKeyRef: EventHotKeyRef?
  var registeredAuxKeyCode: Int = -1
  var registeredAuxModifiers: Int = -1
  var eventHandlerRef: EventHandlerRef?
  var workspaceObserver: NSObjectProtocol?
  var lastExternalApp: NSRunningApplication?
  var lastHotkeyAt: TimeInterval = 0
  var lastAuxHotkeyAt: TimeInterval = 0
  var hudWindow: NSWindow?
  var hudHideWorkItem: DispatchWorkItem?
  var visibilityToken: Int = 0
  var hudToken: Int = 0

  private var shouldReduceMotion: Bool {
    return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
  }

  var shouldStayResident: Bool {
    return isMenubarEnabled || isShortcutEnabled || isAuxShortcutEnabled
  }

  init(
    initialPinned: Bool,
    initialMenubar: Bool,
    initialVisible: Bool,
    initialMode: String,
    initialShortcutEnabled: Bool,
    initialShortcutKeyCode: Int,
    initialShortcutModifiers: Int,
    initialShortcutLabel: String,
    initialAuxShortcutEnabled: Bool,
    initialAuxShortcutKeyCode: Int,
    initialAuxShortcutModifiers: Int,
    initialAuxShortcutLabel: String,
    initialShortcutScope: String
  ) {
    self.isPinned = initialPinned
    self.isMenubarEnabled = initialMenubar
    self.isWindowVisible = initialVisible
    self.menubarMode = initialMode
    self.isShortcutEnabled = initialShortcutEnabled
    self.shortcutKeyCode = initialShortcutKeyCode
    self.shortcutModifiers = initialShortcutModifiers
    self.shortcutLabel = initialShortcutLabel
    self.isAuxShortcutEnabled = initialAuxShortcutEnabled
    self.auxShortcutKeyCode = initialAuxShortcutKeyCode
    self.auxShortcutModifiers = initialAuxShortcutModifiers
    self.auxShortcutLabel = initialAuxShortcutLabel
    self.shortcutScope = (initialShortcutScope == "global") ? "global" : "app"
    switch initialMode {
    case "speed":
      self.statusTitle = "⚡ --t/s"
    case "quota":
      self.statusTitle = "⏳ --%"
    default:
      self.statusTitle = "◈ --%"
    }
    super.init()
    bridge.controller = self
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
    let hideAppItem = NSMenuItem(title: "隐藏窗口", action: #selector(hideWindowAction), keyEquivalent: "h")
    hideAppItem.target = self
    appMenu.addItem(hideAppItem)
    appMenu.addItem(NSMenuItem.separator())
    let quitAppItem = NSMenuItem(title: "退出悬浮看板", action: #selector(quitAction), keyEquivalent: "q")
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
    let defaultWidth: CGFloat = 432
    let defaultHeight: CGFloat = min(880, max(540, screenFrame.height - 24))
    let defaultX: CGFloat = max(screenFrame.minX + 12, screenFrame.maxX - defaultWidth - 10)
    let defaultY: CGFloat = screenFrame.minY + (screenFrame.height - defaultHeight) / 2.0
    let initialRect = NSRect(x: defaultX, y: defaultY, width: defaultWidth, height: defaultHeight)

    window = NSWindow(
      contentRect: initialRect,
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.minSize = NSSize(width: 350, height: 420)
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.setFrameAutosaveName("AntigravityContextViewerFloatV1")

    // Native right-side titlebar Pin / Unpin button
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
    config.userContentController.add(bridge, name: "cvBridge")
    webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
    webView.autoresizingMask = [.width, .height]
    window.contentView?.addSubview(webView)

    applyPinnedState(isPinned, notifyWeb: false)
    applyMenubarState(isMenubarEnabled, notifyWeb: false)
    setupHotKeyMonitor()

    if isWindowVisible {
      showWindow(notifyParent: false)
    }

    startStdinReader()
    emitJson([
      "type": "ready",
      "pinned": isPinned,
      "menubarEnabled": isMenubarEnabled,
      "menubarMode": menubarMode,
      "shortcutEnabled": isShortcutEnabled,
      "auxShortcutEnabled": isAuxShortcutEnabled,
      "shortcutScope": shortcutScope,
      "windowVisible": isWindowVisible
    ])
  }

  // MARK: - Carbon HotKey & Scope Tracking

  func setupHotKeyMonitor() {
    var eventType = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )
    InstallEventHandler(
      GetApplicationEventTarget(),
      carbonHotKeyHandler,
      1,
      &eventType,
      Unmanaged.passUnretained(self).toOpaque(),
      &eventHandlerRef
    )

    if let front = NSWorkspace.shared.frontmostApplication,
       front.processIdentifier != ProcessInfo.processInfo.processIdentifier {
      lastExternalApp = front
    }

    workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.didActivateApplicationNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard let self = self else { return }
      let activated = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      if let ext = activated, ext.processIdentifier != ProcessInfo.processInfo.processIdentifier {
        self.lastExternalApp = ext
        if self.isRecordingShortcut {
          self.isRecordingShortcut = false
        }
      }
      self.syncHotKeyRegistration(frontApp: activated ?? NSWorkspace.shared.frontmostApplication)
    }

    syncHotKeyRegistration()
  }

  func isAllowedFrontApp(_ app: NSRunningApplication?) -> Bool {
    guard let front = app else { return false }
    if front.processIdentifier == ProcessInfo.processInfo.processIdentifier {
      return true
    }
    let name = (front.localizedName ?? "").lowercased()
    let bundle = (front.bundleIdentifier ?? "").lowercased()
    let execPath = (front.executableURL?.path ?? "").lowercased()
    return name.contains("antigravity") || bundle.contains("antigravity") || execPath.contains("antigravity")
  }

  func findAntigravityApp() -> NSRunningApplication? {
    let myPid = ProcessInfo.processInfo.processIdentifier
    if let front = NSWorkspace.shared.frontmostApplication,
       front.processIdentifier != myPid,
       isAllowedFrontApp(front) {
      return front
    }
    for app in NSWorkspace.shared.runningApplications {
      if app.processIdentifier == myPid || app.isTerminated { continue }
      if isAllowedFrontApp(app) { return app }
    }
    return nil
  }

  func unregisterFloatHotKeyIfNeeded() {
    if let ref = hotKeyRef {
      UnregisterEventHotKey(ref)
      hotKeyRef = nil
    }
    registeredKeyCode = -1
    registeredModifiers = -1
  }

  func unregisterAuxHotKeyIfNeeded() {
    if let ref = auxHotKeyRef {
      UnregisterEventHotKey(ref)
      auxHotKeyRef = nil
    }
    registeredAuxKeyCode = -1
    registeredAuxModifiers = -1
  }

  func unregisterHotKeyIfNeeded() {
    unregisterFloatHotKeyIfNeeded()
    unregisterAuxHotKeyIfNeeded()
  }

  func syncHotKeyRegistration(frontApp: NSRunningApplication? = NSWorkspace.shared.frontmostApplication) {
    let allowedByScope = (shortcutScope == "global") || isAllowedFrontApp(frontApp)

    let wantFloat = isShortcutEnabled && !isRecordingShortcut && shortcutKeyCode >= 0 && allowedByScope
    if !wantFloat {
      unregisterFloatHotKeyIfNeeded()
    } else if hotKeyRef == nil || registeredKeyCode != shortcutKeyCode || registeredModifiers != shortcutModifiers {
      unregisterFloatHotKeyIfNeeded()
      let hotKeyID = EventHotKeyID(signature: OSType(0x4356484B), id: 1)
      var newRef: EventHotKeyRef? = nil
      let status = RegisterEventHotKey(
        UInt32(shortcutKeyCode),
        UInt32(shortcutModifiers),
        hotKeyID,
        GetApplicationEventTarget(),
        0,
        &newRef
      )
      if status == noErr, let validRef = newRef {
        hotKeyRef = validRef
        registeredKeyCode = shortcutKeyCode
        registeredModifiers = shortcutModifiers
      }
    }

    let conflictsWithFloat = wantFloat && shortcutKeyCode == auxShortcutKeyCode && shortcutModifiers == auxShortcutModifiers
    let wantAux = isAuxShortcutEnabled && !isRecordingShortcut && auxShortcutKeyCode >= 0 && allowedByScope && !conflictsWithFloat
    if !wantAux {
      unregisterAuxHotKeyIfNeeded()
    } else if auxHotKeyRef == nil || registeredAuxKeyCode != auxShortcutKeyCode || registeredAuxModifiers != auxShortcutModifiers {
      unregisterAuxHotKeyIfNeeded()
      let auxKeyID = EventHotKeyID(signature: OSType(0x4356484B), id: 2)
      var newAuxRef: EventHotKeyRef? = nil
      let auxStatus = RegisterEventHotKey(
        UInt32(auxShortcutKeyCode),
        UInt32(auxShortcutModifiers),
        auxKeyID,
        GetApplicationEventTarget(),
        0,
        &newAuxRef
      )
      if auxStatus == noErr, let validAuxRef = newAuxRef {
        auxHotKeyRef = validAuxRef
        registeredAuxKeyCode = auxShortcutKeyCode
        registeredAuxModifiers = auxShortcutModifiers
      }
    }
  }

  func triggerAuxPaneFromHotkey() {
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
    emitJson(["type": "auxHotkeyTriggered"])
  }

  @objc func toggleAuxPaneFromMenuAction() {
    triggerAuxPaneFromHotkey()
  }

  func showHudNotice(_ text: String) {
    hudHideWorkItem?.cancel()
    hudHideWorkItem = nil
    hudToken += 1
    let token = hudToken

    let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
    let textWidth = ceil((text as NSString).size(withAttributes: [.font: font]).width)
    let panelWidth: CGFloat = min(660, max(320, textWidth + 36))
    let panelHeight: CGFloat = 48
    let rect = NSRect(
      x: screenFrame.midX - panelWidth / 2.0,
      y: screenFrame.maxY - panelHeight - 64,
      width: panelWidth,
      height: panelHeight
    )

    let wasVisible = (hudWindow?.isVisible == true) && ((hudWindow?.alphaValue ?? 0) > 0.05)
    let panel: NSWindow
    if let existing = hudWindow {
      panel = existing
      panel.setFrame(rect, display: true)
    } else {
      panel = NSPanel(
        contentRect: rect,
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered,
        defer: false
      )
      panel.level = .floating
      panel.isOpaque = false
      panel.backgroundColor = .clear
      panel.hasShadow = true
      panel.ignoresMouseEvents = true
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      hudWindow = panel
    }

    let container = NSView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight))
    container.wantsLayer = true
    container.layer?.backgroundColor = NSColor(white: 0.1, alpha: 0.9).cgColor
    container.layer?.cornerRadius = 10
    container.layer?.borderWidth = 1
    container.layer?.borderColor = NSColor(white: 1.0, alpha: 0.14).cgColor

    let label = NSTextField(labelWithString: text)
    label.font = NSFont.systemFont(ofSize: 12.5, weight: .medium)
    label.textColor = .white
    label.alignment = .center
    label.lineBreakMode = .byTruncatingTail
    label.frame = NSRect(x: 14, y: 14, width: panelWidth - 28, height: 20)
    container.addSubview(label)

    panel.contentView = container
    if shouldReduceMotion || wasVisible {
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

    let work = DispatchWorkItem { [weak self] in
      guard let self = self, self.hudToken == token, let activePanel = self.hudWindow else { return }
      if self.shouldReduceMotion {
        activePanel.orderOut(nil)
        activePanel.alphaValue = 1.0
        return
      }
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.20
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0.0, 1.0, 1.0)
        activePanel.animator().alphaValue = 0.0
      }, completionHandler: { [weak self] in
        guard let self = self, self.hudToken == token else { return }
        activePanel.orderOut(nil)
        activePanel.alphaValue = 1.0
      })
    }
    hudHideWorkItem = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: work)
  }

  func toggleWindowFromHotkey() {
    let now = ProcessInfo.processInfo.systemUptime
    if now - lastHotkeyAt < 0.14 { return }
    lastHotkeyAt = now

    if !window.isVisible || (!isPinned && !NSApp.isActive) {
      if let front = NSWorkspace.shared.frontmostApplication,
         front.processIdentifier != ProcessInfo.processInfo.processIdentifier {
        lastExternalApp = front
      }
      showWindow(notifyParent: true)
    } else {
      let wasActive = NSApp.isActive
      hideWindow(notifyParent: true)
      if wasActive, let prev = lastExternalApp, !prev.isTerminated {
        prev.activate(options: [])
      }
    }
  }

  // MARK: - Menu Bar (`NSStatusItem`)

  func applyMenubarState(_ enabled: Bool, title: String? = nil, tooltip: String? = nil, notifyWeb: Bool = true) {
    isMenubarEnabled = enabled
    if let t = title, !t.isEmpty { statusTitle = t }
    if let tip = tooltip, !tip.isEmpty { statusTooltip = tip }

    if enabled {
      if statusItem == nil {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = item.button {
          btn.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
          btn.target = self
          btn.action = #selector(statusBarClicked(_:))
          btn.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        statusItem = item
      }
      statusItem?.button?.title = statusTitle
      statusItem?.button?.toolTip = statusTooltip
    } else if let item = statusItem {
      NSStatusBar.system.removeStatusItem(item)
      statusItem = nil
    }

    if notifyWeb {
      let js = "window.__cvOnHostMenubarChange && window.__cvOnHostMenubarChange(\(enabled ? "true" : "false"));"
      webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  @objc func statusBarClicked(_ sender: NSStatusBarButton) {
    let ev = NSApp.currentEvent
    let isRightClick = (ev?.type == .rightMouseUp) || (ev?.modifierFlags.contains(.control) == true)
    if isRightClick {
      let menu = NSMenu()
      let scSuffix = (isShortcutEnabled && !shortcutLabel.isEmpty) ? " (\(shortcutLabel))" : ""
      let toggleItem = NSMenuItem(
        title: (window.isVisible ? "隐藏右侧看板小窗" : "弹出右侧看板小窗") + scSuffix,
        action: #selector(toggleWindowAction),
        keyEquivalent: ""
      )
      toggleItem.target = self
      menu.addItem(toggleItem)

      let auxSuffix = (isAuxShortcutEnabled && !auxShortcutLabel.isEmpty) ? " (\(auxShortcutLabel))" : ""
      let auxItem = NSMenuItem(
        title: "切换 AGY 侧栏看板" + auxSuffix,
        action: #selector(toggleAuxPaneFromMenuAction),
        keyEquivalent: ""
      )
      auxItem.target = self
      menu.addItem(auxItem)

      let pinItem = NSMenuItem(
        title: "窗口置顶在屏幕最前",
        action: #selector(togglePinnedAction),
        keyEquivalent: ""
      )
      pinItem.state = isPinned ? .on : .off
      pinItem.target = self
      menu.addItem(pinItem)

      menu.addItem(NSMenuItem.separator())

      let modeHeader = NSMenuItem(title: "菜单栏显示内容（跟随当前会话）", action: nil, keyEquivalent: "")
      modeHeader.isEnabled = false
      menu.addItem(modeHeader)

      let modeCtxItem = NSMenuItem(
        title: "当前上下文使用占比",
        action: #selector(selectModeContextAction),
        keyEquivalent: ""
      )
      modeCtxItem.state = (menubarMode == "context") ? .on : .off
      modeCtxItem.target = self
      menu.addItem(modeCtxItem)

      let modeSpdItem = NSMenuItem(
        title: "最新生成速度与耗时 (均值/峰值)",
        action: #selector(selectModeSpeedAction),
        keyEquivalent: ""
      )
      modeSpdItem.state = (menubarMode == "speed") ? .on : .off
      modeSpdItem.target = self
      menu.addItem(modeSpdItem)

      let modeQtaItem = NSMenuItem(
        title: "5 小时 / Week 额度余量",
        action: #selector(selectModeQuotaAction),
        keyEquivalent: ""
      )
      modeQtaItem.state = (menubarMode == "quota") ? .on : .off
      modeQtaItem.target = self
      menu.addItem(modeQtaItem)

      menu.addItem(NSMenuItem.separator())

      let hideBarItem = NSMenuItem(
        title: "关闭顶部菜单栏图标",
        action: #selector(disableMenubarFromMenuAction),
        keyEquivalent: ""
      )
      hideBarItem.target = self
      menu.addItem(hideBarItem)

      let quitItem = NSMenuItem(
        title: "彻底退出悬浮看板",
        action: #selector(quitAction),
        keyEquivalent: ""
      )
      quitItem.target = self
      menu.addItem(quitItem)

      let popY: CGFloat = sender.isFlipped ? sender.bounds.maxY + 4 : -4
      menu.popUp(positioning: nil, at: NSPoint(x: 0, y: popY), in: sender)
    } else {
      toggleWindowAction()
    }
  }

  func selectMenubarModeFromMenu(_ mode: String) {
    menubarMode = mode
    let js = "window.__cvOnHostMenubarModeChange && window.__cvOnHostMenubarModeChange('\(mode)');"
    webView?.evaluateJavaScript(js, completionHandler: nil)
    emitJson(["type": "menubarModeChanged", "mode": mode])
  }

  @objc func selectModeContextAction() {
    selectMenubarModeFromMenu("context")
  }

  @objc func selectModeSpeedAction() {
    selectMenubarModeFromMenu("speed")
  }

  @objc func selectModeQuotaAction() {
    selectMenubarModeFromMenu("quota")
  }

  @objc func disableMenubarFromMenuAction() {
    applyMenubarState(false, notifyWeb: true)
    emitJson(["type": "userDisabledMenubar", "windowVisible": window.isVisible])
    if !window.isVisible && !shouldStayResident {
      NSApp.terminate(nil)
    }
  }

  @objc func quitAction() {
    unregisterHotKeyIfNeeded()
    emitJson(["type": "closed"])
    NSApp.terminate(nil)
  }

  // MARK: - Window Show / Hide / Pin

  func showWindow(notifyParent: Bool = true) {
    visibilityToken += 1
    if window.isMiniaturized { window.deminiaturize(nil) }
    if shouldReduceMotion {
      window.alphaValue = 1.0
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    } else {
      let alreadyVisible = window.isVisible
      if !alreadyVisible {
        window.alphaValue = 0.0
      }
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      if !alreadyVisible || window.alphaValue < 0.99 {
        NSAnimationContext.runAnimationGroup({ ctx in
          ctx.duration = 0.18
          ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.0, 0.36, 1.0)
          window.animator().alphaValue = 1.0
        }, completionHandler: nil)
      }
    }
    isWindowVisible = true
    syncHotKeyRegistration()
    webView?.evaluateJavaScript("window.__cvOnHostVisibility && window.__cvOnHostVisibility(true);", completionHandler: nil)
    if notifyParent {
      emitJson(["type": "visibilityChanged", "windowVisible": true])
    }
  }

  func hideWindow(notifyParent: Bool = true) {
    if isRecordingShortcut {
      isRecordingShortcut = false
    }
    visibilityToken += 1
    let token = visibilityToken
    isWindowVisible = false
    syncHotKeyRegistration()
    webView?.evaluateJavaScript("window.__cvOnHostVisibility && window.__cvOnHostVisibility(false);", completionHandler: nil)
    if notifyParent {
      emitJson(["type": "visibilityChanged", "windowVisible": false])
    }
    if shouldReduceMotion || !window.isVisible {
      window.orderOut(nil)
      window.alphaValue = 1.0
      return
    }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = 0.13
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.4, 0.0, 1.0, 1.0)
      window.animator().alphaValue = 0.0
    }, completionHandler: { [weak self] in
      guard let self = self, self.visibilityToken == token else { return }
      self.window.orderOut(nil)
      self.window.alphaValue = 1.0
    })
  }

  @objc func hideWindowAction() {
    if shouldStayResident {
      hideWindow(notifyParent: true)
    } else {
      unregisterHotKeyIfNeeded()
      emitJson(["type": "closed"])
      NSApp.terminate(nil)
    }
  }

  @objc func toggleWindowAction() {
    if !window.isVisible || (!isPinned && !NSApp.isActive) {
      if let front = NSWorkspace.shared.frontmostApplication,
         front.processIdentifier != ProcessInfo.processInfo.processIdentifier {
        lastExternalApp = front
      }
      showWindow(notifyParent: true)
    } else {
      hideWindow(notifyParent: true)
    }
  }

  @objc func togglePinnedAction() {
    applyPinnedState(!isPinned, notifyWeb: true)
  }

  func applyPinnedState(_ pinned: Bool, notifyWeb: Bool) {
    isPinned = pinned
    if pinned {
      window.level = .floating
      window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      window.title = "上下文看板 · 已钉在右侧"
      pinAccessoryButton?.title = "📌 已置顶"
    } else {
      window.level = .normal
      window.collectionBehavior = []
      window.title = "上下文看板"
      pinAccessoryButton?.title = "📍 置顶"
    }
    emitJson(["type": "pinChanged", "pinned": pinned])
    if notifyWeb {
      let js = "window.__cvOnHostPinChange && window.__cvOnHostPinChange(\(pinned ? "true" : "false"));"
      webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    if shouldStayResident {
      hideWindow(notifyParent: true)
      return false
    } else {
      unregisterHotKeyIfNeeded()
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
    } else if kind == "setShortcutRecording" {
      isRecordingShortcut = (obj["recording"] as? Bool) ?? false
      syncHotKeyRegistration()
    } else if kind == "closeWindow" {
      hideWindowAction()
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
      let js = "window.__cvResolveRpc && window.__cvResolveRpc(\(id), \(status), \(payloadJson));"
      webView.evaluateJavaScript(js, completionHandler: nil)
    case "setPinned":
      if let p = msg["pinned"] as? Bool {
        applyPinnedState(p, notifyWeb: true)
      }
    case "setMenubar":
      let en = (msg["enabled"] as? Bool) ?? isMenubarEnabled
      if let m = msg["mode"] as? String, !m.isEmpty {
        menubarMode = m
      }
      applyMenubarState(en, title: msg["title"] as? String, tooltip: msg["tooltip"] as? String, notifyWeb: true)
      if !shouldStayResident && !window.isVisible {
        unregisterHotKeyIfNeeded()
        emitJson(["type": "closed"])
        NSApp.terminate(nil)
      }
    case "setShortcut":
      if let en = msg["enabled"] as? Bool {
        isShortcutEnabled = en
      }
      if let kc = msg["keyCode"] as? Int {
        shortcutKeyCode = kc
      }
      if let mods = msg["modifiers"] as? Int {
        shortcutModifiers = mods
      }
      if let lbl = msg["label"] as? String {
        shortcutLabel = lbl
      }
      if let sc = msg["scope"] as? String {
        shortcutScope = (sc == "global") ? "global" : "app"
      }
      isRecordingShortcut = false
      syncHotKeyRegistration()
      if let scJsonData = try? JSONSerialization.data(withJSONObject: [
        "enabled": isShortcutEnabled,
        "accelerator": (msg["accelerator"] as? String) ?? "",
        "display": shortcutLabel,
        "scope": shortcutScope
      ], options: []), let scJson = String(data: scJsonData, encoding: .utf8) {
        let js = "window.__cvOnHostShortcutChange && window.__cvOnHostShortcutChange(\(scJson));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
      }
      if !shouldStayResident && !window.isVisible {
        unregisterHotKeyIfNeeded()
        emitJson(["type": "closed"])
        NSApp.terminate(nil)
      }
    case "setAuxShortcut":
      if let en = msg["enabled"] as? Bool {
        isAuxShortcutEnabled = en
      }
      if let kc = msg["keyCode"] as? Int {
        auxShortcutKeyCode = kc
      }
      if let mods = msg["modifiers"] as? Int {
        auxShortcutModifiers = mods
      }
      if let lbl = msg["label"] as? String {
        auxShortcutLabel = lbl
      }
      if let sc = msg["scope"] as? String {
        shortcutScope = (sc == "global") ? "global" : "app"
      }
      isRecordingShortcut = false
      syncHotKeyRegistration()
      if let scJsonData = try? JSONSerialization.data(withJSONObject: [
        "enabled": isAuxShortcutEnabled,
        "accelerator": (msg["accelerator"] as? String) ?? "",
        "display": auxShortcutLabel,
        "scope": shortcutScope
      ], options: []), let scJson = String(data: scJsonData, encoding: .utf8) {
        let js = "window.__cvOnHostAuxShortcutChange && window.__cvOnHostAuxShortcutChange(\(scJson));"
        webView?.evaluateJavaScript(js, completionHandler: nil)
      }
      if !shouldStayResident && !window.isVisible {
        unregisterHotKeyIfNeeded()
        emitJson(["type": "closed"])
        NSApp.terminate(nil)
      }
    case "showHud":
      if let text = msg["text"] as? String, !text.isEmpty {
        showHudNotice(text)
      }
    case "setRecording":
      isRecordingShortcut = (msg["recording"] as? Bool) ?? false
      syncHotKeyRegistration()
    case "activateHost":
      if let targetApp = findAntigravityApp(),
         NSWorkspace.shared.frontmostApplication?.processIdentifier != targetApp.processIdentifier {
        targetApp.activate(options: [])
      }
    case "setMenubarMode":
      if let m = msg["mode"] as? String, !m.isEmpty {
        menubarMode = m
        let js = "window.__cvOnHostMenubarModeChange && window.__cvOnHostMenubarModeChange('\(m)');"
        webView?.evaluateJavaScript(js, completionHandler: nil)
      }
      if let t = msg["title"] as? String, !t.isEmpty {
        statusTitle = t
        statusItem?.button?.title = t
      }
      if let tip = msg["tooltip"] as? String, !tip.isEmpty {
        statusTooltip = tip
        statusItem?.button?.toolTip = tip
      }
    case "updateStatusItem":
      if let m = msg["mode"] as? String, !m.isEmpty {
        menubarMode = m
      }
      if let t = msg["title"] as? String, !t.isEmpty {
        statusTitle = t
        statusItem?.button?.title = t
      }
      if let tip = msg["tooltip"] as? String, !tip.isEmpty {
        statusTooltip = tip
        statusItem?.button?.toolTip = tip
      }
    case "showWindow", "focus":
      showWindow(notifyParent: true)
    case "hideWindow":
      hideWindowAction()
    case "toggleWindow":
      toggleWindowAction()
    case "quit":
      unregisterHotKeyIfNeeded()
      NSApp.terminate(nil)
    default:
      break
    }
  }
}

let args = CommandLine.arguments
let initialPinned = !args.contains("--unpinned")
let initialMenubar = !args.contains("--no-menubar")
let initialVisible = !args.contains("--hidden-window")
var initialMode = "context"
if let idx = args.firstIndex(of: "--mode"), idx + 1 < args.count {
  let candidate = args[idx + 1]
  if candidate == "context" || candidate == "speed" || candidate == "quota" {
    initialMode = candidate
  }
}

let initialShortcutEnabled = !args.contains("--no-shortcut")
var initialShortcutKeyCode = Int(kVK_ANSI_K)
if let idx = args.firstIndex(of: "--shortcut-keycode"), idx + 1 < args.count, let v = Int(args[idx + 1]) {
  initialShortcutKeyCode = v
}
var initialShortcutModifiers = Int(cmdKey | optionKey)
if let idx = args.firstIndex(of: "--shortcut-mods"), idx + 1 < args.count, let v = Int(args[idx + 1]) {
  initialShortcutModifiers = v
}
var initialShortcutLabel = "⌥⌘K"
if let idx = args.firstIndex(of: "--shortcut-label"), idx + 1 < args.count {
  initialShortcutLabel = args[idx + 1]
}
let initialAuxShortcutEnabled = !args.contains("--no-aux-shortcut")
var initialAuxShortcutKeyCode = Int(kVK_ANSI_K)
if let idx = args.firstIndex(of: "--aux-keycode"), idx + 1 < args.count, let v = Int(args[idx + 1]) {
  initialAuxShortcutKeyCode = v
}
var initialAuxShortcutModifiers = Int(controlKey | optionKey)
if let idx = args.firstIndex(of: "--aux-mods"), idx + 1 < args.count, let v = Int(args[idx + 1]) {
  initialAuxShortcutModifiers = v
}
var initialAuxShortcutLabel = "⌃⌥K"
if let idx = args.firstIndex(of: "--aux-label"), idx + 1 < args.count {
  initialAuxShortcutLabel = args[idx + 1]
}
var initialShortcutScope = "app"
if let idx = args.firstIndex(of: "--shortcut-scope"), idx + 1 < args.count {
  let sc = args[idx + 1]
  if sc == "app" || sc == "global" {
    initialShortcutScope = sc
  }
}

let app = NSApplication.shared
// `.accessory` keeps the user's Dock uncluttered while rendering StatusItem + floating window
app.setActivationPolicy(.accessory)
let delegate = FloatWindowController(
  initialPinned: initialPinned,
  initialMenubar: initialMenubar,
  initialVisible: initialVisible,
  initialMode: initialMode,
  initialShortcutEnabled: initialShortcutEnabled,
  initialShortcutKeyCode: initialShortcutKeyCode,
  initialShortcutModifiers: initialShortcutModifiers,
  initialShortcutLabel: initialShortcutLabel,
  initialAuxShortcutEnabled: initialAuxShortcutEnabled,
  initialAuxShortcutKeyCode: initialAuxShortcutKeyCode,
  initialAuxShortcutModifiers: initialAuxShortcutModifiers,
  initialAuxShortcutLabel: initialAuxShortcutLabel,
  initialShortcutScope: initialShortcutScope
)
app.delegate = delegate
app.run()
