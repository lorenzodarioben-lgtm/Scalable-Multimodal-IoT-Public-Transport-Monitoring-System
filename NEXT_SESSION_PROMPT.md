# Prompt for the next session

Copy everything below the line into a fresh session.

---

Continue the SIT314 Distinction Project in this repository.

**Project:** Scalable Multimodal IoT Public Transport Monitoring System
**Student:** Lorenzo Dario Ben
**Working directory:** `C:/Users/lorenzodario/Documents/UNI/UNI_T3/CLoud/Distinction`

The repository on disk is the source of truth. Assume no prior conversation
context.

## 1. Read before doing anything

Read these first, in this order:

- `HANDOFF.md` — complete state, blockers, methodology, next commands
- `README.md` — overview, structure, how to run everything
- `docs/STATUS_4.2D.md` — per-component VERIFIED / IMPLEMENTED-NOT-DEPLOYED /
  PARTIAL / BLOCKED / NOT STARTED
- `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_DECISIONS.md`,
  `docs/SCALABILITY_TESTING.md`, `docs/AWS_DEPLOYMENT.md`, `docs/SECURITY.md`,
  `docs/EVIDENCE_CHECKLIST.md`, `docs/ENVIRONMENT.md`

## 2. Inspect before changing anything

```bash
git status
git log --oneline --decorate -10
npm install
npm run verify-env
```

Confirm what already exists. **Do not rebuild components that are already
complete.** A large amount is finished and verified: the simulator, the Node-RED
flow, all three services, the local queue/store/metrics adapters, the experiment
runner, all five CloudFormation stacks, and the deployment scripts.

## 3. Verify the tests

```bash
npm test
```

Expect **159 tests, 159 pass, 0 fail**. If anything fails, fix it before starting
new work.

Also confirm the two other gates:

```bash
npm run lint:infra        # cfn-lint, offline; expect "no findings"
npm run demo:reliability  # expect five PASS lines
```

`lint:infra` needs cfn-lint (`pip install --user cfn-lint`). It never calls AWS.

Optionally re-verify the full local pipeline (two terminals):

```bash
npm run node-red     # terminal 1, leave running
npm run demo:local   # terminal 2
```

## 4. AWS CLI — only when the user says so

The AWS CLI is **not installed** and **no credentials exist** on this machine. This
is the main blocker.

**Do not install or configure the AWS CLI on your own initiative.** Wait until the
user explicitly asks. When they do, they supply the AWS Academy lab credentials
themselves. Never print, log or commit credentials, account IDs, keys or
certificates.

Then confirm access before anything else:

```bash
aws --version
aws sts get-caller-identity
```

## 5. Deploy the infrastructure that is already built

The CloudFormation templates and deployment scripts already exist — do not rewrite
them. Deploy with:

```powershell
./infrastructure/scripts/deploy.ps1 -Stacks queues,tables
./infrastructure/scripts/deploy.ps1 -Stacks iot-rule
./infrastructure/scripts/build-and-push.ps1
./infrastructure/scripts/deploy.ps1 -Stacks ecs,scaling -RouteImpactImage <ecr-uri> -VpcId <vpc> -SubnetIds <subnets>
```

In a restricted account, pass the lab role ARNs (`-ExistingExecutionRoleArn`,
`-ExistingTaskRoleArn`, `-ExistingIotRuleRoleArn`, `-ExistingLambdaRoleArn`) so no
role creation is attempted.

## 6. Deployment priority

1. AWS IoT Core (thing, certificate, policy, endpoint into `.env`)
2. SQS queues + DLQs
3. DynamoDB tables
4. IoT Rule (`transport/normalized/+` → telemetry queue)
5. ECR and pushed images
6. ECS Fargate — **route-impact worker first**, it is the primary autoscaling target
7. CloudWatch log groups and metrics
8. Application Auto Scaling, min 1 / max 5, backlog-per-task
9. Other workers only if time and budget allow

## 7. Verify every deployment — never assume

A command returning zero is not proof. After each step, run the matching describe
call and read the output:

```bash
aws sqs get-queue-attributes --queue-url <url> --attribute-names All
aws dynamodb describe-table --table-name sit314-transport-current-state
aws ecs describe-services --cluster sit314-transport-cluster --services sit314-transport-route-impact
aws application-autoscaling describe-scalable-targets --service-namespace ecs
aws application-autoscaling describe-scaling-policies --service-namespace ecs
```

Confirm min 1 / max 5 explicitly. If a call is denied by account permissions,
capture the exact error, stop retrying it, leave the template ready, and record the
blocker in `HANDOFF.md`. Do not weaken security to get around a restriction.

If the custom `BacklogPerTask` metric cannot be created, use the queue-depth
fallback and document the deviation honestly in
`docs/IMPLEMENTATION_DECISIONS.md`. Never call queue-depth scaling
backlog-per-task.

## 8. Collect evidence-friendly output

`docs/EVIDENCE_CHECKLIST.md` lists E01–E12 with the exact command or console page,
what must be visible, and what has already been captured. Highest-value items still
outstanding:

- E04 — accepted vs rejected in the Node-RED debug pane (no AWS needed)
- E01 — two simulator configurations side by side (no AWS needed)
- E02, E05, E06 — IoT MQTT test client, SQS console, DynamoDB console
- E08, E09, E11 — ECS task running, autoscaling min 1 / max 5, task count rising

Promote experiment output into the committed evidence set with:

```bash
npm run evidence -- --promote latest
```

## 9. Do not rebuild what is finished

Already complete and verified — leave alone unless a real defect is found:

- Simulator: seeded RNG, network, four generators, CLI, five scenarios, invalid and
  duplicate injection, dry-run and MQTT targets
- Node-RED: flow with four per-mode validation branches, normalisation, reject path,
  generated `flows.json` kept in sync with `node-red/functions/*.js`
- Shared: config, logging, validation, local + AWS queue/store/metrics adapters
- Services: telemetry processor, route-impact worker, notification worker, all with
  idempotency, graceful shutdown, Dockerfiles and tests
- Experiments: runner, four incident stages, eight telemetry-growth stages, local
  backlog-per-task autoscaler, plus measured stage 1 and stage 2 A/B evidence
- Reliability evidence: `npm run demo:reliability` covers duplicate, stale,
  retry and DLQ redrive in one command
- Containers: all four images build, run and shut down cleanly, and the
  six-container Compose stack runs the full pipeline. Do not redesign them —
  only ECR push and ECS Fargate remain
- Infrastructure: all five CloudFormation stacks and the deployment scripts
- Documentation: README and all `docs/` files

## 9a. Two rules that are easy to get wrong

**Use `--incidents N` for every fixed-vs-autoscale comparison.** Bounding
injection by elapsed time gives the two arms *different* workloads, because
enqueuing slows under worker contention. This was measured locally (1500 jobs
fixed versus 750 autoscaled) and the same trap exists on AWS. See
`docs/IMPLEMENTATION_DECISIONS.md` section 16.

**Never describe queue-depth scaling as backlog-per-task.** If the custom metric
Lambda is denied, `ScalingMode=QueueDepth` is the documented fallback and the
report must say which one was actually used.

## 10. Constraints

- Keep AWS spending minimal. No NAT Gateway, no load balancer, smallest Fargate
  task size, return the service toward min 1 after tests.
- Never create IAM users or long-lived access keys.
- Never commit `.env`, certificates, keys, tokens or account IDs.
- Never modify or delete unrelated AWS resources; cleanup must stay scoped to this
  project's prefix.
- No real SMS, email or paid notifications — simulated records only.
- Do not mention automated tooling in repository files, documentation, comments or
  commit messages, and do not add automated contributors.
- Do not change the global Git identity or falsify commit dates.
- Never claim a deployment, test result, measurement or screenshot that was not
  actually produced.

## 11. Keep the handoff current

Update `HANDOFF.md` after each coherent phase — not at the end. A previous session
ran out of context with its handoff unwritten. Run `npm test`, fix failures, commit
meaningful work, then continue.
