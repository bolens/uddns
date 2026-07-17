/**
 * Optional OpenTelemetry spans. The API is a no-op until an SDK/provider is
 * registered by the embedding process.
 */

import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

export type Telemetry = {
  trace<T>(name: string, attributes: Attributes, operation: () => Promise<T>): Promise<T>;
};

const noopTelemetry: Telemetry = {
  async trace(_name, _attributes, operation) {
    return await operation();
  },
};

export function createTelemetry(enabled: boolean): Telemetry {
  if (!enabled) {
    return noopTelemetry;
  }
  const tracer = trace.getTracer('uddns');
  return {
    async trace(name, attributes, operation) {
      return await tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
          const result = await operation();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          span.end();
        }
      });
    },
  };
}
