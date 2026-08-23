<#
.SYNOPSIS
    Builds the worker container images and pushes them to project-scoped ECR
    repositories.

.DESCRIPTION
    Creates one ECR repository per service (only if it does not already exist),
    logs Docker in to ECR, builds each image from the repository root, and
    pushes it.

    The route-impact worker is the priority: it is the service that ECS
    autoscales. The other two are optional.

    Nothing secret is baked into an image - see .dockerignore. Credentials come
    from the ECS task role at runtime.

.EXAMPLE
    ./infrastructure/scripts/build-and-push.ps1 -Services route-impact-worker

.EXAMPLE
    ./infrastructure/scripts/build-and-push.ps1 -Services route-impact-worker,telemetry-processor,notification-worker
#>
[CmdletBinding()]
param(
    [ValidateSet('route-impact-worker', 'telemetry-processor', 'notification-worker')]
    [string[]]$Services = @('route-impact-worker'),

    [string]$Prefix = 'sit314-transport',
    [string]$Region = $env:AWS_REGION,
    [string]$Tag = 'latest'
)

$ErrorActionPreference = 'Stop'

foreach ($tool in @('aws', 'docker')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is not installed or not on PATH."
    }
}

# Fail early and clearly if the Docker daemon is not running.
docker info --format '{{.ServerVersion}}' > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    throw 'The Docker daemon is not running. Start Docker Desktop and try again.'
}

if (-not $Region) {
    $Region = (aws configure get region)
    if (-not $Region) { $Region = 'us-east-1' }
}

$accountId = (aws sts get-caller-identity --query Account --output text)
if (-not $accountId) { throw 'Could not determine the AWS account. Configure credentials first.' }
$registry = "$accountId.dkr.ecr.$Region.amazonaws.com"

# The registry host contains the account id, so it is printed only once here and
# should be redacted from any screenshot that goes into the report.
Write-Host "Region:   $Region"
Write-Host "Registry: <account>.dkr.ecr.$Region.amazonaws.com"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
Push-Location $repoRoot
try {
    Write-Host "`nLogging Docker in to ECR..."
    aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $registry
    if ($LASTEXITCODE -ne 0) { throw 'docker login to ECR failed.' }

    $pushed = @{}

    foreach ($service in $Services) {
        $repoName = "$Prefix-$service"
        Write-Host "`n=== $repoName ==="

        # Create the repository only if it is missing; never modify an existing one.
        aws ecr describe-repositories --repository-names $repoName --region $Region > $null 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "creating ECR repository $repoName"
            aws ecr create-repository --repository-name $repoName --region $Region `
                --image-scanning-configuration scanOnPush=true `
                --tags Key=Project,Value=SIT314-Transport-IoT Key=Owner,Value=Lorenzo > $null
            if ($LASTEXITCODE -ne 0) { throw "could not create ECR repository $repoName" }
        } else {
            Write-Host "ECR repository $repoName already exists"
        }

        $imageUri = "$registry/${repoName}:$Tag"

        Write-Host "building..."
        docker build -f "services/$service/Dockerfile" -t $imageUri .
        if ($LASTEXITCODE -ne 0) { throw "docker build failed for $service" }

        Write-Host "pushing..."
        docker push $imageUri
        if ($LASTEXITCODE -ne 0) { throw "docker push failed for $service" }

        $pushed[$service] = $imageUri
        Write-Host "pushed $repoName`:$Tag"
    }

    Write-Host "`nImage URIs to pass to deploy.ps1:"
    foreach ($k in $pushed.Keys) {
        Write-Host "  $k = $($pushed[$k])"
    }
}
finally {
    Pop-Location
}
