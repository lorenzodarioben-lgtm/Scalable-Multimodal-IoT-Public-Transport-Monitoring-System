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

**Docker is no longer blocked.** Docker Desktop 4.47.0 (engine 28.4.0, Linux
engine) was started on 2026-09-04 and every image now builds and runs; the
six-container Compose stack runs the full pipeline. The only remaining blocker is
AWS access.


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

### 2. Docker — RESOLVED 2026-09-04

Previously the daemon would not start: `docker info` failed with
`open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file
specified`, `com.docker.service` was `Stopped`, and starting it needed
administrator elevation this session did not have.

The user started Docker Desktop 4.47.0 interactively and the Linux engine
(28.4.0) came up. Verified since:

```bash
docker version                       # Client and Server both 28.4.0
docker build -f services/route-impact-worker/Dockerfile -t sit314-transport-route-impact-worker .
docker compose --profile workers up -d
docker compose ps
```

All four images build, run as a non-root user, process real work, and exit 0 on
`docker stop`. The six-container Compose stack runs the full pipeline. Only the
AWS half remains: no ECR push, no ECS Fargate run.

**One gotcha:** the Compose `node-red` service publishes host port 1880, which
collides with a host `npm run node-red`. Stop the host process first.

## What runs without AWS

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
