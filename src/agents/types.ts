import type { AgentConfig } from '@opencode-ai/sdk';

export interface AgentDefinition {
  name: string;
  description?: string;
  color?: string;
  config: AgentConfig;
}
