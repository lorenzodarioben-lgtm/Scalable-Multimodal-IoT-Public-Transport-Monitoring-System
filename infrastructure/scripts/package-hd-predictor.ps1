<# Packages only the local HD Lambda sources. Makes no AWS or network call. #>
[CmdletBinding()]
param([string]$OutputPath = '')
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
if (-not $OutputPath) { $OutputPath = Join-Path $repoRoot 'artifacts/hd-predictor.zip' }
$outputFull = [System.IO.Path]::GetFullPath($OutputPath)
$outputDir = [System.IO.Path]::GetDirectoryName($outputFull)
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stage = Join-Path $tempRoot ('sit314-hd-pack-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'experiments/hd/aws') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'shared/hd') | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination (Join-Path $stage 'package.json')
    Copy-Item -Path (Join-Path $repoRoot 'experiments/hd/aws/*.js') -Destination (Join-Path $stage 'experiments/hd/aws')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'experiments/hd/predictive-controller.js') -Destination (Join-Path $stage 'experiments/hd/predictive-controller.js')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'shared/hd/arrival-signal.js') -Destination (Join-Path $stage 'shared/hd/arrival-signal.js')
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $outputFull -Force
    Add-Type -AssemblyName System.IO.Compression
    $archive = [System.IO.Compression.ZipFile]::OpenRead($outputFull)
    try {
        $names = @($archive.Entries | ForEach-Object FullName)
        foreach ($expected in @('package.json', 'experiments/hd/aws/handler.js', 'experiments/hd/aws/ports.js', 'experiments/hd/aws/signal-processor.js', 'experiments/hd/predictive-controller.js', 'shared/hd/arrival-signal.js')) {
            if ($names -notcontains $expected) { throw "Lambda package missing $expected" }
        }
    }
    finally { $archive.Dispose() }
    Write-Output "LOCAL PACKAGE ONLY: $outputFull"
}
finally {
    $resolvedStage = [System.IO.Path]::GetFullPath($stage)
    if ($resolvedStage.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($resolvedStage).StartsWith('sit314-hd-pack-')) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
