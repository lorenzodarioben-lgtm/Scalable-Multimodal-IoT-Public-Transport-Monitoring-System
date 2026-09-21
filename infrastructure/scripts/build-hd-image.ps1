<# Explicitly gated HD-only ECR build/push. No call occurs without the switch. #>
[CmdletBinding()]
param(
    [switch]$ExecuteHdImagePush,
    [ValidateSet('route-impact-worker', 'notification-worker')][string]$Service = 'route-impact-worker',
    [string]$Region = 'us-east-1',
    [string]$Tag = 'hd-frozen'
)
$ErrorActionPreference = 'Stop'
if (-not $ExecuteHdImagePush) { throw 'HD ECR push requires -ExecuteHdImagePush.' }
if ($Tag -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$') { throw 'Invalid HD image tag.' }
& (Join-Path $PSScriptRoot 'build-and-push.ps1') -Services @($Service) `
    -Prefix 'sit314-hd-transport' -Region $Region -Tag $Tag
if ($LASTEXITCODE -ne 0) { throw 'HD ECR build/push failed.' }
