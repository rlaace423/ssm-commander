#!/bin/sh
# Creates, inspects and deletes the throwaway AWS fixtures described in test-infra/ssm-commander-test.yaml.
# usage: sh test-infra/stack.sh up [-p profile] [-r region] [-n stack-name] [Key=Value ...]
#        sh test-infra/stack.sh down|status|outputs [-p profile] [-r region] [-n stack-name]
# Key=Value pairs are template parameters, for example KeyName=my-key EcsFixtures=minimal CreateEcs=false.
# Needs the AWS CLI; the profile needs CloudFormation, EC2, ECS and IAM permissions.
set -eu
cd "$(dirname "$0")/.."
TEMPLATE=test-infra/ssm-commander-test.yaml
STACK=ssm-commander-test
PROFILE_ARGS=""
REGION_ARGS=""

action=${1:-}
[ -n "$action" ] && shift
while [ $# -gt 0 ]; do
  case $1 in
    -p) PROFILE_ARGS="--profile $2"; shift 2 ;;
    -r) REGION_ARGS="--region $2"; shift 2 ;;
    -n) STACK=$2; shift 2 ;;
    *=*) break ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
# shellcheck disable=SC2086 # the option strings are meant to split into words
aws_cf() { aws $PROFILE_ARGS $REGION_ARGS cloudformation "$@"; }

case $action in
  up)
    overrides=""
    [ $# -gt 0 ] && overrides="--parameter-overrides $*"
    # shellcheck disable=SC2086
    aws_cf deploy --stack-name "$STACK" --template-file "$TEMPLATE" --capabilities CAPABILITY_IAM \
      --no-fail-on-empty-changeset $overrides
    aws_cf describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
    echo "Instances register with Systems Manager about a minute after they boot; Fargate tasks take one or two."
    ;;
  down)
    aws_cf delete-stack --stack-name "$STACK"
    echo "Deleting $STACK (ECS services drain first; this takes a few minutes)..."
    aws_cf wait stack-delete-complete --stack-name "$STACK"
    echo "Deleted."
    ;;
  status)
    aws_cf describe-stack-events --stack-name "$STACK" --max-items 15 \
      --query 'StackEvents[].[Timestamp,LogicalResourceId,ResourceStatus,ResourceStatusReason]' --output table
    ;;
  outputs)
    aws_cf describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
    ;;
  *)
    sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
