# UnitHarness installer (Windows)
#   irm https://raw.githubusercontent.com/create-info/unit-harness/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = "create-info/unit-harness"
$BinDir = if ($env:UH_INSTALL_DIR) { $env:UH_INSTALL_DIR } else { "$env:LOCALAPPDATA\UnitHarness\bin" }

if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { $Arch = "arm64" } else { $Arch = "x64" }
$Name = "uh-win32-$Arch.exe"
$Url = "https://github.com/$Repo/releases/latest/download/$Name"

Write-Host "-> downloading $Name"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Target = Join-Path $BinDir "uh.exe"

try {
    Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing
} catch {
    Write-Error "download failed: $Url`nNo release yet? Build from source: git clone, then 'npm i -g .'"
    exit 1
}

Write-Host "-> installed $Target"
& $Target --version

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
    Write-Host "added $BinDir to your user PATH (restart the terminal)"
}
