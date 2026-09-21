<# Explicitly gated HD-only wrapper. DO NOT invoke until after the D video and fresh Academy preflight. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('queues', 'tables', 'ecs', 'scaling')][string]$Stage,
    [switch]$ExecuteHdDeployment,
    [string]$Region = 'us-east-1',
    [string]$VpcId = '',
    [string[]]$SubnetIds = @(),
    [string]$RouteImpactImage = '',
    [string]$NotificationWorkerImage = '',
    [string]$ArrivalSignalQueueUrl = '',
    [string]$ExistingExecutionRoleArn = '',
    [string]$ExistingTaskRoleArn = '',
    [string]$ExistingLambdaRoleArn = '',
    [switch]$PreviewOnly
)
$ErrorActionPreference = 'Stop'
if (-not $ExecuteHdDeployment) { throw 'HD deployment requires -ExecuteHdDeployment.' }
$hdPrefix = 'sit314-hd-transport'
$deployScript = Join-Path $PSScriptRoot 'deploy.ps1'
$arguments = @{
    Stacks = @($Stage)
    Prefix = $hdPrefix
    Region = $Region
    MetricNamespace = 'SIT314/HDTransport'
}
if ($PreviewOnly) { $arguments.WhatIfOnly = $true }
if ($Stage -eq 'ecs') {
    if (-not $VpcId -or $SubnetIds.Count -lt 2 -or
        $RouteImpactImage -notmatch ('/' + [regex]::Escape("$hdPrefix-route-impact-worker:") + '[^/]+$')) {
        throw 'HD ECS deployment requires a VPC, two public subnets, and the HD route-impact ECR image.'
    }
    if (-not $ArrivalSignalQueueUrl -or $ArrivalSignalQueueUrl -notmatch [regex]::Escape("$hdPrefix-arrival.fifo")) {
        throw 'HD ECS deployment requires the exact HD arrival-signal queue URL.'
    }
    if ($NotificationWorkerImage) {
        $registry = $RouteImpactImage.Split('/')[0]
        $expected = [regex]::Escape("$registry/$hdPrefix-notification-worker:")
        if ($NotificationWorkerImage -notmatch "^$expected[^/]+$") {
            throw 'HD notification image must use the same verified HD ECR registry and notification-worker repository.'
        }
        $notificationTag = $NotificationWorkerImage.Split(':')[-1]
        $digest = aws ecr describe-images --repository-name "$hdPrefix-notification-worker" --region $Region `
            --image-ids "imageTag=$notificationTag" --query 'imageDetails[0].imageDigest' --output text
        if ($LASTEXITCODE -ne 0 -or -not $digest -or $digest -eq 'None') {
            throw 'HD notification image has no verified ECR digest.'
        }
        $arguments.NotificationWorkerImage = $NotificationWorkerImage
    }
    $arguments.VpcId = $VpcId
    $arguments.SubnetIds = $SubnetIds
    $arguments.RouteImpactImage = $RouteImpactImage
    $arguments.WorkerProcessingDelayMs = 50
    $arguments.HdArrivalSignalQueueUrl = $ArrivalSignalQueueUrl
    $arguments.ExistingExecutionRoleArn = $ExistingExecutionRoleArn
    $arguments.ExistingTaskRoleArn = $ExistingTaskRoleArn
}
if ($Stage -eq 'scaling') {
    $arguments.ScalingMode = 'BacklogPerTask'
    $arguments.MinTasks = 1
    $arguments.MaxTasks = 5
    $arguments.TargetBacklogPerTask = 75
    $arguments.ExistingLambdaRoleArn = $ExistingLambdaRoleArn
}
& $deployScript @arguments
if ($LASTEXITCODE -ne 0) { throw "HD $Stage deployment failed." }
