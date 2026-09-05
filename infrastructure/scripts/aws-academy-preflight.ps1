<#
.SYNOPSIS
    Read-only AWS Academy readiness checks for a future live session.

.DESCRIPTION
    Performs only non-mutating identity/IAM inspection, IAM policy simulation,
    and CloudWatch Logs inspection. It does not create a role, service-linked
    role, stack, repository, log stream, or any other resource. A denied IAM
    read or policy simulation is reported as UNKNOWN, never treated as permission.

    Run it before deployment, and again after the ECS stack exists. The first
    Application Auto Scaling registration remains a deliberately isolated live
    gate because it may need AWSServiceRoleForApplicationAutoScaling_ECSService.
#>
[CmdletBinding()]
param(
    [string]$Prefix = 'sit314-transport',
    [string]$Region = $env:AWS_REGION,
    [string]$LabRoleArn = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw 'AWS CLI is not installed or not on PATH. After winget installation, use a genuinely new terminal window (not a child of the old shell) or the full executable path.'
}
if (-not $Region) {
    $Region = (aws configure get region)
    if (-not $Region) { throw 'Set AWS_REGION or configure a default region before the live preflight.' }
}

function Invoke-AwsJson {
    param([string[]]$Arguments, [string]$Description)
    $output = @(aws @Arguments --output json 2>&1)
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "${Description}: UNKNOWN (AWS denied or could not complete the read: $($output -join ' '))"
        return $null
    }
    return ($output -join "`n" | ConvertFrom-Json)
}

Write-Host "=== AWS Academy preflight (read-only) ==="
Write-Host "Region: $Region"
$identity = Invoke-AwsJson -Arguments @('sts', 'get-caller-identity', '--region', $Region) -Description 'caller identity'
if (-not $identity) { throw 'Cannot establish the authenticated caller identity.' }
Write-Host "Authenticated ARN suffix: ...$($identity.Arn.Substring([Math]::Max(0, $identity.Arn.Length - 24)))"

$linkedRole = Invoke-AwsJson -Arguments @('iam', 'get-role', '--role-name', 'AWSServiceRoleForApplicationAutoScaling_ECSService') -Description 'Application Auto Scaling service-linked role'
if ($linkedRole) {
    Write-Host 'Application Auto Scaling service-linked role: present'
} else {
    Write-Warning 'Service-linked role is not confirmed. Do not assume first-use creation is permitted: deploy the scaling stack as its own live gate after ECS, and stop on any iam:CreateServiceLinkedRole denial.'
}

if ($LabRoleArn) {
    $match = [regex]::Match($LabRoleArn, '^arn:aws[a-zA-Z-]*:iam::\d{12}:role/(?<name>.+)$')
    if (-not $match.Success) { throw '-LabRoleArn must be a valid IAM role ARN.' }
    $roleName = $match.Groups['name'].Value
    $role = Invoke-AwsJson -Arguments @('iam', 'get-role', '--role-name', $roleName) -Description 'LabRole trust policy'
    if ($role) {
        $trusted = @($role.Role.AssumeRolePolicyDocument.Statement | ForEach-Object {
            if ($_.Effect -eq 'Allow' -and $_.Principal.Service) { @($_.Principal.Service) }
        }) | Select-Object -Unique
        Write-Host "LabRole trusted services: $($trusted -join ', ')"
        foreach ($service in @('ecs-tasks.amazonaws.com', 'iot.amazonaws.com', 'lambda.amazonaws.com')) {
            if ($trusted -contains $service) { Write-Host "Trust ${service}: present" }
            else { Write-Warning "Trust ${service}: NOT CONFIRMED. This role cannot be used for that project component unless its trust policy permits it." }
        }
    }
    $attached = Invoke-AwsJson -Arguments @('iam', 'list-attached-role-policies', '--role-name', $roleName) -Description 'LabRole attached policies'
    if ($attached) { Write-Host "LabRole attached policies: $(@($attached.AttachedPolicies).Count) listed (names are not proof of effective resource permissions)." }
    $inline = Invoke-AwsJson -Arguments @('iam', 'list-role-policies', '--role-name', $roleName) -Description 'LabRole inline policies'
    if ($inline) { Write-Host "LabRole inline policies: $(@($inline.PolicyNames).Count) listed (names are not proof of effective resource permissions)." }

    # This is an authorization simulation only; it is useful when Academy
    # allows iam:SimulatePrincipalPolicy, but cannot establish role trust,
    # service control policies, resource policies, or a successful service call.
    $accountId = $identity.Account
    $iotErrorLogArn = "arn:aws:logs:${Region}:${accountId}:log-group:/aws/iot/$Prefix-rule-errors:log-stream:*"
    $telemetryQueueArn = "arn:aws:sqs:${Region}:${accountId}:$Prefix-telemetry"
    $routeImpactRepositoryArn = "arn:aws:ecr:${Region}:${accountId}:repository/$Prefix-route-impact-worker"
    $permissionChecks = @(
        @{ Action = 'sqs:SendMessage'; Resource = $telemetryQueueArn; Description = 'IoT rule SQS delivery' },
        @{ Action = 'logs:CreateLogStream'; Resource = $iotErrorLogArn; Description = 'IoT ErrorAction log stream creation' },
        @{ Action = 'logs:PutLogEvents'; Resource = $iotErrorLogArn; Description = 'IoT ErrorAction log write' },
        @{ Action = 'ecr:GetAuthorizationToken'; Resource = '*'; Description = 'ECS execution-role ECR authorization' },
        @{ Action = 'ecr:BatchGetImage'; Resource = $routeImpactRepositoryArn; Description = 'ECS execution-role image lookup' },
        @{ Action = 'ecr:GetDownloadUrlForLayer'; Resource = $routeImpactRepositoryArn; Description = 'ECS execution-role image layer pull' }
    )
    $simulated = $false
    foreach ($permissionCheck in $permissionChecks) {
        $simulation = Invoke-AwsJson -Arguments @(
            'iam', 'simulate-principal-policy', '--policy-source-arn', $LabRoleArn,
            '--action-names', $permissionCheck.Action, '--resource-arns', $permissionCheck.Resource
        ) -Description "LabRole permission simulation: $($permissionCheck.Description)"
        if ($simulation) {
            $simulated = $true
            $simulation.EvaluationResults | ForEach-Object {
                Write-Host "Simulation $($_.EvalActionName) on $($_.EvalResourceName): $($_.EvalDecision)"
            }
        }
    }
    if ($simulated) {
        Write-Host 'Simulation is advisory only. Live gates still required: iam:PassRole by the deployer; ECS image pull/log write; IoT assume-role + SQS/ErrorAction Logs; Lambda queue/ECS/CloudWatch permissions.'
    }
} else {
    Write-Warning 'No LabRole ARN supplied. Trust and role-policy checks are skipped; pass -LabRoleArn only after obtaining the actual lab role ARN.'
}

$logGroups = Invoke-AwsJson -Arguments @('logs', 'describe-log-groups', '--region', $Region, '--log-group-name-prefix', "/ecs/$Prefix-route-impact") -Description 'route-impact log group visibility'
if ($logGroups) {
    Write-Host "Route-impact log groups visible: $(@($logGroups.logGroups).Count). This read does not prove ECS task-role write permission."
}

Write-Host 'No write operation was attempted. Do not use cloudwatch set-alarm-state as scaling evidence; only real workload-driven scaling activities qualify.'
