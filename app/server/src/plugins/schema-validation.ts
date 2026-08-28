/**
 * 运行时请求校验（Fastify 内建 AJV）。
 *
 * Fastify 默认的 AJV 配置 coerceTypes: 'array' 会把 JSON 字符串静默强转为数字，
 * 例如 body 里的 version: "1" 会通过 integer 校验进入 service。这里全局关闭类型强转，
 * 让“形状错误 → 400”成为可靠的运行时契约（详见各写路由的 JSON Schema）。
 *
 * 说明：这仍然使用 Fastify 自带的 @fastify/ajv-compiler / AJV 实例，
 * 只是通过工厂选项调整配置，没有引入第二套校验体系。
 */
export const runtimeValidationFastifyOptions = {
  ajv: { customOptions: { coerceTypes: false } }
} as const;
