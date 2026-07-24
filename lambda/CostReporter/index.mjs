// UK Clearing Advisor - CostReporter (EventBridge, daily).
// This AWS account is not dedicated to this app - it also runs other
// unrelated stacks/workloads, so account-level billing is meaningless for
// "cost of this app". Every resource in every uk-clearing-advisor-* stack
// was tagged
// Application=uk-clearing-advisor (cascaded via stack-level Tags) and that
// tag was activated as a Cost Allocation Tag, so Cost Explorer can now
// isolate this app's spend specifically.
//
// This function calls ce:GetCostAndUsage filtered to that tag for
// yesterday (Cost Explorer data lags ~24h, "today" is always incomplete/
// unreliable) and pushes the result as a custom CloudWatch metric so it
// can sit alongside the existing operational metrics in Grafana (which
// already has a CloudWatch datasource provisioned - no new datasource or
// plugin needed).
//
// Cost Explorer is a global service - the API endpoint is us-east-1 only,
// regardless of which region this Lambda itself runs in.
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const ce = new CostExplorerClient({ region: 'us-east-1' });
const cw = new CloudWatchClient({});

const NAMESPACE = process.env.METRICS_NAMESPACE || 'ClearingAdvisor';
const TAG_KEY = process.env.COST_TAG_KEY || 'Application';
const TAG_VALUE = process.env.COST_TAG_VALUE || 'uk-clearing-advisor';

function yesterdayRange() {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { Start: fmt(start), End: fmt(end) }; // End is exclusive
}

export const handler = async () => {
  const period = yesterdayRange();

  const result = await ce.send(new GetCostAndUsageCommand({
    TimePeriod: period,
    Granularity: 'DAILY',
    Metrics: ['UnblendedCost'],
    Filter: {
      And: [
        { Tags: { Key: TAG_KEY, Values: [TAG_VALUE] } },
        { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } } },
      ],
    },
  }));

  const amountStr = result.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? '0';
  const costUsd = parseFloat(amountStr);

  // Deliberately timestamped "now" (publish time), NOT period.Start
  // (the cost period this value represents). CloudWatch can take up to
  // 48h to make a data point queryable once its timestamp is more than
  // 24h in the past - backdating this to yesterday would silently delay
  // the dashboard by an extra ~2 days on top of Cost Explorer's own ~24h
  // reporting lag, for no benefit. The value itself still correctly
  // reflects yesterday's spend; only the CloudWatch recording time is
  // "now".
  await cw.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: [{
      MetricName: 'DailyCostUSD',
      Value: costUsd,
      Unit: 'None',
    }],
  }));

  console.log(JSON.stringify({
    level: 'INFO', msg: 'cost metric published',
    period, tagKey: TAG_KEY, tagValue: TAG_VALUE, costUsd,
  }));

  return { period, costUsd };
};
