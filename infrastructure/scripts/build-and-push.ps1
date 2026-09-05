<#
.SYNOPSIS
    Builds the worker container images and pushes them to project-scoped ECR
    repositories.

.DESCRIPTION
    First creates or verifies every ECR repository, then authenticates Docker,
    builds, tags, pushes, and verifies each image. ECS must only be deployed
    after this script has reported a digest for the route-impact image.

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
Write-Host "Registry: $registry"

function Ensure-EcrRepository {
    param([string]$RepositoryName)

    # Do not mistake AccessDenied, a wrong region, or a transient CLI failure
    # for a missing repository and then attempt an unrelated create operation.
    $check = @(aws ecr describe-repositories --repository-names $RepositoryName --region $Region 2>&1)
    if ($LASTEXITCODE -eq 0) {
        Write-Host "ECR repository $RepositoryName verified"
        return
    }
    $detail = $check -join "`n"
    if ($detail -notmatch 'RepositoryNotFoundException') {
        throw "could not verify ECR repository ${RepositoryName}: $detail"
    }

    Write-Host "creating ECR repository $RepositoryName"
    aws ecr create-repository --repository-name $RepositoryName --region $Region `
        --image-scanning-configuration scanOnPush=true `
        --tags Key=Project,Value=SIT314-Transport-IoT Key=Owner,Value=Lorenzo > $null
    if ($LASTEXITCODE -ne 0) { throw "could not create ECR repository $RepositoryName" }

    aws ecr describe-repositories --repository-names $RepositoryName --region $Region > $null
    if ($LASTEXITCODE -ne 0) { throw "ECR repository $RepositoryName was not verifiable after creation" }
    Write-Host "ECR repository $RepositoryName created and verified"
}

function Login-DockerToEcr {
    param([string]$Registry)

    # Use redirected standard input rather than a fragile PowerShell native
    # pipeline or nested cmd.exe quoting. The generated registry has no shell
    # metacharacters, and the token never appears in a command line or log.
    $token = aws ecr get-login-password --region $Region
    if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'could not obtain ECR login token' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = 'docker'
    $info.Arguments = "login --username AWS --password-stdin $Registry"
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $process.StandardInput.WriteLine($token.Trim())
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw "docker login to ECR failed: $stderr" }
    if ($stdout) { Write-Host $stdout.Trim() }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
Push-Location $repoRoot
try {
    # Required order for a new AWS Academy session: repositories exist before
    # Docker is authenticated or an image is built/pushed.
    foreach ($service in $Services) {
        Ensure-EcrRepository -RepositoryName "$Prefix-$service"
    }

    Write-Host "`nLogging Docker in to ECR..."
    Login-DockerToEcr -Registry $registry

    $pushed = @{}

    foreach ($service in $Services) {
        $repoName = "$Prefix-$service"
        Write-Host "`n=== $repoName ==="

        $imageUri = "$registry/${repoName}:$Tag"

        Write-Host "building..."
        docker build -f "services/$service/Dockerfile" -t $imageUri .
        if ($LASTEXITCODE -ne 0) { throw "docker build failed for $service" }

        Write-Host "pushing..."
        docker push $imageUri
        if ($LASTEXITCODE -ne 0) { throw "docker push failed for $service" }

        $digest = aws ecr describe-images --repository-name $repoName --region $Region `
            --image-ids "imageTag=$Tag" --query 'imageDetails[0].imageDigest' --output text
        if ($LASTEXITCODE -ne 0 -or -not $digest -or $digest -eq 'None') {
            throw "ECR did not return a digest for $imageUri after push"
        }

        $pushed[$service] = $imageUri
        Write-Host "pushed and verified $repoName`:$Tag ($digest)"
    }

    Write-Host "`nImage URIs to pass to deploy.ps1:"
    foreach ($k in $pushed.Keys) {
        Write-Host "  $k = $($pushed[$k])"
    }
}
finally {
    Pop-Location
}
