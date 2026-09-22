$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/1GNTV/chat-on-steroids-plus.git"
$InstallDir = if ($env:COS_PLUS_HOME) { $env:COS_PLUS_HOME } else { Join-Path $HOME ".chat-on-steroids-plus" }

function Require-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing dependency: $Name"
    }
}

Require-Command git
Require-Command node
Require-Command npm

$NodeMajor = [int](node -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 20) {
    throw "Node.js 20 or newer is required (found $(node -v))."
}

if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "[cos-plus] Updating $InstallDir"
    git -C $InstallDir fetch --depth 1 origin main
    git -C $InstallDir checkout -q main
    git -C $InstallDir reset --hard origin/main
} elseif (Test-Path $InstallDir) {
    throw "$InstallDir already exists and is not a git checkout."
} else {
    Write-Host "[cos-plus] Downloading Chat On Steroids Plus"
    git clone --depth 1 $RepoUrl $InstallDir
}

Write-Host "[cos-plus] Installing the lightweight host CLI"
$Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($Npm) {
    & $Npm.Source install --global (Join-Path $InstallDir "agent-bridge")
} else {
    npm install --global (Join-Path $InstallDir "agent-bridge")
}

cos-plus --help | Out-Null

Write-Host ""
Write-Host "COS+ installed successfully."
Write-Host ""
Write-Host "Open your project and run:"
Write-Host "  cos-plus start ."
Write-Host ""
Write-Host "COS+ will print one command to paste into ChatGPT."
