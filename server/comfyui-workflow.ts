import { z } from 'zod';
import { MediaError, mediaRequestSchema, type MediaRequest } from './media';

const nodeSchema = z.object({
  class_type: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()),
}).passthrough();
const specSchema = z.object({
  workflow: z.record(z.string(), nodeSchema),
  bindings: z.object({ positive: z.string(), negative: z.string(), seed: z.string() }).strict(),
  outputNode: z.string(),
}).strict();
export type ComfyWorkflowSpec = z.infer<typeof specSchema>;
export function validateWorkflow(value: unknown): ComfyWorkflowSpec {
  const checked = specSchema.safeParse(value);
  if (!checked.success) throw new MediaError('INVALID_WORKFLOW', '请提供API格式工作流及节点绑定。');
  const spec = checked.data, nodes = spec.workflow, bindings = spec.bindings;
  if (typeof nodes[bindings.positive]?.inputs.text !== 'string' ||
      typeof nodes[bindings.negative]?.inputs.text !== 'string' ||
      typeof nodes[bindings.seed]?.inputs.seed !== 'number' || !nodes[spec.outputNode] ||
      bindings.positive === bindings.negative)
    throw new MediaError('INVALID_WORKFLOW', '工作流的提示词、seed或输出节点绑定不正确。');
  if (JSON.stringify(spec).includes('REPLACE_WITH_'))
    throw new MediaError('NOT_CONFIGURED', '示例工作流含模型占位符，需要替换为目标ComfyUI环境的真实配置。');
  return structuredClone(spec);
}
export function prepareWorkflow(spec: ComfyWorkflowSpec, input: MediaRequest) {
  const checked = mediaRequestSchema.safeParse(input);
  if (!checked.success) throw new MediaError('INVALID_REQUEST', '图片请求格式不正确。');
  const workflow = structuredClone(spec.workflow);
  workflow[spec.bindings.positive].inputs.text = checked.data.prompt;
  if (checked.data.negativePrompt !== undefined)
    workflow[spec.bindings.negative].inputs.text = checked.data.negativePrompt;
  if (checked.data.seed !== undefined) workflow[spec.bindings.seed].inputs.seed = checked.data.seed;
  return workflow;
}
