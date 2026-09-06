#!/usr/bin/env bash
# Reports the current state of every resource this project created.
# READ ONLY: this script never modifies or deletes anything.
#
# Use it to answer "what is running and what is it costing me right now?" -
# in particular the ECS running-task count.
set -uo pipefail

PREFIX="${RESOURCE_PREFIX:-sit314-transport}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"

echo "=== SIT314 transport resources (prefix: $PREFIX, region: $REGION) ==="

echo ""
echo "--- CloudFormation stacks ---"
aws cloudformation describe-stacks --region "$REGION" \
  --query "Stacks[?starts_with(StackName,\`$PREFIX\`)].{Stack:StackName,Status:StackStatus}" \
  --output table 2>/dev/null || echo "(none, or access denied)"

echo ""
echo "--- SQS queues ---"
printf "  %-44s %-10s %s\n" "QUEUE" "VISIBLE" "INFLIGHT"
for q in telemetry telemetry-dlq analysis analysis-dlq notifications notifications-dlq; do
  name="$PREFIX-$q"
  url=$(aws sqs get-queue-url --queue-name "$name" --region "$REGION" \
        --query QueueUrl --output text 2>/dev/null)
  if [ -n "$url" ] && [ "$url" != "None" ]; then
    read -r visible inflight <<<"$(aws sqs get-queue-attributes \
      --queue-url "$url" --region "$REGION" \
      --attribute-names ApproximateNumberOfMessages \
                        ApproximateNumberOfMessagesNotVisible \
      --query "Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]" \
      --output text 2>/dev/null)"
    printf "  %-44s %-10s %s\n" "$name" "${visible:-?}" "${inflight:-?}"
  else
    printf "  %-44s %s\n" "$name" "(not deployed)"
  fi
done

echo ""
echo "--- DynamoDB tables (ItemCount is refreshed roughly every 6 hours) ---"
for t in processed-events current-state analysis-results notifications; do
  name="$PREFIX-$t"
  out=$(aws dynamodb describe-table --table-name "$name" --region "$REGION" \
        --query "Table.[TableStatus,ItemCount]" --output text 2>/dev/null)
  if [ -n "$out" ]; then
    printf "  %-44s %s\n" "$name" "$out"
  else
    printf "  %-44s %s\n" "$name" "(not deployed)"
  fi
done

echo ""
echo "--- ECS services (COST SENSITIVE: running tasks are billed) ---"
aws ecs describe-services --cluster "$PREFIX-cluster" --region "$REGION" \
  --services "$PREFIX-route-impact" "$PREFIX-telemetry-processor" "$PREFIX-notification-worker" \
  --query "services[].{Service:serviceName,Desired:desiredCount,Running:runningCount,Status:status}" \
  --output table 2>/dev/null || echo "  (cluster not deployed, or access denied)"

echo ""
echo "--- Application Auto Scaling target and policy ---"
aws application-autoscaling describe-scalable-targets \
  --service-namespace ecs --region "$REGION" \
  --resource-ids "service/$PREFIX-cluster/$PREFIX-route-impact" \
  --query "ScalableTargets[].{Resource:ResourceId,Min:MinCapacity,Max:MaxCapacity}" \
  --output table 2>/dev/null || echo "  (not configured, or access denied)"

aws application-autoscaling describe-scaling-policies \
  --service-namespace ecs --region "$REGION" \
  --resource-id "service/$PREFIX-cluster/$PREFIX-route-impact" \
  --query "ScalingPolicies[].{Policy:PolicyName,Type:PolicyType,Target:TargetTrackingScalingPolicyConfiguration.TargetValue}" \
  --output table 2>/dev/null || true

echo ""
echo "--- Recent scaling activity (evidence of scale out / scale in) ---"
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs --region "$REGION" \
  --resource-id "service/$PREFIX-cluster/$PREFIX-route-impact" --max-items 10 \
  --query "ScalingActivities[].{When:StartTime,Cause:Description,Status:StatusCode}" \
  --output table 2>/dev/null || echo "  (no activity, or access denied)"

echo ""
echo "--- BacklogPerTask metric (last 30 minutes) ---"
aws cloudwatch get-metric-statistics --region "$REGION" \
  --namespace "${METRIC_NAMESPACE:-SIT314/Transport}" \
  --metric-name BacklogPerTask \
  --dimensions "Name=ServiceName,Value=$PREFIX-route-impact" \
  --start-time "$(date -u -d '30 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)" \
  --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --period 60 --statistics Average Maximum \
  --query "sort_by(Datapoints,&Timestamp)[].{Time:Timestamp,Avg:Average,Max:Maximum}" \
  --output table 2>/dev/null || echo "  (no datapoints, or access denied)"
