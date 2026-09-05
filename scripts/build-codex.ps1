$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path $repositoryRoot 'vendor\openai-codex'
$manifest = Join-Path $sourceRoot 'codex-rs\Cargo.toml'
$commitFile = Join-Path $repositoryRoot 'CODEX_UPSTREAM_COMMIT'
$sourceManifest = Join-Path $repositoryRoot 'VENDOR_SOURCE_SHA256.json'
$cargoLock = Join-Path $sourceRoot 'codex-rs\Cargo.lock'
$targetRoot = Join-Path $repositoryRoot '.codex-build\target'
$temporaryRoot = Join-Path $repositoryRoot '.codex-build\tmp'
$binRoot = Join-Path $repositoryRoot 'bin'
$binaryName = if ($IsWindows -or $env:OS -eq 'Windows_NT') { 'codex.exe' } else { 'codex' }
$builtBinary = Join-Path $targetRoot "release\$binaryName"
$destination = Join-Path $binRoot $binaryName
$localCargoHome = Join-Path $repositoryRoot '.tools\cargo'
$localRustupHome = Join-Path $repositoryRoot '.tools\rustup'
$localCargoBin = Join-Path $localCargoHome 'bin'

if (Test-Path -LiteralPath (Join-Path $localCargoBin 'cargo.exe')) {
  $env:CARGO_HOME = $localCargoHome
  $env:RUSTUP_HOME = $localRustupHome
  $env:PATH = "$localCargoBin;$env:PATH"
}

if (-not (Get-Command link.exe -ErrorAction SilentlyContinue) -and ($IsWindows -or $env:OS -eq 'Windows_NT')) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path -LiteralPath $vswhere) {
    $vsRoot = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
    $vsDevCmd = if ($vsRoot) { Join-Path $vsRoot 'Common7\Tools\VsDevCmd.bat' } else { '' }
    if ($vsDevCmd -and (Test-Path -LiteralPath $vsDevCmd)) {
      $environmentLines = & cmd.exe /d /s /c "`"$vsDevCmd`" -no_logo -arch=amd64 -host_arch=amd64 >nul && set"
      foreach ($line in $environmentLines) {
        $separator = $line.IndexOf('=')
        if ($separator -gt 0) {
          [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), 'Process')
        }
      }
    }
  }
}

if (-not (Test-Path -LiteralPath $manifest)) {
  throw "Official Codex source is missing at $sourceRoot"
}
$expectedCommit = (Get-Content -LiteralPath $commitFile -Raw).Trim()
if (-not (Test-Path -LiteralPath $sourceManifest)) {
  throw "Vendored source SHA-256 manifest is missing at $sourceManifest"
}
& node (Join-Path $repositoryRoot 'scripts\vendor-manifest.mjs')
if ($LASTEXITCODE -ne 0) {
  throw 'Vendored Codex source integrity verification failed. Refusing to build.'
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  throw 'Rust/Cargo is not installed. Install the Rust toolchain declared by vendor/openai-codex/codex-rs/rust-toolchain.toml and rerun npm run codex:build.'
}
if (($IsWindows -or $env:OS -eq 'Windows_NT') -and -not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
  throw 'MSVC C++ Build Tools are required. Install Visual Studio Build Tools with the VCTools workload and rerun npm run codex:build.'
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
New-Item -ItemType Directory -Force -Path $temporaryRoot | Out-Null
New-Item -ItemType Directory -Force -Path $binRoot | Out-Null
$previousTarget = $env:CARGO_TARGET_DIR
$previousTemp = $env:TEMP
$previousTmp = $env:TMP
try {
  $env:CARGO_TARGET_DIR = $targetRoot
  $env:TEMP = $temporaryRoot
  $env:TMP = $temporaryRoot
  Push-Location (Split-Path -Parent $manifest)
  try {
    & cargo build --locked --release -p codex-cli --bin codex
    if ($LASTEXITCODE -ne 0) { throw "Cargo build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} finally {
  $env:CARGO_TARGET_DIR = $previousTarget
  $env:TEMP = $previousTemp
  $env:TMP = $previousTmp
}

Copy-Item -LiteralPath $builtBinary -Destination $destination -Force
$reportedVersion = (& $destination --version).Trim()
$sourceIdentity = "Codex source build $($expectedCommit.Substring(0, 12))"
$metadata = [ordered]@{
  formatVersion = 2
  upstream = 'https://github.com/openai/codex'
  commit = $expectedCommit
  kind = 'source-build'
  displayVersion = $sourceIdentity
  cliReportedVersion = $reportedVersion
  builtAt = [DateTime]::UtcNow.ToString('o')
  source = 'vendor/openai-codex'
  vendorManifestSha256 = (Get-FileHash -LiteralPath $sourceManifest -Algorithm SHA256).Hash.ToLowerInvariant()
  cargoLockSha256 = (Get-FileHash -LiteralPath $cargoLock -Algorithm SHA256).Hash.ToLowerInvariant()
  binarySha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $binRoot 'codex-build.json') -Encoding utf8
Write-Host "Built $destination"
Write-Host "$sourceIdentity (CLI reports: $reportedVersion)"
