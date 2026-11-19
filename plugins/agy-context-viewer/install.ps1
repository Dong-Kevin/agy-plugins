<#
.SYNOPSIS
  One-click Installer / Updater / Uninstaller for Antigravity Context & Token Viewer (Windows PowerShell)
  Compatible with both Antigravity Desktop App (agy App / IDE) and agy CLI.

.EXAMPLE
  .\install.ps1
.EXAMPLE
  irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-context-viewer/install.ps1 | iex
.EXAMPLE
  .\install.ps1 -Uninstall
#>

param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$PluginDirName = "context-viewer"
$OrigPluginsDir = if ($env:ANTIGRAVITY_PLUGINS_DIR) { $env:ANTIGRAVITY_PLUGINS_DIR } elseif ($env:AGY_PLUGINS_DIR) { $env:AGY_PLUGINS_DIR } else { "" }
$PluginsRoot = if ($OrigPluginsDir) { $OrigPluginsDir } else { Join-Path $HOME ".gemini\config\plugins" }
$TargetDir = Join-Path $PluginsRoot $PluginDirName
$OrigBinDir = if ($env:ANTIGRAVITY_BIN_DIR) { $env:ANTIGRAVITY_BIN_DIR } elseif ($env:AGY_BIN_DIR) { $env:AGY_BIN_DIR } else { "" }
$BinDir = if ($OrigBinDir) { $OrigBinDir } else { Join-Path $HOME ".local\bin" }
$ShouldManageBin = [bool]($OrigBinDir -or (-not $OrigPluginsDir))
$CliWrapper = Join-Path $BinDir "agy-context.cmd"
$CliLoader = Join-Path $BinDir "agy-context-loader.mjs"
$RepoSlug = if ($env:REPO) { $env:REPO } else { "Dong-Kevin/agy-plugins" }
$GitRef = if ($env:REF) { $env:REF } else { "main" }

$SourceDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "plugin.json")) -and (Test-Path (Join-Path $PSScriptRoot "sidecars\dashboard"))) {
  $SourceDir = $PSScriptRoot
}

if ($Uninstall) {
  $HasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
  if ((-not $OrigPluginsDir) -and $HasNode) {
    $LocalCli = if ($SourceDir) { Join-Path $SourceDir "sidecars\dashboard\cli.mjs" } else { "" }
    $InstalledCli = Join-Path $TargetDir "sidecars\dashboard\cli.mjs"
    $PrevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      if ($LocalCli -and (Test-Path $LocalCli)) {
        & node $LocalCli float quit 1>$null
      } elseif (Test-Path $InstalledCli) {
        $VerifyJs = @'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const cliPath = process.argv[1];
const expectedRel = "sidecars/dashboard/float_window.mjs";
const agDir = process.env.AG_DIR || path.join(os.homedir(), ".gemini", "antigravity");
const stateDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || path.join(agDir, "sidecar_data", "context-viewer", "dashboard", "data");
const statePath = path.join(stateDir, "float_window_state.json");
if (!fs.existsSync(statePath)) process.exit(0);
let obj = null;
try { obj = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
const pid = Number(obj && obj.pid);
if (!Number.isInteger(pid) || pid <= 1) {
  try { fs.rmSync(statePath, { force: true }); } catch {}
  process.exit(0);
}
const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e && e.code === "EPERM"; } };
try { process.kill(pid, 0); } catch {
  try { fs.rmSync(statePath, { force: true }); } catch {}
  process.exit(0);
}
if (process.env.AGY_TEST_PID_IDENTITY_MODE === "unknown") {
  console.error(`[WARN] [context-viewer] 无法核实后台进程身份（PID ${pid}），已跳过发送退出信号；请手动确认进程状态。`);
  process.exit(0);
}
const isExec = (tok) => {
  const raw = String(tok || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  if (!raw) return false;
  const base = raw.split("/").pop() || "";
  return /^(?:node(?:\d+(?:\.\d+)*)?|electron|antigravity|Antigravity(?:\s+Helper(?:\s+\([^)]+\))?)?)(?:\.exe)?$/i.test(base);
};
const isEntry = (cand) => {
  const norm = String(cand || "").trim().replace(/\\/g, "/");
  if (!norm || norm.startsWith("-")) return false;
  return norm === expectedRel || norm.endsWith("/" + expectedRel);
};
const tokenizeWin = (cmdLine) => {
  const s = String(cmdLine || "").trim();
  if (!s) return [];
  const args = [];
  let cur = "", inQuotes = false, i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      let bs = 0;
      while (i < s.length && s[i] === "\\") { bs++; i++; }
      if (i < s.length && s[i] === '"') {
        cur += "\\".repeat(Math.floor(bs / 2));
        if (bs % 2 === 0) inQuotes = !inQuotes;
        else cur += '"';
        i++;
      } else {
        cur += "\\".repeat(bs);
      }
      continue;
    }
    if (ch === '"') {
      if (inQuotes && i + 1 < s.length && s[i + 1] === '"') {
        cur += '"';
        i += 2;
      } else {
        inQuotes = !inQuotes;
        i++;
      }
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      args.push(cur);
      cur = "";
      while (i < s.length && /\s/.test(s[i])) i++;
      continue;
    }
    cur += ch;
    i++;
  }
  args.push(cur);
  return args;
};
const evalStructured = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) return "unknown";
  if (!isExec(argv[0]) || argv.length < 3 || !isEntry(argv[1]) || argv[2] !== "--daemon") return "mismatch";
  return "verified";
};
let status = "unknown";
try {
  const psCmd = `$ErrorActionPreference='Stop'; $p = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + ${pid}); if ($null -eq $p) { [Console]::Out.Write('{"dead":true}') } else { [Console]::Out.Write((@{ dead = $false; name = [string]$p.Name; cmd = [string]$p.CommandLine } | ConvertTo-Json -Compress)) }`;
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", psCmd], {
    encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  if (!raw) {
    status = alive(pid) ? "unknown" : "dead";
  } else {
    const parsed = JSON.parse(raw);
    if (parsed.dead || !alive(pid)) status = "dead";
    else if (parsed.name && !isExec(parsed.name)) status = "mismatch";
    else if (!String(parsed.cmd || "").trim()) status = "unknown";
    else status = evalStructured(tokenizeWin(parsed.cmd));
  }
} catch {
  status = alive(pid) ? "unknown" : "dead";
}
if (status === "verified") {
  try { execFileSync(process.execPath, [cliPath, "float", "quit"], { stdio: ["ignore", "ignore", "inherit"] }); } catch {}
} else if (status === "dead" || status === "mismatch") {
  try { fs.rmSync(statePath, { force: true }); } catch {}
} else {
  console.error(`[WARN] [context-viewer] 无法核实后台进程身份（PID ${pid}），已跳过发送退出信号；请手动确认进程状态。`);
}
'@
        & node -e $VerifyJs $InstalledCli
      }
    } finally {
      $ErrorActionPreference = $PrevEap
    }
  }
  if ($ShouldManageBin -and (Test-Path $CliLoader)) {
    $ExpectedEntry = [System.IO.Path]::GetFullPath((Join-Path $TargetDir "sidecars\dashboard\cli.mjs"))
    $ExpectedB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($ExpectedEntry))
    $LoaderRaw = Get-Content $CliLoader -Raw -ErrorAction SilentlyContinue
    if ($LoaderRaw -and ($LoaderRaw.Contains($ExpectedB64) -or $LoaderRaw.Contains($TargetDir))) {
      Remove-Item -Force $CliLoader
      if ((Test-Path $CliWrapper) -and ((Get-Content $CliWrapper -Raw -ErrorAction SilentlyContinue) -match "agy-context-loader\.mjs")) {
        Remove-Item -Force $CliWrapper
        Write-Host "[context-viewer] 已移除命令行入口：$CliWrapper" -ForegroundColor Green
      }
    }
  }
  if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
    Write-Host "[context-viewer] 已移除插件目录：$TargetDir" -ForegroundColor Green
  } else {
    Write-Host "[context-viewer] 未检测到已安装目录：$TargetDir" -ForegroundColor Cyan
  }
  Write-Host "[context-viewer] 用户本地会话归档与统计偏好设置已安全保留，未做删除。" -ForegroundColor Cyan
  exit 0
}

# 1. Check Node.js >= 18
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未检测到 Node.js，请先安装 Node.js 18 或更高版本。"
}
$NodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 18) {
  throw "当前 Node.js 主版本为 $NodeMajor，需要 Node.js >= 18。"
}

# 2. Locate local checkout or download zip from GitHub
$TempDir = $null
try {
  if (-not $SourceDir) {
    if (-not $RepoSlug) {
      throw "远程安装请先设置 `$env:REPO='Dong-Kevin/agy-plugins' 后再执行脚本。"
    }
    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ag-cv-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $ZipFile = Join-Path $TempDir "repo.zip"
    $ZipUrl = "https://codeload.github.com/$RepoSlug/zip/$GitRef"
    Write-Host "[context-viewer] 正在从 GitHub 下载 $RepoSlug ($GitRef)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipFile
    Expand-Archive -Path $ZipFile -DestinationPath $TempDir -Force
    $AllManifests = Get-ChildItem -Path $TempDir -Filter "plugin.json" -Recurse
    $FoundManifest = $AllManifests | Where-Object { $_.FullName -match "[\\/]plugins[\\/]agy-context-viewer[\\/]plugin\.json$" } | Select-Object -First 1
    if (-not $FoundManifest) {
      $FoundManifest = $AllManifests | Where-Object { $_.FullName -match "[\\/]context-viewer[\\/]plugin\.json$" } | Select-Object -First 1
    }
    if (-not $FoundManifest) {
      $FoundManifest = $AllManifests | Select-Object -First 1
    }
    if (-not $FoundManifest) {
      throw "下载归档中未找到 plugins/agy-context-viewer/plugin.json。"
    }
    $SourceDir = $FoundManifest.Directory.FullName
  }

  # 3. Validate & stage all required runtime files in system temp before touching $TargetDir
  $RequiredDashFiles = @(
    "package.json", "pricing.mjs", "sqlite_reader.mjs", "collector.mjs", "float_window.mjs",
    "native_float_macos.swift", "cli.mjs", "index.html", "styles.css",
    "app.js", "main.mjs", "sidecar.json"
  )
  foreach ($ReqRel in @("plugin.json", "assets\logo.svg", "skills\context-viewer\SKILL.md", "skills\context-viewer\scripts\status.mjs")) {
    if (-not (Test-Path (Join-Path $SourceDir $ReqRel))) {
      throw "安装包缺少必需文件：$ReqRel"
    }
  }
  foreach ($DashFile in $RequiredDashFiles) {
    if (-not (Test-Path (Join-Path $SourceDir "sidecars\dashboard\$DashFile"))) {
      throw "安装包缺少必需文件：sidecars\dashboard\$DashFile"
    }
  }

  $NewCli = Join-Path $SourceDir "sidecars\dashboard\cli.mjs"
  if ((-not $OrigPluginsDir) -and (Test-Path $TargetDir) -and (Test-Path $NewCli)) {
    $PrevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & node $NewCli float quit 1>$null } catch {} finally { $ErrorActionPreference = $PrevEap }
  }

  New-Item -ItemType Directory -Path $PluginsRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $TargetDir "sidecars\dashboard") -Force | Out-Null

  Copy-Item (Join-Path $SourceDir "plugin.json") (Join-Path $TargetDir "plugin.json") -Force
  foreach ($OptFile in @("README.md", "LICENSE")) {
    $OptPath = Join-Path $SourceDir $OptFile
    if (Test-Path $OptPath) { Copy-Item $OptPath (Join-Path $TargetDir $OptFile) -Force }
  }
  $AssetsTarget = Join-Path $TargetDir "assets"
  $SkillsTarget = Join-Path $TargetDir "skills"
  if (Test-Path $AssetsTarget) { Remove-Item -Recurse -Force $AssetsTarget }
  if (Test-Path $SkillsTarget) { Remove-Item -Recurse -Force $SkillsTarget }
  Copy-Item (Join-Path $SourceDir "assets") $AssetsTarget -Recurse -Force
  Copy-Item (Join-Path $SourceDir "skills") $SkillsTarget -Recurse -Force

  foreach ($DashFile in @("package.json", "pricing.mjs", "sqlite_reader.mjs", "collector.mjs", "float_window.mjs", "native_float_macos.swift", "cli.mjs", "index.html", "styles.css", "app.js", "main.mjs")) {
    Copy-Item (Join-Path $SourceDir "sidecars\dashboard\$DashFile") (Join-Path $TargetDir "sidecars\dashboard\$DashFile") -Force
  }
  $SidecarTmp = Join-Path $TargetDir "sidecars\dashboard\.sidecar.json.tmp"
  Copy-Item (Join-Path $SourceDir "sidecars\dashboard\sidecar.json") $SidecarTmp -Force
  Move-Item -Path $SidecarTmp -Destination (Join-Path $TargetDir "sidecars\dashboard\sidecar.json") -Force
  if (-not $OrigPluginsDir) {
    try { & node (Join-Path $TargetDir "sidecars\dashboard\cli.mjs") --sync-manifest 2>&1 | Out-Null } catch {}
  }

  # 4. Create codepage-independent Unicode-safe `agy-context.cmd` + `agy-context-loader.mjs`
  if ($ShouldManageBin) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $CliEntry = [System.IO.Path]::GetFullPath((Join-Path $TargetDir "sidecars\dashboard\cli.mjs"))
    $CliEntryB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($CliEntry))
    $LoaderContent = @(
      "import { pathToFileURL } from 'node:url';",
      "const entry = Buffer.from('$CliEntryB64', 'base64').toString('utf8');",
      "process.argv[1] = entry;",
      "await import(pathToFileURL(entry).href);"
    ) -join "`n"
    $CmdContent = "@echo off`r`nnode `"%~dp0agy-context-loader.mjs`" %*`r`n"
    [System.IO.File]::WriteAllText($CliLoader, "$LoaderContent`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($CliWrapper, $CmdContent, [System.Text.Encoding]::ASCII)
  }

  # 5. Enable via agy CLI if available
  if ((-not $OrigPluginsDir) -and (Get-Command agy -ErrorAction SilentlyContinue)) {
    try { & agy plugin enable $PluginDirName 2>&1 | Out-Null } catch {}
  }

  $Ver = (Get-Content (Join-Path $TargetDir "plugin.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
  Write-Host ""
  Write-Host "[context-viewer] 安装完成！版本：$Ver" -ForegroundColor Green
  Write-Host "  • Antigravity 桌面端：在 Customizations -> Plugins 中开启「上下文与 Token 看板」，可用右侧辅助栏打开，或运行 agy-context float / agy-context aux。"
  Write-Host "  • agy CLI / 终端：在对话中输入 /context-viewer，或在终端运行 `"$CliWrapper`"（支持 aux / float / shortcut / aux-shortcut / web）。"

  $BatchList = @()
  if ($env:AGY_INSTALL_BATCH) {
    $BatchList = $env:AGY_INSTALL_BATCH.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  }
  $PeerManifest = Join-Path $PluginsRoot "agy-finder\plugin.json"
  if ((-not ($BatchList -contains "agy-finder")) -and (Test-Path $PeerManifest)) {
    try {
      $PeerVerRaw = [string]((Get-Content $PeerManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version)
      if ($PeerVerRaw -match '^v?(\d+)\.(\d+)\.(\d+)') {
        $PV = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
        if ($PV -lt [version]::new(0, 2, 4)) {
          Write-Host "[WARN] [context-viewer] 检测到同机已安装的 agy-finder 版本为 v$($PeerVerRaw.TrimStart('v'))（低于共享触发锁协议所需的 v0.2.4）。请同步升级 agy-finder（例如在总仓运行 .\install.ps1）并重载宿主或重启旧后台实例，以避免旧版锁回收竞争。" -ForegroundColor Yellow
        }
      }
    } catch {}
  }
} finally {
  if ($TempDir -and (Test-Path $TempDir)) {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
  }
}
