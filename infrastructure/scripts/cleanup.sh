#!/usr/bin/env bash
#
# Removes ONLY the resources this project created.
#
# SAFETY RULES BUILT INTO THIS SCRIPT
#   * It deletes CloudFormation STACKS whose names start with the project
#     prefix, and nothing else. It never enumerates or deletes account
#     resources by type.
#   * It refuses to run if the prefix is empty or suspiciously short.
#   * It prints exactly what it will delete and requires you to type DELETE.
#   * It is NEVER run automatically.
#
# Usage:
#   ./cleanup.sh                 # show what would be deleted, then confirm
#   ./cleanup.sh --scale-in-only # just return the ECS service to 1 task (cheap)
#
set -uo pipefail

PREFIX="${RESOURCE_PREFIX:-sit314-transport}"
REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"

if [ -z "$PREFIX" ] || [ ${#PREFIX} -lt 8 ]; then
  echo "Refusing to run: RESOURCE_PREFIX ('$PREFIX') is empty or too short." >&2
  echo "A short prefix could match unrelated stacks." >&2
  exit 1
fi

command -v aws >/dev/null || { echo "AWS CLI not found." >&2; exit 1; }

# Delete in reverse dependency order.
STACK_ORDER=(scaling ecs iot-rule tables queues)

if [ "${1:-}" = "--scale-in-only" ]; then
  echo "Returning $PREFIX-route-impact to 1 task (leaves all infrastructure in place)."
  aws ecs update-service --cluster "$PREFIX-cluster" --service "$PREFIX-route-impact" \
    --desired-count 1 --region "$REGION" \
    --query "service.{Service:serviceName,Desired:desiredCount}" --output table
  echo ""
  echo "Note: Application Auto Scaling may raise this again if the queue is not empty."
  exit 0
fi

echo "=== Cleanup plan (region: $REGION, prefix: $PREFIX) ==="
echo ""
echo "The following CloudFormation stacks will be DELETED, in this order:"
FOUND=()
for s in "${STACK_ORDER[@]}"; do
  stack="$PREFIX-$s"
  status=$(aws cloudformation describe-stacks --stack-name "$stack" --region "$REGION" \
           --query "Stacks[0].StackStatus" --output text 2>/dev/null)
  if [ -n "$status" ] && [ "$status" != "None" ]; then
    echo "  - $stack   ($status)"
    FOUND+=("$stack")
  fi
done

if [ ${#FOUND[@]} -eq 0 ]; then
  echo "  (no matching stacks found - nothing to do)"
  exit 0
fi

cat <<NOTE

This removes the SQS queues, DynamoDB tables (and their data), the ECS cluster
and services, the IoT rule and the autoscaling configuration for this project.

It does NOT touch:
  - ECR repositories or pushed images (delete those separately if you want to)
  - AWS IoT certificates and policies (see docs/AWS_DEPLOYMENT.md)
  - any resource that does not belong to a "$PREFIX-*" stack

NOTE

printf "Type DELETE to proceed: "
read -r answer
if [ "$answer" != "DELETE" ]; then
  echo "Aborted. Nothing was deleted."
  exit 0
fi

for stack in "${FOUND[@]}"; do
  echo ""
  echo "Deleting $stack ..."
  aws cloudformation delete-stack --stack-name "$stack" --region "$REGION"
  echo "Waiting for $stack to be removed (this can take several minutes)..."
  if aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$REGION"; then
    echo "$stack deleted."
  else
    echo "WARNING: $stack did not delete cleanly. Check the CloudFormation console." >&2
  fi
done

echo ""
echo "Cleanup complete. Verify with: ./infrastructure/scripts/describe.sh"
