<#
.SYNOPSIS
    Deploys the SIT314 transport monitoring infrastructure with CloudFormation.

.DESCRIPTION
    Deploys the stacks in dependency order:
        1. queues     SQS queues + dead-letter queues
        2. tables     DynamoDB tables
        3. iot-rule   AWS IoT rule: transport/normalized/+ -> telemetry queue
        4. ecs        Fargate cluster, task definitions and services  (needs images)
        5. scaling    Application Auto Scaling, min 1 / max 5         (needs ecs)

    Every stack is scoped to this project by the -Prefix parameter. The script
    never creates IAM users or long-lived access keys, and never touches a
    resource that does not carry this project's prefix.

    In a restricted account (for example AWS Academy) supply the existing lab
    role ARNs so no role creation is attempted:
        -ExistingExecutionRoleArn / -ExistingTaskRoleArn /
        -ExistingIotRuleRoleArn  / -ExistingLambdaRoleArn

.EXAMPLE
    ./infrastructure/scripts/deploy.ps1 -Stacks queues,tables

.EXAMPLE
    ./infrastructure/scripts/deploy.ps1 -Stacks ecs,scaling `
        -RouteImpactImage 123.dkr.ecr.us-east-1.amazonaws.com/sit314-transport-route-impact:latest `
        -VpcId vpc-abc -SubnetIds subnet-1,subnet-2 `
        -ExistingExecutionRoleArn arn:aws:iam::...:role/LabRole `
        -ExistingTaskRoleArn arn:aws:iam::...:role/LabRole
#>
[CmdletBinding()]
param(
    [ValidateSet('queues', 'tables', 'iot-rule', 'ecs', 'scaling')]
    [string[]]$Stacks = @('queues', 'tables'),

    [string]$Prefix = 'sit314-transport',
    [string]$Region = $env:AWS_REGION,

    # ECS inputs
    [string]$RouteImpactImage = '',
    [string]$TelemetryProcessorImage = '',
    [string]$NotificationWorkerImage = '',
    [string]$VpcId = '',
    [string[]]$SubnetIds = @(),

    # Restricted-account role overrides
    [string]$ExistingExecutionRoleArn = '',
    [string]$ExistingTaskRoleArn = '',
    [string]$ExistingIotRuleRoleArn = '',
    [string]$ExistingLambdaRoleArn = '',

    # Scaling
    [ValidateSet('BacklogPerTask', 'QueueDepth')]
    [string]$ScalingMode = 'BacklogPerTask',
    [int]$MinTasks = 1,
    [int]$MaxTasks = 5,
    [int]$TargetBacklogPerTask = 75,

    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw 'The AWS CLI is not installed or not on PATH. See docs/AWS_DEPLOYMENT.md.'
}

if (-not $Region) {
    $Region = (aws configure get region)
    if (-not $Region) { $Region = 'us-east-1' }
}
Write-Host "Region: $Region"
Write-Host "Prefix: $Prefix"

# Confirm we have credentials, without ever printing them.
Write-Host "`nVerifying caller identity..."
$identity = aws sts get-caller-identity --output json | ConvertFrom-Json
if ($?) {
    # Deliberately NOT printing the account id - it stays out of the logs.
    Write-Host ("Authenticated. ARN suffix: ..." + $identity.Arn.Substring([Math]::Max(0, $identity.Arn.Length - 24)))
} else {
    throw 'aws sts get-caller-identity failed. Configure credentials first.'
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$cfnDir = Join-Path $repoRoot 'infrastructure/cloudformation'

$commonTags = @(
    "Project=SIT314-Transport-IoT",
    "Owner=Lorenzo",
    "Environment=Student"
)

function Invoke-Stack {
    param(
        [string]$Name,
        [string]$Template,
        [string[]]$ParameterOverrides,
        [switch]$NeedsIam
    )

    $stackName = "$Prefix-$Name"
    $templatePath = Join-Path $cfnDir $Template

    Write-Host "`n=== $stackName ==="
    Write-Host "template: $Template"

    $cmd = @(
        'cloudformation', 'deploy',
        '--stack-name', $stackName,
        '--template-file', $templatePath,
        '--region', $Region,
        '--tags'
    ) + $commonTags

    if ($ParameterOverrides.Count -gt 0) {
        $cmd += '--parameter-overrides'
        $cmd += $ParameterOverrides
    }
    if ($NeedsIam) { $cmd += @('--capabilities', 'CAPABILITY_NAMED_IAM') }
    if ($WhatIfOnly) { $cmd += '--no-execute-changeset' }

    aws @cmd
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "$stackName did not deploy cleanly (exit $LASTEXITCODE)."
        Write-Warning "If this is an AccessDenied or iam:PassRole error, re-run with the"
        Write-Warning "-Existing*RoleArn parameters. Do NOT widen permissions to work around it."
        throw "deploy failed for $stackName"
    }
    Write-Host "$stackName OK"
}

foreach ($stack in $Stacks) {
    switch ($stack) {
        'queues' {
            Invoke-Stack -Name 'queues' -Template 'queues.yaml' `
                -ParameterOverrides @("ResourcePrefix=$Prefix")
        }
        'tables' {
            Invoke-Stack -Name 'tables' -Template 'dynamodb.yaml' `
                -ParameterOverrides @("ResourcePrefix=$Prefix")
        }
        'iot-rule' {
            $p = @("ResourcePrefix=$Prefix", "QueuesStackName=$Prefix-queues")
            if ($ExistingIotRuleRoleArn) { $p += "ExistingIotRuleRoleArn=$ExistingIotRuleRoleArn" }
            Invoke-Stack -Name 'iot-rule' -Template 'iot-rule.yaml' -ParameterOverrides $p -NeedsIam
        }
        'ecs' {
            if (-not $RouteImpactImage) { throw '-RouteImpactImage is required for the ecs stack. Run build-and-push.ps1 first.' }
            if (-not $VpcId) { throw '-VpcId is required for the ecs stack.' }
            if ($SubnetIds.Count -eq 0) { throw '-SubnetIds is required for the ecs stack.' }
            $p = @(
                "ResourcePrefix=$Prefix",
                "QueuesStackName=$Prefix-queues",
                "TablesStackName=$Prefix-tables",
                "VpcId=$VpcId",
                ("SubnetIds=" + ($SubnetIds -join '\,')),
                "RouteImpactImage=$RouteImpactImage"
            )
            if ($TelemetryProcessorImage) { $p += "TelemetryProcessorImage=$TelemetryProcessorImage" }
            if ($NotificationWorkerImage) { $p += "NotificationWorkerImage=$NotificationWorkerImage" }
            if ($ExistingExecutionRoleArn) { $p += "ExistingExecutionRoleArn=$ExistingExecutionRoleArn" }
            if ($ExistingTaskRoleArn) { $p += "ExistingTaskRoleArn=$ExistingTaskRoleArn" }
            Invoke-Stack -Name 'ecs' -Template 'ecs.yaml' -ParameterOverrides $p -NeedsIam
        }
        'scaling' {
            $p = @(
                "ResourcePrefix=$Prefix",
                "EcsStackName=$Prefix-ecs",
                "QueuesStackName=$Prefix-queues",
                "ScalingMode=$ScalingMode",
                "MinTasks=$MinTasks",
                "MaxTasks=$MaxTasks",
                "TargetBacklogPerTask=$TargetBacklogPerTask"
            )
            if ($ExistingLambdaRoleArn) { $p += "ExistingLambdaRoleArn=$ExistingLambdaRoleArn" }
            Invoke-Stack -Name 'scaling' -Template 'scaling.yaml' -ParameterOverrides $p -NeedsIam
        }
    }
}

Write-Host "`nDone. Inspect what was created with:"
Write-Host "  ./infrastructure/scripts/describe.ps1"
Write-Host "`nRemember: the route-impact service should sit at $MinTasks task(s) when idle."
