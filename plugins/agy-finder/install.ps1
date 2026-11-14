<#
.SYNOPSIS
  One-click Installer / Updater / Uninstaller for AGY Finder (Windows PowerShell)

.EXAMPLE
  .\install.ps1
.EXAMPLE
  irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/plugins/agy-finder/install.ps1 | iex
.EXAMPLE
  .\install.ps1 -Uninstall
#>

param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$OrigPluginsDir = if ($env:AGY_PLUGINS_DIR) { $env:AGY_PLUGINS_DIR } elseif ($env:ANTIGRAVITY_PLUGINS_DIR) { $env:ANTIGRAVITY_PLUGINS_DIR } else { "" }
$PluginsDir = if ($OrigPluginsDir) { $OrigPluginsDir } else { Join-Path $HOME ".gemini\config\plugins" }
$TargetDir = Join-Path $PluginsDir "agy-finder"
$OrigBinDir = if ($env:AGY_BIN_DIR) { $env:AGY_BIN_DIR } elseif ($env:ANTIGRAVITY_BIN_DIR) { $env:ANTIGRAVITY_BIN_DIR } else { "" }
$BinDir = if ($OrigBinDir) { $OrigBinDir } else { Join-Path $HOME ".local\bin" }
$ShouldManageBin = [bool]($OrigBinDir -or (-not $OrigPluginsDir))
$CliWrapper = Join-Path $BinDir "agy-finder.cmd"
$CliLoader = Join-Path $BinDir "agy-finder-loader.mjs"
$RepoSlug = if ($env:REPO) { $env:REPO } else { "Dong-Kevin/agy-plugins" }
$GitRef = if ($env:REF) { $env:REF } else { "main" }

$ScriptDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "plugin.json")) -and (Test-Path (Join-Path $PSScriptRoot "sidecars\tree"))) {
  $ScriptDir = $PSScriptRoot
}

if ($Uninstall) {
  $HasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
  if ((-not $OrigPluginsDir) -and $HasNode) {
    $LocalCli = if ($ScriptDir) { Join-Path $ScriptDir "sidecars\tree\cli.mjs" } else { "" }
    $InstalledCli = Join-Path $TargetDir "sidecars\tree\cli.mjs"
    $PrevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      if ($LocalCli -and (Test-Path $LocalCli)) {
        & node $LocalCli quit 1>$null
      } elseif (Test-Path $InstalledCli) {
        $StateDir = if ($env:AGY_FINDER_DATA_DIR) { $env:AGY_FINDER_DATA_DIR } elseif ($env:ANTIGRAVITY_EXECUTABLE_DATA_DIR) { $env:ANTIGRAVITY_EXECUTABLE_DATA_DIR } else { Join-Path $HOME ".gemini\antigravity\sidecar_data\agy-finder\tree\data" }
        $StatePath = Join-Path $StateDir "drawer_state.json"
        if (Test-Path $StatePath) {
          $StateObj = $null
          try { $StateObj = Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
          $DaemonPid = if ($StateObj -and $StateObj.pid) { [int]$StateObj.pid } else { 0 }
          if ($DaemonPid -gt 1) {
            $LiveProc = Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue
            if (-not $LiveProc) {
              Remove-Item -Force $StatePath -ErrorAction SilentlyContinue
            } elseif ($env:AGY_TEST_PID_IDENTITY_MODE -eq "unknown") {
              Write-Host "[WARN] [agy-finder] 无法核实后台进程身份（PID $DaemonPid），已跳过发送退出信号；请手动确认进程状态。" -ForegroundColor Yellow
            } else {
              $ProcInfo = $null
              try { $ProcInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $DaemonPid" -ErrorAction Stop } catch {}
              if ($null -eq $ProcInfo) {
                if (-not (Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue)) {
                  Remove-Item -Force $StatePath -ErrorAction SilentlyContinue
                } else {
                  Write-Host "[WARN] [agy-finder] 无法核实后台进程身份（PID $DaemonPid），已跳过发送退出信号；请手动确认进程状态。" -ForegroundColor Yellow
                }
              } else {
                $CmdNorm = ([string]$ProcInfo.CommandLine).Replace('\', '/')
                $ProcName = [string]$ProcInfo.Name
                $NameOk = (-not $ProcName) -or ($ProcName -match '^(node|electron|antigravity)(\.exe)?$')
                $IsDaemon = $NameOk -and $CmdNorm.Contains("sidecars/tree/drawer.mjs") -and ($CmdNorm -match '(?:^|\s)--daemon(?:\s|$)') -and ($CmdNorm -notmatch '(?:^|\s)(?:-e|--eval|--print|-p)(?:=|\s|$)')
                if ($IsDaemon) {
                  & node $InstalledCli quit 1>$null
                } else {
                  Remove-Item -Force $StatePath -ErrorAction SilentlyContinue
                }
              }
            }
          } else {
            Remove-Item -Force $StatePath -ErrorAction SilentlyContinue
          }
        }
      }
    } finally {
      $ErrorActionPreference = $PrevEap
    }
  }
  if ($ShouldManageBin -and (Test-Path $CliLoader)) {
    $ExpectedEntry = [System.IO.Path]::GetFullPath((Join-Path $TargetDir "sidecars\tree\cli.mjs"))
    $ExpectedB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($ExpectedEntry))
    $LoaderRaw = Get-Content $CliLoader -Raw -ErrorAction SilentlyContinue
    if ($LoaderRaw -and ($LoaderRaw.Contains($ExpectedB64) -or $LoaderRaw.Contains($TargetDir))) {
      Remove-Item -Force $CliLoader
      if ((Test-Path $CliWrapper) -and ((Get-Content $CliWrapper -Raw -ErrorAction SilentlyContinue) -match "agy-finder-loader\.mjs")) {
        Remove-Item -Force $CliWrapper
      }
    }
  }
  if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
    Write-Host "[agy-finder] 已卸载：$TargetDir"
  } else {
    Write-Host "[agy-finder] 未找到安装目录：$TargetDir"
  }
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "未检测到 Node.js，请先安装 Node.js 18 或更高版本。"
}
$NodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($NodeMajor -lt 18) {
  throw "当前 Node.js 主版本为 $NodeMajor，需要 Node.js >= 18。"
}

$TempDir = $null
try {
  if (-not $ScriptDir) {
    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-finder-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $ZipFile = Join-Path $TempDir "repo.zip"
    $ZipUrl = "https://codeload.github.com/$RepoSlug/zip/$GitRef"
    Write-Host "[agy-finder] 正在从 GitHub 下载 $RepoSlug ($GitRef)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipFile
    Expand-Archive -Path $ZipFile -DestinationPath $TempDir -Force
    $AllManifests = Get-ChildItem -Path $TempDir -Filter "plugin.json" -Recurse
    $FoundManifest = $AllManifests | Where-Object { $_.FullName -match "[\\/]plugins[\\/]agy-finder[\\/]plugin\.json$" } | Select-Object -First 1
    if (-not $FoundManifest) {
      $FoundManifest = $AllManifests | Where-Object { $_.FullName -match "[\\/]agy-finder[\\/]plugin\.json$" } | Select-Object -First 1
    }
    if (-not $FoundManifest) {
      $FoundManifest = $AllManifests | Select-Object -First 1
    }
    if (-not $FoundManifest) {
      throw "下载归档中未找到 plugins/agy-finder/plugin.json。"
    }
    $ScriptDir = $FoundManifest.Directory.FullName
  }

  $TreeFiles = @("package.json", "main.mjs", "path_utils.mjs", "mentions.mjs", "drawer.mjs", "cli.mjs", "native_drawer_macos.swift", "index.html", "styles.css", "app.js", "sidecar.json")
  foreach ($Req in @("plugin.json", "assets\logo.svg", "rules\AGENTS.md", "skills\agy-finder\SKILL.md")) {
    if (-not (Test-Path (Join-Path $ScriptDir $Req))) {
      throw "安装包缺少必需文件：$Req"
    }
  }
  foreach ($f in $TreeFiles) {
    if (-not (Test-Path (Join-Path $ScriptDir "sidecars\tree\$f"))) {
      throw "安装包缺少必需文件：sidecars\tree\$f"
    }
  }

  $NewCli = Join-Path $ScriptDir "sidecars\tree\cli.mjs"
  if ((-not $OrigPluginsDir) -and (Test-Path $TargetDir) -and (Test-Path $NewCli)) {
    $PrevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try { & node $NewCli quit 1>$null } catch {} finally { $ErrorActionPreference = $PrevEap }
  }

  $Dirs = @(
    $TargetDir,
    (Join-Path $TargetDir "assets"),
    (Join-Path $TargetDir "rules"),
    (Join-Path $TargetDir "skills\agy-finder"),
    (Join-Path $TargetDir "sidecars\tree")
  )
  foreach ($d in $Dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }

  Copy-Item -Force (Join-Path $ScriptDir "plugin.json") (Join-Path $TargetDir "plugin.json")
  foreach ($OptFile in @("README.md", "LICENSE")) {
    $OptPath = Join-Path $ScriptDir $OptFile
    if (Test-Path $OptPath) { Copy-Item -Force $OptPath (Join-Path $TargetDir $OptFile) }
  }
  Copy-Item -Force (Join-Path $ScriptDir "assets\logo.svg") (Join-Path $TargetDir "assets\logo.svg")
  Copy-Item -Force (Join-Path $ScriptDir "rules\AGENTS.md") (Join-Path $TargetDir "rules\AGENTS.md")
  Copy-Item -Force (Join-Path $ScriptDir "skills\agy-finder\SKILL.md") (Join-Path $TargetDir "skills\agy-finder\SKILL.md")

  foreach ($f in @("package.json", "main.mjs", "path_utils.mjs", "mentions.mjs", "drawer.mjs", "cli.mjs", "native_drawer_macos.swift", "index.html", "styles.css", "app.js")) {
    Copy-Item -Force (Join-Path $ScriptDir "sidecars\tree\$f") (Join-Path $TargetDir "sidecars\tree\$f")
  }

  $TmpSidecar = Join-Path $TargetDir "sidecars\tree\.sidecar.json.tmp"
  Copy-Item -Force (Join-Path $ScriptDir "sidecars\tree\sidecar.json") $TmpSidecar
  Move-Item -Force $TmpSidecar (Join-Path $TargetDir "sidecars\tree\sidecar.json")

  if ($ShouldManageBin) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $CliEntry = [System.IO.Path]::GetFullPath((Join-Path $TargetDir "sidecars\tree\cli.mjs"))
    $CliEntryB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($CliEntry))
    $LoaderContent = @(
      "import { pathToFileURL } from 'node:url';",
      "const entry = Buffer.from('$CliEntryB64', 'base64').toString('utf8');",
      "process.argv[1] = entry;",
      "await import(pathToFileURL(entry).href);"
    ) -join "`n"
    $CmdContent = "@echo off`r`nnode `"%~dp0agy-finder-loader.mjs`" %*`r`n"
    [System.IO.File]::WriteAllText($CliLoader, "$LoaderContent`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($CliWrapper, $CmdContent, [System.Text.Encoding]::ASCII)
  }

  if ((-not $OrigPluginsDir) -and (Get-Command agy -ErrorAction SilentlyContinue)) {
    try { & agy plugin enable agy-finder 2>&1 | Out-Null } catch {}
  }

  Write-Host "[agy-finder] 安装完成：$TargetDir"
  Write-Host "插件已自动加载并启用（可在 Customizations -> Installed 管理）：可运行 agy-finder（独立抽屉）或 agy-finder aux（AGY 侧栏目录树），也可绑定 Ctrl+Shift+E / Ctrl+Alt+E。"

  $BatchList = @()
  if ($env:AGY_INSTALL_BATCH) {
    $BatchList = $env:AGY_INSTALL_BATCH.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  }
  $PeerManifest = Join-Path $PluginsDir "context-viewer\plugin.json"
  if ((-not ($BatchList -contains "agy-context-viewer")) -and (-not ($BatchList -contains "context-viewer")) -and (Test-Path $PeerManifest)) {
    try {
      $PeerVerRaw = [string]((Get-Content $PeerManifest -Raw -Encoding UTF8 | ConvertFrom-Json).version)
      if ($PeerVerRaw -match '^v?(\d+)\.(\d+)\.(\d+)') {
        $PV = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
        if ($PV -lt [version]::new(1, 7, 4)) {
          Write-Host "[WARN] [agy-finder] 检测到同机已安装的 context-viewer 版本为 v$($PeerVerRaw.TrimStart('v'))（低于共享触发锁协议所需的 v1.7.4）。请同步升级 context-viewer（例如在总仓运行 .\install.ps1）并重载宿主或重启旧后台实例，以避免旧版锁回收竞争。" -ForegroundColor Yellow
        }
      }
    } catch {}
  }
} finally {
  if ($TempDir -and (Test-Path $TempDir)) {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
  }
}
