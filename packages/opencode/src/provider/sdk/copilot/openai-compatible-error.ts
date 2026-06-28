import { z, type ZodType } from "zod/v4"

export const openaiCompatibleErrorDataSchema = z.object({
  error: z.object({
    message: z.string(),

    // The additional information below is handled loosely to support
    // OpenAI-compatible providers that have slightly different error
    // responses:
    type: z.string().nullish(),
    param: z.any().nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
  }),
})

export type OpenAICompatibleErrorData = z.infer<typeof openaiCompatibleErrorDataSchema>

export type ProviderErrorStructure<T> = {
  errorSchema: ZodType<T>
  errorToMessage: (error: T) => string
  isRetryable?: (response: Response, error?: T) => boolean
}

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /too many requests/i,
  /resource exhausted/i,
  /worker local total request limit/i,
  /quota exceeded/i,
  /rate increased too quickly/i,
]

function checkRateLimit(message: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(message))
}

export const defaultOpenAICompatibleErrorStructure: ProviderErrorStructure<OpenAICompatibleErrorData> = {
  errorSchema: openaiCompatibleErrorDataSchema,
  errorToMessage: (data) => data.error.message,
  isRetryable: (_response, error) => error ? checkRateLimit(error.error.message) : false,
}
