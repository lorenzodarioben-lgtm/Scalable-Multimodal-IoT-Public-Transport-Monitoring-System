# Development environment

Recorded from the development machine. No account ids, credentials or other
sensitive values appear here.

## Machine

| Item | Value |
|---|---|
| OS | Windows 11 Home Single Language, 10.0.26200 |
| Architecture | x64 |
| Shells used | PowerShell (primary) and Git Bash |

## Toolchain

| Tool | Version | Status |
|---|---|---|
| Node.js | v22.19.0 | available (project requires >= 20) |
| npm | 10.9.3 | available |
| git | 2.51.0.windows.1 | available, identity configured |
| Docker CLI | 28.4.0 | installed |
| Docker daemon | - | **NOT RUNNING** |
| AWS CLI | - | **NOT INSTALLED** |
| Node-RED | 5.0.6 | installed as a dev dependency, runs locally |

Reproduce with:

```bash
npm run verify-env
```

## Blockers

### 1. AWS CLI not installed, no credentials configured

```
$ aws --version
aws: command not found

$ ls ~/.aws
No such file or directory
```

No `AWS_*` environment variables are set either.

**Effect.** No AWS resource can be created, configured or verified. AWS IoT
Core, SQS, DynamoDB, ECS, CloudWatch and Application Auto Scaling are all
unreachable, so every AWS-dependent phase is blocked.

**Response.** The full pipeline was built and verified against local adapters,
and the complete infrastructure-as-code was written and structurally tested.
`docs/AWS_DEPLOYMENT.md` contains the exact commands to run once access exists.

**To unblock:**

```bash
winget install --id Amazon.AWSCLI -e
# reopen the terminal, then:
aws configure sso        # or paste AWS Academy lab credentials
aws sts get-caller-identity
```

### 2. Docker daemon not running

```
$ docker info
error during connect: ... open //./pipe/dockerDesktopLinuxEngine:
The system cannot find the file specified.

PS> Get-Service com.docker.service
Status: Stopped

PS> Start-Service com.docker.service
Cannot open com.docker.service service on computer '.'
```

Starting the service requires administrator elevation, which this session does
not have. Launching `Docker Desktop.exe` did not bring the engine up either -
it likely needs an interactive sign-in or first-run acceptance.

**Effect.** Container images cannot be built or pushed, and `docker compose`
cannot run. The Dockerfiles and `docker-compose.yml` are written but
**unverified**.

**To unblock:** start Docker Desktop from the Start menu, wait for the whale
icon to stop animating, then:

```bash
docker info
docker build -f services/route-impact-worker/Dockerfile -t sit314-transport-route-impact-worker .
```

## What runs without either blocker

Everything except AWS deployment and container builds:

| Capability | State |
|---|---|
| Simulator (all four event types, all scenarios) | working |
| MQTT publish/subscribe over a real broker | working |
| Node-RED validation and normalisation | working |
| Normalised events into the telemetry queue | working |
| Telemetry processor, DynamoDB-equivalent state, disruption fan-out | working |
| Route-impact worker, results, alerts | working |
| Notification worker, simulated delivery records | working |
| Backlog-per-task autoscaling of worker processes | working |
| Scalability experiments with recorded metrics | working |
| Automated test suite | 150 tests passing |

## AWS region

No region is configured on this machine. The code defaults to `us-east-1` via
`AWS_REGION` and respects an existing AWS CLI region when one is present. No
region is hard-coded anywhere - a test asserts this across all templates.
