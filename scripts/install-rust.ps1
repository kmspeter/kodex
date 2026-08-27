$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolsRoot = Join-Path $repositoryRoot '.tools'
$cargoHome = Join-Path $toolsRoot 'cargo'
$rustupHome = Join-Path $toolsRoot 'rustup'
$installer = Join-Path $toolsRoot 'rustup-init.exe'
$toolchainFile = Join-Path $repositoryRoot 'vendor\openai-codex\codex-rs\rust-toolchain.toml'

if (-not (Test-Path -LiteralPath $toolchainFile)) {
  throw "Official Codex toolchain file is missing at $toolchainFile"
}

New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
if (-not (Test-Path -LiteralPath $installer)) {
  Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile $installer
}

$env:CARGO_HOME = $cargoHome
$env:RUSTUP_HOME = $rustupHome
& $installer -y --no-modify-path --profile minimal --default-toolchain none
if ($LASTEXITCODE -ne 0) { throw "rustup-init failed with exit code $LASTEXITCODE" }

$cargoBin = Join-Path $cargoHome 'bin'
$env:PATH = "$cargoBin;$env:PATH"
Push-Location (Join-Path $repositoryRoot 'vendor\openai-codex\codex-rs')
try {
  & rustup show active-toolchain
  if ($LASTEXITCODE -ne 0) { throw "The pinned Codex Rust toolchain could not be installed." }
} finally {
  Pop-Location
}

Write-Host "Repository-local Rust installed under $toolsRoot"
