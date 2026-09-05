#!/usr/bin/env bash
# Deploys the SIT314 transport monitoring infrastructure with CloudFormation.
#
# POSIX equivalent of deploy.ps1. Deploy order:
#   queues -> tables -> iot-rule -> ecs (needs images) -> scaling (needs ecs)
#
# Usage:
#   ./deploy.sh queues tables
#   ROUTE_IMPACT_IMAGE=... VPC_ID=vpc-abc SUBNET_IDS=subnet-1,subnet-2 ./deploy.sh ecs scaling
#
# Restricted accounts (for example AWS Academy): export the existing lab role
# ARNs so no role creation is attempted.
#   EXISTING_EXECUTION_ROLE_ARN, EXISTING_TASK_ROLE_ARN,
#   EXISTING_IOT_RULE_ROLE_ARN, EXISTING_LAMBDA_ROLE_ARN
set -euo pipefail

PREFIX="${RESOURCE_PREFIX:-sit314-transport}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
SCALING_MODE="${SCALING_MODE:-BacklogPerTask}"
MIN_TASKS="${MIN_TASKS:-1}"
MAX_TASKS="${MAX_TASKS:-5}"
TARGET_BACKLOG="${TARGET_BACKLOG_PER_TASK:-75}"
WORKER_PROCESSING_DELAY_MS="${WORKER_PROCESSING_DELAY_MS:-0}"

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CFN_DIR="$REPO_ROOT/infrastructure/cloudformation"
TAGS=(Project=SIT314-Transport-IoT Owner=Lorenzo Environment=Student)

command -v aws >/dev/null || {
  echo "AWS CLI not found. See docs/AWS_DEPLOYMENT.md." >&2
  exit 1
}

echo "Region: $REGION"
echo "Prefix: $PREFIX"
echo "Verifying caller identity..."
# Print only a suffix of the ARN - never the account id or any credential.
ARN="$(aws sts get-caller-identity --query Arn --output text)"
echo "Authenticated. ARN suffix: ...${ARN: -24}"

deploy_stack() {
  local name="$1"; shift
  local template="$1"; shift
  local needs_iam="$1"; shift
  local stack="$PREFIX-$name"

  echo ""
  echo "=== $stack ==="
  local args=(cloudformation deploy
    --stack-name "$stack"
    --template-file "$CFN_DIR/$template"
    --region "$REGION"
    --tags "${TAGS[@]}")
  if [ "$#" -gt 0 ]; then
    args+=(--parameter-overrides "$@")
  fi
  if [ "$needs_iam" = "iam" ]; then
    args+=(--capabilities CAPABILITY_NAMED_IAM)
  fi

  if ! aws "${args[@]}"; then
    echo "WARNING: $stack did not deploy cleanly." >&2
    echo "If this is AccessDenied or iam:PassRole, re-run with EXISTING_*_ROLE_ARN set." >&2
    echo "Do NOT widen permissions to work around it." >&2
    exit 1
  fi
  echo "$stack OK"
}

[ "$#" -gt 0 ] || set -- queues tables

for stack in "$@"; do
  case "$stack" in
    queues)
      deploy_stack queues queues.yaml noiam "ResourcePrefix=$PREFIX"
      ;;
    tables)
      deploy_stack tables dynamodb.yaml noiam "ResourcePrefix=$PREFIX"
      ;;
    iot-rule)
      params=("ResourcePrefix=$PREFIX" "QueuesStackName=$PREFIX-queues")
      if [ -n "${EXISTING_IOT_RULE_ROLE_ARN:-}" ]; then
        params+=("ExistingIotRuleRoleArn=$EXISTING_IOT_RULE_ROLE_ARN")
      fi
      deploy_stack iot-rule iot-rule.yaml iam "${params[@]}"
      ;;
    ecs)
      : "${ROUTE_IMPACT_IMAGE:?ROUTE_IMPACT_IMAGE is required (run build-and-push.sh first)}"
      : "${VPC_ID:?VPC_ID is required}"
      : "${SUBNET_IDS:?SUBNET_IDS is required (comma separated)}"
      expected_registry="$(aws sts get-caller-identity --query Account --output text).dkr.ecr.$REGION.amazonaws.com"
      image_registry="${ROUTE_IMPACT_IMAGE%%/*}"
      image_name_tag="${ROUTE_IMPACT_IMAGE#*/}"
      image_repo="${image_name_tag%:*}"
      image_tag="${image_name_tag##*:}"
      if [ "$image_registry" != "$expected_registry" ] || [ "$image_repo" != "$PREFIX-route-impact-worker" ] || [ "$image_tag" = "$image_name_tag" ]; then
        echo "ROUTE_IMPACT_IMAGE must reference $expected_registry/$PREFIX-route-impact-worker:<tag>." >&2
        exit 2
      fi
      digest="$(aws ecr describe-images --repository-name "$image_repo" --region "$REGION" --image-ids "imageTag=$image_tag" --query 'imageDetails[0].imageDigest' --output text)" || {
        echo "ECR image $ROUTE_IMPACT_IMAGE does not exist. Build and push it before deploying ECS." >&2
        exit 1
      }
      [ -n "$digest" ] && [ "$digest" != "None" ] || { echo "ECR returned no digest for $ROUTE_IMPACT_IMAGE." >&2; exit 1; }
      echo "Verified ECR image digest: $digest"
      params=("ResourcePrefix=$PREFIX"
              "QueuesStackName=$PREFIX-queues"
              "TablesStackName=$PREFIX-tables"
              "VpcId=$VPC_ID"
              "SubnetIds=${SUBNET_IDS//,/\\,}"
              "RouteImpactImage=$ROUTE_IMPACT_IMAGE"
              "WorkerProcessingDelayMs=$WORKER_PROCESSING_DELAY_MS")
      if [ -n "${TELEMETRY_PROCESSOR_IMAGE:-}" ]; then
        params+=("TelemetryProcessorImage=$TELEMETRY_PROCESSOR_IMAGE")
      fi
      if [ -n "${NOTIFICATION_WORKER_IMAGE:-}" ]; then
        params+=("NotificationWorkerImage=$NOTIFICATION_WORKER_IMAGE")
      fi
      if [ -n "${EXISTING_EXECUTION_ROLE_ARN:-}" ]; then
        params+=("ExistingExecutionRoleArn=$EXISTING_EXECUTION_ROLE_ARN")
      fi
      if [ -n "${EXISTING_TASK_ROLE_ARN:-}" ]; then
        params+=("ExistingTaskRoleArn=$EXISTING_TASK_ROLE_ARN")
      fi
      deploy_stack ecs ecs.yaml iam "${params[@]}"
      ;;
    scaling)
      params=("ResourcePrefix=$PREFIX"
              "EcsStackName=$PREFIX-ecs"
              "QueuesStackName=$PREFIX-queues"
              "ScalingMode=$SCALING_MODE"
              "MinTasks=$MIN_TASKS"
              "MaxTasks=$MAX_TASKS"
              "TargetBacklogPerTask=$TARGET_BACKLOG")
      if [ -n "${EXISTING_LAMBDA_ROLE_ARN:-}" ]; then
        params+=("ExistingLambdaRoleArn=$EXISTING_LAMBDA_ROLE_ARN")
      fi
      deploy_stack scaling scaling.yaml iam "${params[@]}"
      ;;
    *)
      echo "unknown stack: $stack" >&2
      exit 2
      ;;
  esac
done

echo ""
echo "Done. Inspect with: ./infrastructure/scripts/describe.sh"
