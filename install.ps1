<#
.SYNOPSIS
  Unified Installer / Updater / Uninstaller for Dong-Kevin/agy-plugins (Windows PowerShell)

.EXAMPLE
  .\install.ps1
.EXAMPLE
  .\install.ps1 -Plugin agy-finder
.EXAMPLE
  .\install.ps1 -List
.EXAMPLE
  irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex
.EXAMPLE
  $env:AGY_PLUGIN="agy-finder"; irm https://raw.githubusercontent.com/Dong-Kevin/agy-plugins/main/install.ps1 | iex
#>

param(
  [string[]]$Plugin = @(),
  [switch]$All,
  [switch]$Uninstall,
  [switch]$List
)

$ErrorActionPreference = "Stop"

$RepoSlug = if ($env:REPO) { $env:REPO } else { "Dong-Kevin/agy-plugins" }
$GitRef = if ($env:REF) { $env:REF } else { "main" }

if ($Plugin.Count -eq 0 -and $env:AGY_PLUGIN) {
  $Plugin = $env:AGY_PLUGIN.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
}

$ScriptRoot = $null
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "plugins"))) {
  $ScriptRoot = $PSScriptRoot
}

$TempDir = $null
try {
  if (-not $ScriptRoot) {
    $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("agy-plugins-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $TempDir | Out-Null
    $ZipFile = Join-Path $TempDir "repo.zip"
    $ZipUrl = "https://codeload.github.com/$RepoSlug/zip/$GitRef"
    Write-Host "[agy-plugins] 正在从 GitHub 下载 $RepoSlug ($GitRef)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipFile
    Expand-Archive -Path $ZipFile -DestinationPath $TempDir -Force
    $PluginsDirObj = Get-ChildItem -Path $TempDir -Directory -Recurse | Where-Object { $_.Name -eq "plugins" } | Select-Object -First 1
    if (-not $PluginsDirObj) {
      throw "下载归档中未找到 plugins/ 目录。"
    }
    $ScriptRoot = $PluginsDirObj.Parent.FullName
  }

  $PluginsRoot = Join-Path $ScriptRoot "plugins"
  $Catalog = @()
  foreach ($Dir in (Get-ChildItem -Path $PluginsRoot -Directory | Sort-Object Name)) {
    $ManifestPath = Join-Path $Dir.FullName "plugin.json"
    $InstallerPath = Join-Path $Dir.FullName "install.ps1"
    if ((Test-Path $ManifestPath) -and (Test-Path $InstallerPath)) {
      $Manifest = Get-Content $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $Catalog += [PSCustomObject]@{
        DirName     = $Dir.Name
        Name        = if ($Manifest.name) { [string]$Manifest.name } else { $Dir.Name }
        Version     = if ($Manifest.version) { [string]$Manifest.version } else { "0.0.0" }
        DisplayName = if ($Manifest.displayName) { [string]$Manifest.displayName } else { $Dir.Name }
        Installer   = $InstallerPath
      }
    }
  }

  if ($Catalog.Count -eq 0) {
    throw "plugins/ 下未发现可安装插件。"
  }

  if ($List) {
    Write-Host "可用插件列表："
    foreach ($Item in $Catalog) {
      Write-Host ("  - {0,-20} (name: {1,-16} v{2,-8}) {3}" -f $Item.DirName, $Item.Name, $Item.Version, $Item.DisplayName)
    }
    exit 0
  }

  $Selected = @()
  if ($All -or $Plugin.Count -eq 0) {
    $Selected = $Catalog
  } else {
    foreach ($Target in $Plugin) {
      $Match = $Catalog | Where-Object { $_.DirName -eq $Target -or $_.Name -eq $Target } | Select-Object -First 1
      if (-not $Match) {
        throw "未找到插件：$Target（可传入 -List 查看可用列表）"
      }
      if (-not ($Selected | Where-Object { $_.DirName -eq $Match.DirName })) {
        $Selected += $Match
      }
    }
  }

  foreach ($Item in $Selected) {
    Write-Host ""
    Write-Host "=== [agy-plugins] 处理插件：$($Item.DirName) ===" -ForegroundColor Cyan
    if ($Uninstall) {
      & $Item.Installer -Uninstall
    } else {
      & $Item.Installer
    }
  }
} finally {
  if ($TempDir -and (Test-Path $TempDir)) {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
  }
}
