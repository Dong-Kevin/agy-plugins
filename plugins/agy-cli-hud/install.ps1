<#
.SYNOPSIS
  One-click Installer / Updater / Uninstaller for AGY CLI HUD (Windows PowerShell)

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -Uninstall
#>

param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$OrigPluginsDir = if ($env:AGY_PLUGINS_DIR) { $env:AGY_PLUGINS_DIR } elseif ($env:ANTIGRAVITY_PLUGINS_DIR) { $env:ANTIGRAVITY_PLUGINS_DIR } else { "" }
$PluginsDir = if ($OrigPluginsDir) { $OrigPluginsDir } else { Join-Path $HOME ".gemini\config\plugins" }
$TargetDir = Join-Path $PluginsDir "agy-cli-hud"
$OrigBinDir = if ($env:AGY_BIN_DIR) { $env:AGY_BIN_DIR } elseif ($env:ANTIGRAVITY_BIN_DIR) { $env:ANTIGRAVITY_BIN_DIR } else { "" }
$BinDir = if ($OrigBinDir) { $OrigBinDir } else { Join-Path $HOME ".local\bin" }
$ShouldManageBin = [bool]($OrigBinDir -or (-not $OrigPluginsDir))
$CliWrapper = Join-Path $BinDir "agy-hud.cmd"
$CliLoader = Join-Path $BinDir "agy-hud-loader.mjs"
$RepoSlug = if ($env:REPO) { $env:REPO } else { "Dong-Kevin/agy-plugins" }
$GitRef = if ($env:REF) { $env:REF } else { "main" }

$ScriptDir = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "plugin.json")) -and (Test-Path (Join-Path $PSScriptRoot "bin\agy-hud.mjs"))) {
  $ScriptDir = $PSScriptRoot
}

if ($Uninstall) {
  $HasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
  if ((-not $OrigPluginsDir) -and $HasNode) {
    $VerifyJs = @'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const dataDir = process.env.AGY_HUD_DATA_DIR || path.join(os.homedir(), ".gemini", "antigravity-cli", "cache", "agy-cli-hud");
const sniperPath = path.join(dataDir, "colab", "sniper_state.v1.json");
if (!fs.existsSync(sniperPath)) process.exit(0);
try {
  const st = JSON.parse(fs.readFileSync(sniperPath, "utf8"));
  const pid = Number(st && st.pid);
  if (st && st.active && Number.isInteger(pid) && pid > 1) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
} catch {}
'@
    try { & node -e $VerifyJs } catch {}
  }
  if ($ShouldManageBin -and (Test-Path $CliLoader)) {
    $ExpectedEntry = [System.IO.Path]::GetFullPath((Join-Path $TargetDir "bin\agy-hud.mjs"))
    $ExpectedB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($ExpectedEntry))
    $LoaderRaw = Get-Content $CliLoader -Raw -ErrorAction SilentlyContinue
    if ($LoaderRaw -and ($LoaderRaw.Contains($ExpectedB64) -or $LoaderRaw.Contains($TargetDir))) {
      Remove-Item -Force $CliLoader
      if ((Test-Path $CliWrapper) -and ((Get-Content $CliWrapper -Raw -ErrorAction SilentlyContinue) -match "agy-hud-loader\.mjs")) {
        Remove-Item -Force $CliWrapper
      }
    }
  }
  if (Test-Path $TargetDir) {
    Remove-Item -Recurse -Force $TargetDir
    Write-Host "[agy-cli-hud] 已卸载：$TargetDir"
  } else {
    Write-Host "[agy-cli-hud] 未找到安装目录：$TargetDir"
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
    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-cli-hud-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $ZipFile = Join-Path $TempDir "repo.zip"
    $ZipUrl = "https://codeload.github.com/$RepoSlug/zip/$GitRef"
    Write-Host "[agy-cli-hud] 正在从 GitHub 下载 $RepoSlug ($GitRef)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipFile
    Expand-Archive -Path $ZipFile -DestinationPath $TempDir -Force
    $FoundManifest = Get-ChildItem -Path $TempDir -Filter "plugin.json" -Recurse |
      Where-Object { $_.FullName -match "[\\/]plugins[\\/]agy-cli-hud[\\/]plugin\.json$" } |
      Select-Object -First 1
    if (-not $FoundManifest) {
      throw "下载归档中未找到 plugins/agy-cli-hud/plugin.json。"
    }
    $ScriptDir = $FoundManifest.Directory.FullName
  }

  $LibFiles = @("paths.mjs", "pricing.mjs", "quota.mjs", "incremental.mjs", "sqlite_timing.mjs", "colab.mjs", "snapshot.mjs", "themes.mjs", "statusline.mjs")
  foreach ($Req in @("plugin.json", "package.json", "assets\logo.svg", "bin\agy-hud.mjs", "skills\agy-cli-hud\SKILL.md")) {
    if (-not (Test-Path (Join-Path $ScriptDir $Req))) {
      throw "安装包缺少必需文件：$Req"
    }
  }
  foreach ($f in $LibFiles) {
    if (-not (Test-Path (Join-Path $ScriptDir "lib\$f"))) {
      throw "安装包缺少必需文件：lib\$f"
    }
  }

  $Dirs = @(
    $TargetDir,
    (Join-Path $TargetDir "assets"),
    (Join-Path $TargetDir "bin"),
    (Join-Path $TargetDir "lib"),
    (Join-Path $TargetDir "skills\agy-cli-hud")
  )
  foreach ($d in $Dirs) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
  }

  Copy-Item -Force (Join-Path $ScriptDir "package.json") (Join-Path $TargetDir "package.json")
  foreach ($OptFile in @("README.md", "README_EN.md", "LICENSE")) {
    $OptPath = Join-Path $ScriptDir $OptFile
    if (Test-Path $OptPath) { Copy-Item -Force $OptPath (Join-Path $TargetDir $OptFile) }
  }
  Copy-Item -Force (Join-Path $ScriptDir "assets\logo.svg") (Join-Path $TargetDir "assets\logo.svg")
  Copy-Item -Force (Join-Path $ScriptDir "skills\agy-cli-hud\SKILL.md") (Join-Path $TargetDir "skills\agy-cli-hud\SKILL.md")
  Copy-Item -Force (Join-Path $ScriptDir "bin\agy-hud.mjs") (Join-Path $TargetDir "bin\agy-hud.mjs")
  foreach ($f in $LibFiles) {
    Copy-Item -Force (Join-Path $ScriptDir "lib\$f") (Join-Path $TargetDir "lib\$f")
  }

  $TmpManifest = Join-Path $TargetDir ".plugin.json.tmp"
  Copy-Item -Force (Join-Path $ScriptDir "plugin.json") $TmpManifest
  Move-Item -Force $TmpManifest (Join-Path $TargetDir "plugin.json")

  if ($ShouldManageBin) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $CliEntry = [System.IO.Path]::GetFullPath((Join-Path $TargetDir "bin\agy-hud.mjs"))
    $CliEntryB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($CliEntry))
    $LoaderContent = @(
      "import { pathToFileURL } from 'node:url';",
      "const entry = Buffer.from('$CliEntryB64', 'base64').toString('utf8');",
      "process.argv[1] = entry;",
      "await import(pathToFileURL(entry).href);"
    ) -join "`n"
    $CmdContent = "@echo off`r`nnode `"%~dp0agy-hud-loader.mjs`" %*`r`n"
    [System.IO.File]::WriteAllText($CliLoader, "$LoaderContent`n", [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($CliWrapper, $CmdContent, [System.Text.Encoding]::ASCII)
  }

  if ((-not $OrigPluginsDir) -and (Get-Command agy -ErrorAction SilentlyContinue)) {
    try { & agy plugin enable agy-cli-hud 2>&1 | Out-Null } catch {}
  }

  Write-Host "[agy-cli-hud] 安装完成：$TargetDir"
} finally {
  if ($TempDir -and (Test-Path $TempDir)) {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
  }
}
