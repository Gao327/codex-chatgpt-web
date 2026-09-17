$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Invoke-WithRetry {
  param(
    [Parameter(Mandatory = $true)][scriptblock]$Operation,
    [Parameter(Mandatory = $true)][string]$Label
  )
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try {
      return & $Operation
    } catch {
      if ($Attempt -eq 3) {
        throw "$Label failed after $Attempt attempts: $($_.Exception.Message)"
      }
      Start-Sleep -Seconds (2 * $Attempt)
    }
  }
}

function Test-IsFullyQualifiedWindowsPath {
  param([AllowEmptyString()][string]$Path)
  return $Path -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))'
}

function Invoke-ForkDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$OutFile,
    [int]$TimeoutSec = 60,
    [switch]$Asset
  )
  $CurrentUrl = $Url
  for ($Hop = 0; $Hop -le 1; $Hop++) {
    # HttpWebRequest also supports Windows PowerShell 5.1. Redirects are checked
    # before issuing another request, including redirects after a repository move.
    $Request = [System.Net.HttpWebRequest]::Create($CurrentUrl)
    $Request.AllowAutoRedirect = $false
    $Request.Timeout = $TimeoutSec * 1000
    $Request.ReadWriteTimeout = $TimeoutSec * 1000
    $Request.UserAgent = "codex-web-gpt-fork-installer"
    $Response = $Request.GetResponse()
    try {
      $Status = [int]$Response.StatusCode
      if ($Status -eq 200) {
        $Stream = $Response.GetResponseStream()
        try {
          if ($OutFile) {
            $File = [System.IO.File]::Create($OutFile)
            try { $Stream.CopyTo($File) } finally { $File.Dispose() }
            return
          }
          $Reader = New-Object System.IO.StreamReader($Stream)
          try { return $Reader.ReadToEnd() } finally { $Reader.Dispose() }
        } finally { $Stream.Dispose() }
      }
      if ($Asset -and $Hop -eq 0 -and $Status -in @(301, 302, 303, 307, 308)) {
        $Location = [string]$Response.Headers["Location"]
        if ($Location -cnotmatch '^https://release-assets\.githubusercontent\.com/github-production-release-asset/1357573628/[A-Za-z0-9_-]+(?:\?[^\s#]*)?$') {
          throw "Refusing a release redirect outside Gao327/codex-chatgpt-web"
        }
        $CurrentUrl = $Location
        continue
      }
      throw "Fork download failed with HTTP $Status; repository and further redirects are forbidden"
    } finally { $Response.Dispose() }
  }
}

$Repository = "Gao327/codex-chatgpt-web"
if ($env:CODEX_WEB_GPT_REPOSITORY -and $env:CODEX_WEB_GPT_REPOSITORY -cne $Repository) {
  throw "Updates are locked to $Repository; repository overrides are forbidden"
}
$Version = $env:CODEX_WEB_GPT_VERSION
if (-not $Version) {
  $Release = Invoke-WithRetry -Label "Resolving the latest release" -Operation {
    Invoke-ForkDownload -Url "https://api.github.com/repos/$Repository/releases/latest" | ConvertFrom-Json
  }
  $Version = [string]$Release.tag_name
}
if ($Version -and $Version.StartsWith("v")) { $Version = $Version.Substring(1) }
if (-not $Version) { throw "Could not resolve the latest Codex Web GPT release" }
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "Invalid release version: $Version" }

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The packaged Windows launcher requires 64-bit Windows"
}
$Arch = "x64"

$Asset = "codex-web-gpt-$Version-win-$Arch.exe"
$BaseUrl = "https://github.com/$Repository/releases/download/v$Version"
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) "codex-web-gpt-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
  if (Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue) {
    throw "Quit Codex Web GPT before updating it"
  }
  $Installer = Join-Path $Temp $Asset
  $Checksums = Join-Path $Temp "checksums.txt"
  $null = Invoke-WithRetry -Label "Downloading $Asset" -Operation {
    Remove-Item $Installer -Force -ErrorAction SilentlyContinue
    Invoke-ForkDownload -Url "$BaseUrl/$Asset" -OutFile $Installer -TimeoutSec 900 -Asset
  }
  $null = Invoke-WithRetry -Label "Downloading checksums.txt" -Operation {
    Remove-Item $Checksums -Force -ErrorAction SilentlyContinue
    Invoke-ForkDownload -Url "$BaseUrl/checksums.txt" -OutFile $Checksums -TimeoutSec 60 -Asset
  }
  $ExpectedLine = Get-Content $Checksums | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" } | Select-Object -First 1
  if (-not $ExpectedLine) { throw "checksums.txt has no entry for $Asset" }
  $Expected = ($ExpectedLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Installer).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw "SHA-256 verification failed for $Asset" }
  $Process = Start-Process -FilePath $Installer -ArgumentList "/S", "/currentuser" -Wait -PassThru
  if ($Process.ExitCode -ne 0) { throw "Installer exited with code $($Process.ExitCode)" }
  $InstallRegistry = "HKCU:\Software\d1a6026a-6210-588e-9a2b-da3936f94e02"
  $InstallLocation = [string](Get-ItemPropertyValue -LiteralPath $InstallRegistry -Name "InstallLocation")
  if (-not (Test-IsFullyQualifiedWindowsPath $InstallLocation)) {
    throw "Installer recorded an invalid InstallLocation: $InstallLocation"
  }
  $Executable = Join-Path $InstallLocation "Codex Web GPT.exe"
  if (-not (Test-Path $Executable)) { throw "Installed launcher was not found at $Executable" }
  Start-Process $Executable
  Write-Host "Installed $Executable"
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
