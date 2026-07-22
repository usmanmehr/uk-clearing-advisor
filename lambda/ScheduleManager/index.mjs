// UK Clearing Advisor - ScheduleManager.
// Scales SearchCourses for the Results Day surge and back down again.
// Triggered by two EventBridge rules with input { "action": "up" | "down" }.
//   up   : provisioned concurrency = PEAK, API throttle raised.
//   down : provisioned concurrency removed, API throttle back to baseline.
import {
  LambdaClient, PutProvisionedConcurrencyConfigCommand,
  DeleteProvisionedConcurrencyConfigCommand,
} from '@aws-sdk/client-lambda';
import { ApiGatewayV2Client, UpdateStageCommand } from '@aws-sdk/client-apigatewayv2';

const lambda = new LambdaClient({});
const apigw = new ApiGatewayV2Client({});

const FUNCTION_NAME = process.env.FUNCTION_NAME;      // ClearingAdvisor-SearchCourses
const ALIAS = process.env.ALIAS || 'live';
const PEAK = parseInt(process.env.PEAK || '40', 10);
const API_ID = process.env.API_ID;
const UP_RATE = parseInt(process.env.UP_RATE || '200', 10);
const UP_BURST = parseInt(process.env.UP_BURST || '400', 10);
const BASE_RATE = parseInt(process.env.BASE_RATE || '50', 10);
const BASE_BURST = parseInt(process.env.BASE_BURST || '100', 10);

async function setThrottle(rate, burst) {
  if (!API_ID) return;
  await apigw.send(new UpdateStageCommand({
    ApiId: API_ID, StageName: '$default',
    DefaultRouteSettings: { ThrottlingRateLimit: rate, ThrottlingBurstLimit: burst },
  }));
}

export const handler = async (event) => {
  const action = event?.action || 'up';
  if (action === 'up') {
    await lambda.send(new PutProvisionedConcurrencyConfigCommand({
      FunctionName: FUNCTION_NAME, Qualifier: ALIAS,
      ProvisionedConcurrentExecutions: PEAK,
    }));
    await setThrottle(UP_RATE, UP_BURST);
    console.log(JSON.stringify({ level: 'INFO', msg: 'scaled up', peak: PEAK, rate: UP_RATE, burst: UP_BURST }));
    return { action, provisionedConcurrency: PEAK, throttle: { rate: UP_RATE, burst: UP_BURST } };
  }
  // down
  try {
    await lambda.send(new DeleteProvisionedConcurrencyConfigCommand({
      FunctionName: FUNCTION_NAME, Qualifier: ALIAS,
    }));
  } catch (e) {
    if (e.name !== 'ProvisionedConcurrencyConfigNotFoundException') throw e;
  }
  await setThrottle(BASE_RATE, BASE_BURST);
  console.log(JSON.stringify({ level: 'INFO', msg: 'scaled down', rate: BASE_RATE, burst: BASE_BURST }));
  return { action, provisionedConcurrency: 0, throttle: { rate: BASE_RATE, burst: BASE_BURST } };
};
