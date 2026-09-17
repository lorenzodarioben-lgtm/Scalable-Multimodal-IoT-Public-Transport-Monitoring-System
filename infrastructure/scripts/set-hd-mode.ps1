<# Between-run HD-only Lambda mode change. Never invoke during active workload. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('reactive', 'hybrid')][string]$Mode,
    [Parameter(Mandatory)][string]$CodeBucket,
    [Parameter(Mandatory)][string]$ExistingLambdaRoleArn,
    [switch]$ExecuteHdModeChange,
    [string]$Region = 'us-east-1'
)
$ErrorActionPreference = 'Stop'
if (-not $ExecuteHdModeChange) { throw 'HD controller mode change requires -ExecuteHdModeChange.' }
$hdPrefix = 'sit314-hd-transport'
if ($CodeBucket -notmatch ('^' + [regex]::Escape($hdPrefix) + '-[0-9]{12}-[a-z0-9-]+-code$')) {
    throw 'HD code bucket must have the isolated HD prefix, account, and region.'
}
if ($ExistingLambdaRoleArn -notmatch '^arn:aws[a-zA-Z-]*:iam::[0-9]{12}:role/.+$') {
    throw 'A verified existing Lambda role ARN is required.'
}
$template = Join-Path $PSScriptRoot '../cloudformation/hd-predictor.yaml'
$stack = "$hdPrefix-hd-predictor"
$overrides = @(
    "ResourcePrefix=$hdPrefix",
    "SignalsStackName=$hdPrefix-hd-signals",
    "QueuesStackName=$hdPrefix-queues",
    "EcsStackName=$hdPrefix-ecs",
    "ControllerMode=$Mode",
    "LambdaCodeBucket=$CodeBucket",
    'LambdaCodeKey=hd-predictor.zip',
    "ExistingLambdaRoleArn=$ExistingLambdaRoleArn"
)
aws cloudformation deploy --region $Region --stack-name $stack --template-file $template `
    --parameter-overrides $overrides --capabilities CAPABILITY_NAMED_IAM
if ($LASTEXITCODE -ne 0) { throw 'HD predictor stack update failed.' }
for ($attempt = 0; $attempt -lt 24; $attempt++) {
    $status = aws lambda get-function-configuration --region $Region `
        --function-name "$hdPrefix-predictor" `
        --query '[Environment.Variables.HD_CONTROLLER_MODE,LastUpdateStatus]' --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Unable to verify HD predictor Lambda mode.' }
    if ($status[0] -eq $Mode -and $status[1] -eq 'Successful') {
        Write-Output "HD controller mode verified: $Mode"
        return
    }
    Start-Sleep -Seconds 5
}
throw 'HD Lambda controller mode did not become ready.'
