# Resource-isolation audit — local template inspection

**No AWS resources were created or queried in this audit.** The frozen Distinction prefix is `sit314-transport`; the HD-only prefix is fixed to `sit314-hd-transport` in the guarded HD wrappers. Shared generic `deploy.ps1` and `build-and-push.ps1` still default to D for their original workflow, so tomorrow **must use** `deploy-hd.ps1` and `build-hd-image.ps1`, not those generic scripts directly. Both HD wrappers require an explicit execution switch and always pass the HD prefix. The run CLI also rejects a non-HD prefix. A misspelled HD stack/queue should fail preflight, never fall through to D.

| Type | Planned HD name/namespace | Existing D equivalent | Collision? / safety check |
| --- | --- | --- | --- |
| CloudFormation stacks | `sit314-hd-transport-{queues,tables,ecs,scaling,hd-code,hd-signals,hd-predictor}` | `sit314-transport-*` | Different names; guarded wrapper fixes HD prefix. |
| SQS working queues/DLQs | `sit314-hd-transport-{telemetry,analysis,notifications}` and `-*-dlq` | Same suffixes under D prefix | No collision; exports and worker env resolve HD stack imports. |
| HD arrival FIFO/DLQ | `sit314-hd-transport-arrival.fifo`, `-arrival-dlq.fifo` | None | HD-only; preflight checks both 0/0. |
| DynamoDB application tables | `sit314-hd-transport-{processed-events,current-state,analysis-results,notifications}` | Same suffixes under D prefix | No collision. |
| Predictor state | `sit314-hd-transport-predictor-state` | None | HD-only; per-run `RunId` key and TTL. |
| ECS cluster/service/task family | `sit314-hd-transport-cluster`, `-route-impact`; task family `-route-impact` | `sit314-transport-cluster`, `-route-impact` | Different names and resource ID; target only HD service. |
| ECR worker image | `sit314-hd-transport-route-impact-worker:hd-frozen` (or verified HD tag) | D ECR repository | HD image wrapper fixes repository prefix; never retag D. |
| Reactive Lambda | `sit314-hd-transport-backlog-metric` | `sit314-transport-backlog-metric` | Different function; scheduled publisher sends to `SIT314/HDTransport`. |
| Predictor Lambda/event mapping | `sit314-hd-transport-predictor`, HD FIFO mapping | None | Separate function and HD queue import. |
| CloudWatch alarm/policies | `sit314-hd-transport-fast-backlog-scale-out`, `-backlog-per-task` | Corresponding D names | Same settings, different service resource ID and `SIT314/HDTransport` namespace. |
| Other alarm | `sit314-hd-transport-analysis-dlq-not-empty` | D equivalent | Different queue/name. |
| Metrics/log groups | `SIT314/HDTransport`; `/ecs/sit314-hd-transport-*`; `/aws/lambda/sit314-hd-transport-predictor` | `SIT314/Transport`; `/ecs/sit314-transport-*` | Separate namespace/dimensions/log groups. Genuine HD BPT has `ServiceName` only. |
| Lambda code S3 bucket | `sit314-hd-transport-<account>-us-east-1-code` | None | HD-only bucket; global-name uniqueness and region checked at deployment. |
| IAM roles | Optional `sit314-hd-transport-*` generated role or explicitly supplied Academy `LabRole` | D may also use LabRole | Shared **role reference**, not D resource mutation; verify permissions before use. No new IAM user/key. |
| EventBridge scheduled BPT rule | Derived from HD `scaling.yaml` prefix | D scheduled rule | Different rule/function target. |
| IoT rule | Not deployed for matched direct-injection study | D IoT rule | None in HD plan; avoids D topic/rule dependency. |

Potential unresolved cloud-only concern: Academy LabRole may not allow the predictor's DynamoDB/SQS/ECS/CloudWatch actions, or the Node.js runtime may lack a module expected by the packaged Lambda. These are **smoke-test gates**, not reasons to point any HD stack at D. Preserve D resources until the video is recorded and submitted.
