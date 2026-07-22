// UK Clearing Advisor - WarmUp (EventBridge, Results Day only).
// Invokes SearchCourses with the "__WARMUP__" token so provisioned/warm
// instances are ready before the 08:00 BST surge. SearchCourses bypasses
// bot/Turnstile checks for this token.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambda = new LambdaClient({});
const TARGET = process.env.SEARCH_FUNCTION_NAME || 'ClearingAdvisor-SearchCourses';
const CONCURRENCY = parseInt(process.env.WARMUP_CONCURRENCY || '5', 10);

export const handler = async () => {
  const payload = Buffer.from(JSON.stringify({
    body: JSON.stringify({ cfTurnstileToken: '__WARMUP__' }),
    requestContext: { http: { sourceIp: '127.0.0.1' }, requestId: 'warmup' },
  }));

  const invokes = Array.from({ length: CONCURRENCY }, () =>
    lambda.send(new InvokeCommand({
      FunctionName: TARGET,
      InvocationType: 'RequestResponse',
      Payload: payload,
    })).catch((e) => ({ error: e.message })));

  const results = await Promise.all(invokes);
  const ok = results.filter((r) => !r.error).length;
  console.log(JSON.stringify({ level: 'INFO', msg: 'warmup complete', requested: CONCURRENCY, ok }));
  return { warmed: ok };
};
