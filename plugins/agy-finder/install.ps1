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

if ($Uninstall) {
  if ((-not $OrigPluginsDir) -and (Test-Path (Join-Path $TargetDir "sidecars\tree\cli.mjs")) -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try { & node (Join-Path $TargetDir "sidecars\tree\cli.mjs") quit 2>&1 | Out-Null } catch {}
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

$ScriptDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "plugin.json")) -and (Test-Path (Join-Path $PSScriptRoot "sidecars\tree"))) {
  $ScriptDir = $PSScriptRoot
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
} finally {
  if ($TempDir -and (Test-Path $TempDir)) {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
  }
}
