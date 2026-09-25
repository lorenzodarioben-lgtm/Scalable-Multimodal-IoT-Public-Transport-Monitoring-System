<# One guarded HD matched run. Never auto-reruns a prior attempt. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('ramp', 'burst')][string]$Profile,
    [Parameter(Mandatory)][ValidateSet('reactive', 'hybrid')][string]$Arm,
    [Parameter(Mandatory)][ValidateRange(1,3)][int]$Repeat,
    [Parameter(Mandatory)][string]$CodeBucket,
    [Parameter(Mandatory)][string]$ExistingLambdaRoleArn,
    [switch]$ExecuteHdRun,
    [switch]$AllowReviewedReplacement,
    [string]$Region = 'us-east-1'
)
$ErrorActionPreference = 'Stop'
if (-not $ExecuteHdRun) { throw 'Live HD run requires -ExecuteHdRun.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$profileFile = if ($Profile -eq 'ramp') { 'experiments/hd/aws-ramp.json' } else { 'experiments/hd/aws-sudden-burst.json' }
$profileName = if ($Profile -eq 'ramp') { 'hd-predictable-ramp' } else { 'hd-sudden-burst' }
$runRoot = Join-Path $repoRoot 'artifacts/hd-aws-runs'
if (Test-Path -LiteralPath $runRoot) {
    foreach ($directory in Get-ChildItem -LiteralPath $runRoot -Directory) {
        $manifestFile = Join-Path $directory.FullName 'manifest.json'
        if (-not (Test-Path -LiteralPath $manifestFile)) { continue }
        $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
        if ($manifest.workload.stage -eq $profileName -and $manifest.arm -eq $Arm -and
            $manifest.repeatNumber -eq $Repeat) {
            if (-not $AllowReviewedReplacement) {
                throw "An artifact already exists for $Profile/$Arm/r$Repeat. Review it; no automatic rerun."
            }
            $reviewFile = Join-Path $directory.FullName 'review.json'
            if (-not (Test-Path -LiteralPath $reviewFile)) {
                throw 'Replacement requires an explicit INVALID review for the existing attempt.'
            }
            $review = Get-Content -LiteralPath $reviewFile -Raw | ConvertFrom-Json
            # ConvertFrom-Json turns ISO timestamps into DateTime values. Do not
            # stringify and reparse them under the host's potentially different
            # culture (for example en-ID versus the formatted MM/dd/yyyy text).
            if ($review.reviewedAt -is [datetime]) {
                $validReviewAt = $review.reviewedAt -gt [datetime]::MinValue
            }
            else {
                $parsedReviewAt = [datetimeoffset]::MinValue
                $validReviewAt = [datetimeoffset]::TryParse(
                    [string]$review.reviewedAt,
                    [System.Globalization.CultureInfo]::InvariantCulture,
                    [System.Globalization.DateTimeStyles]::RoundtripKind,
                    [ref]$parsedReviewAt)
            }
            if ($review.runId -ne $manifest.runId -or $review.status -ne 'INVALID' -or
                [string]::IsNullOrWhiteSpace($review.basis) -or $review.basis.Length -lt 15 -or
                -not $validReviewAt) {
                throw 'An existing potentially valid run cannot be replaced.'
            }
        }
    }
}
$env:AWS_PROFILE = 'academy'
$env:AWS_REGION = $Region
& (Join-Path $PSScriptRoot 'set-hd-mode.ps1') -Mode $Arm -CodeBucket $CodeBucket `
    -ExistingLambdaRoleArn $ExistingLambdaRoleArn -ExecuteHdModeChange -Region $Region
if ($LASTEXITCODE -ne 0) { throw 'HD mode preparation failed.' }
Push-Location $repoRoot
try {
    node experiments/hd/aws/run-hd-aws-experiment.js --execute-hd-aws --config $profileFile `
        --arm $Arm --repeat $Repeat --prefix sit314-hd-transport --region $Region
    if ($LASTEXITCODE -ne 0) { throw 'HD run stopped; retain and review the artifact before any replacement.' }
}
finally { Pop-Location }
