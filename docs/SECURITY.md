# Security

Security here is practical rather than decorative: each control exists because
something specific would go wrong without it.

## Transport security (MQTT)

`MQTT_MODE=aws` connects to AWS IoT Core over **MQTT with TLS 1.2 and mutual
X.509 authentication** on port 8883. The device presents a certificate; AWS IoT
authenticates it against a registered certificate and an attached policy. There
is no username or password anywhere in the system.

In `simulator/src/mqtt-client.js`:

```js
rejectUnauthorized: true,   // server certificate is always verified
minVersion: 'TLSv1.2',      // no downgrade to TLS 1.0/1.1
```

`assertAwsTlsConfig()` runs **before any connection attempt** and refuses to
start if the endpoint, CA, certificate or key is missing, naming exactly what is
absent. The client never silently falls back to an insecure connection.

`MQTT_MODE=local` uses a plain-TCP broker bound to `127.0.0.1` for development
only. It is not a deployment mode.

## Secrets and Git

No credential, key, certificate, token, account id or password is committed.

`.gitignore` excludes:

```
.env
.env.*            (but keeps .env.example)
certs/*           (but keeps certs/README.md)
*.pem *.key *.crt *.pfx *.p12
credentials*  private-*
```

Verified:

```bash
git check-ignore -v .env certs/device-private.pem.key
```

- `.env.example` contains names and safe defaults only - never a real value.
- `certs/README.md` explains what belongs there and states that nothing in the
  directory is committed.
- An automated test (`infrastructure/test/templates.test.js`) fails the build if
  any CloudFormation template contains a 12-digit account id, an `AKIA...`
  access key id, a hard-coded region, or the string `aws_secret_access_key`.

## Credentials at runtime

**No IAM users are created, and no long-lived access keys are issued.** A test
asserts that no template declares `AWS::IAM::User` or `AWS::IAM::AccessKey`.

| Where | How it authenticates |
|---|---|
| ECS tasks | Task role, credentials delivered by the container agent |
| IoT rule | A role it assumes, allowed only `sqs:SendMessage` to one queue |
| Metric Lambda | A role allowing read of one queue, `ecs:DescribeServices`, and `PutMetricData` in one namespace |
| Developer machine | `aws configure` / SSO profile, never checked in |

Every role ARN is a **parameter**. In a restricted account (for example AWS
Academy, where `iam:CreateRole` is denied) pass the provided lab role:

```bash
EXISTING_TASK_ROLE_ARN=arn:aws:iam::...:role/LabRole ./infrastructure/scripts/deploy.sh ecs
```

The templates then create no roles at all. Permissions are never widened to work
around a denial.

## Least privilege

The task role grants only what the services call, scoped to this project's
resources by ARN:

- SQS: receive/delete/send/get-attributes on the three queues only.
- DynamoDB: put/get/update/query/scan on the four tables only.
- CloudWatch: `PutMetricData` restricted by condition to the
  `SIT314/Transport` namespace.

The IoT rule role can do exactly one thing: send a message to the telemetry
queue.

The recommended AWS IoT policy for the simulator's certificate is similarly
narrow - connect with a specific client id, publish only under
`transport/raw/*`, subscribe only to `transport/normalized/*`. The exact
document is in `docs/AWS_DEPLOYMENT.md`.

## Queues and tables are not public

SQS queues are created with no queue policy, so they are reachable only by
principals granted access through IAM - nothing is public. Server-side
encryption is enabled (`SqsManagedSseEnabled: true`). DynamoDB tables have
`SSESpecification.SSEEnabled: true`. Both are asserted by tests.

## Container security

- Images run as a **non-root** user (`USER app`).
- `.dockerignore` excludes `.env`, `certs/`, `*.pem`, `*.key`, `*.crt` and
  `credentials*`, so a secret cannot be copied into a layer even by accident.
- Dependencies are installed with `npm ci --omit=dev --ignore-scripts`;
  `--ignore-scripts` prevents a package's install script from running at build
  time.
- `STOPSIGNAL SIGTERM` and the exec-form `CMD` mean the signal reaches Node
  directly, so a scale-in event drains cleanly instead of killing work.

## Network posture, and an honest trade-off

ECS tasks run in **public subnets with public IPs**, in a security group with
**no inbound rules at all** and outbound restricted to HTTPS (443).

This is a deliberate cost compromise. These workers poll SQS - nothing connects
to them - so there is no load balancer. They do need outbound access to the SQS,
DynamoDB and CloudWatch endpoints. From a private subnet that requires either a
NAT gateway (roughly USD 32/month plus data, more than the rest of this project
combined) or three interface VPC endpoints (also billed hourly).

**What this costs in security:** the tasks have routable addresses.
**What mitigates it:** the security group permits no inbound traffic, so they
accept no connections; they hold no long-lived credentials; and they expose no
listening port.

**What production should do instead:** private subnets with VPC endpoints for
SQS, DynamoDB, ECR and CloudWatch Logs. This is the first change to make if the
budget allows.

## Node-RED

- The editor binds to `127.0.0.1` only (`settings.cjs`). It has **no
  authentication configured**, so it must not be exposed on a network
  interface. If it ever needs to be, configure `adminAuth` first.
- `functionExternalModules: false` stops a function node from pulling arbitrary
  npm packages at runtime.
- Certificates for AWS IoT are referenced by path from a TLS config node; their
  contents are never stored in `flows.json`.

## Logging

Structured logs contain identifiers, timings and status - never credentials,
certificate contents or payload secrets. Two places deliberately truncate:

- `deploy.sh` / `deploy.ps1` print only the last ~24 characters of the caller
  ARN, so the account id stays out of terminal screenshots.
- `verify-env.js` prints only an ARN suffix.
- `build-and-push.ps1` must print the ECR registry host, which contains the
  account id; **redact that line before putting the screenshot in the report.**

## Input validation

Untrusted input is validated twice:

1. **Node-RED** validates each raw event against its mode-specific rules and
   publishes rejects to `transport/rejected/<mode>` with a reason. Invalid data
   never reaches the telemetry queue.
2. **Every service** re-validates defensively against the JSON Schema before
   acting, because a queue message could arrive from any producer with the right
   IAM permission.

Structurally invalid messages are treated as non-retryable and allowed to reach
the DLQ rather than being retried forever.

## Failure injection is off by default

`FAILURE_INJECTION_ENABLED=false` and `FAILURE_RATE=0` are the defaults, and
tests assert that the default configuration injects nothing. It exists only to
demonstrate retry and DLQ behaviour, and must be enabled explicitly.

## Cost controls as a safety property

Uncontrolled spend is a real risk on a student account:

- `MaxTasks` has `MaxValue: 5` in the template, so the cap cannot be raised by a
  parameter typo.
- Services start at `DesiredCount: 1`.
- DynamoDB is on-demand; CloudWatch log retention is 7 days.
- `cleanup.sh` refuses to run with a short or empty prefix, prints exactly which
  stacks it will delete, and requires the operator to type `DELETE`. It deletes
  only stacks named with the configured prefix followed by `-*` and never
  enumerates account resources by type.

## Container image verification (VERIFIED)

The images were built and inspected on 2026-09-04. Every claim below was checked
by running the image, not by reading the Dockerfile.

```bash
read -r -p 'Paste the image URI to inspect: ' IMAGE_URI
docker run --rm --entrypoint sh "$IMAGE_URI" -c 'id -un; find /app -not -path "*/node_modules/*"   \( -name ".env*" -o -name "*.pem" -o -name "*.key" -o -name "*.crt" -o -name "credentials*" \)'
```

| Check | Result |
|---|---|
| Runs as a non-root user | `app` in all four images |
| `.env` / `.env.*` present | none |
| Certificates, keys, credentials | none |
| Test files or Dockerfiles present | none |
| Dev dependencies in service images | none — `aedes`, `node-red`, `yaml`, `hyperid` all absent |
| Production dependencies present | `ajv`, `ajv-formats`, the four AWS SDK v3 clients |

Two build-context defects were found and fixed in the process:

- **Test suites and Dockerfiles were being copied into the production images.**
  The services `COPY` whole directories (`shared/`, `services/<name>/`), so
  `shared/test/`, `services/<name>/test/` and the service's own `Dockerfile`
  ended up inside the image. `.dockerignore` now excludes `**/test/`,
  `**/*.test.js` and `**/Dockerfile*`.
- **The broker image ran as root.** In Compose it also runs the normalised-to-queue
  bridge and shares the `/data` volume with the services, so as root it would
  create that volume root-owned and lock the unprivileged services out of it. It
  now runs as the same `app` user.

No credential is ever baked into an image. At runtime, AWS credentials come from
the ECS task role and certificate *paths* come from environment variables, with
the certificates themselves mounted from `./certs`, which is gitignored and
excluded from every build context.

## Dependency audit

Run against the tree that actually ships in the ECS worker images:

```bash
npm audit --omit=dev
```

**Result: 0 vulnerabilities.** The production dependency surface is small on
purpose — `ajv` plus the AWS SDK v3 clients, and `mqtt` for the simulator.

The full tree including development tooling reports 10 moderate advisories and no
high or critical ones:

```bash
npm audit
```

Every one of those traces back to two development-only packages:

| Root | Why it is present | Advisories |
|---|---|---|
| `aedes` | Local MQTT broker, the development stand-in for AWS IoT Core | `hyperid` → `uuid` buffer bounds check |
| `node-red` | The flow editor, run locally | `express`/`body-parser`/`qs` DoS and array-limit bypass |

Neither is deployed. `aedes` was previously declared in the root `dependencies`,
which meant `npm ci --omit=dev` inside the service Dockerfiles installed it into
the deployed images even though nothing there imports it. It is now a
`devDependency`, so the worker images no longer carry it or its transitive
advisories. `node-red/Dockerfile.broker` installs dev dependencies deliberately,
because that image *is* the local broker and is never pushed to ECR.

These advisories are **not** being fixed by forcing upgrades. `npm audit fix
--force` would install `aedes@1.1.2`, a breaking major change to a local
development convenience, for no benefit to the deployed system. Reassessing this
is only worthwhile if aedes or Node-RED ever move into a deployed path.

## Checklist before submitting

```bash
git ls-files | grep -Ei '\.(pem|key|crt|pfx|p12)$'   # must be empty
git ls-files | grep -E '^\.env$'                     # must be empty
git log -p | grep -Ei 'AKIA[0-9A-Z]{16}'             # must be empty
npm test                                             # template secret scan runs here
```
