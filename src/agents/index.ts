import type { AgentConfig as SDKAgentConfig } from '@opencode-ai/sdk';
import { getSkillPermissionsForAgent } from '../cli/skills';
import {
  type AgentOverrideConfig,
  DEFAULT_MODELS,
  getAgentOverride,
  loadAgentPrompt,
  type PluginConfig,
  PRIMARY_AGENT_NAMES,
  SUBAGENT_NAMES,
} from '../config';
import { getAgentMcpList } from '../config/agent-mcps';

import { createCartographerAgent } from './cartographer';
import { createDesignerAgent } from './designer';
import { createExplorerAgent } from './explorer';
import { createFixerAgent } from './fixer';
import { createLibrarianAgent } from './librarian';
import { createOracleAgent } from './oracle';
import { createOrchestratorAgent } from './orchestrator';
import type { AgentDefinition } from './types';

export type { AgentDefinition } from './types';

type AgentFactory = (
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
) => AgentDefinition;

// Agent Configuration Helpers

/**
 * Apply user-provided overrides to an agent's configuration.
 * Supports overriding model and temperature.
 */
function applyOverrides(
  agent: AgentDefinition,
  override: AgentOverrideConfig,
): void {
  if (override.model) agent.config.model = override.model;
  if (override.temperature !== undefined)
    agent.config.temperature = override.temperature;
}

type PermissionValue = 'ask' | 'allow' | 'deny';
type PermissionRecord = Record<string, PermissionValue | Record<string, PermissionValue>>;

/**
 * Apply default permissions to an agent.
 * Sets 'question' permission to 'allow' and includes skill permission presets.
 * If configuredSkills is provided, it honors that list instead of defaults.
 *
 * Also applies agent-specific tool and task permissions:
 * - orchestrator: denies edit/write tools and question tool, allows all task delegations
 * - cartographer: denies edit/write/bash tools, restricts task to read-only agents
 */
function applyDefaultPermissions(
  agent: AgentDefinition,
  configuredSkills?: string[],
): void {
  const existing = (agent.config.permission ?? {}) as PermissionRecord;

  // Get skill-specific permissions for this agent
  const skillPermissions = getSkillPermissionsForAgent(
    agent.name,
    configuredSkills,
  );

  // Base permissions
  const basePermissions: PermissionRecord = {
    ...existing,
    question: 'allow',
    skill: {
      ...(typeof existing.skill === 'object' ? existing.skill : {}),
      ...skillPermissions,
    },
  };

  // Apply agent-specific tool and task permissions
  if (agent.name === 'orchestrator') {
    // Orchestrator: no direct edits, no question tool (autonomous operation)
    basePermissions.edit = 'deny';
    basePermissions.write = 'deny';
    basePermissions.question = 'deny';
  } else if (agent.name === 'cartographer') {
    // Cartographer: read-only, encourages questions, can only delegate to read-only agents
    basePermissions.edit = 'deny';
    basePermissions.write = 'deny';
    basePermissions.bash = 'deny';
    basePermissions.question = 'allow';
    // Restrict task delegation to read-only agents only
    basePermissions.task = {
      '*': 'deny',
      'explorer': 'allow',
      'librarian': 'allow',
      'oracle': 'allow',
    };
  }

  agent.config.permission = basePermissions as SDKAgentConfig['permission'];
}

// Agent Classification

export type SubagentName = (typeof SUBAGENT_NAMES)[number];
export type PrimaryAgentName = (typeof PRIMARY_AGENT_NAMES)[number];

export function isSubagent(name: string): name is SubagentName {
  return (SUBAGENT_NAMES as readonly string[]).includes(name);
}

export function isPrimaryAgent(name: string): name is PrimaryAgentName {
  return (PRIMARY_AGENT_NAMES as readonly string[]).includes(name);
}

// Agent Factories

const SUBAGENT_FACTORIES: Record<SubagentName, AgentFactory> = {
  explorer: createExplorerAgent,
  librarian: createLibrarianAgent,
  oracle: createOracleAgent,
  designer: createDesignerAgent,
  fixer: createFixerAgent,
};

// Public API

/**
 * Create all agent definitions with optional configuration overrides.
 * Instantiates the orchestrator and all subagents, applying user config and defaults.
 *
 * @param config - Optional plugin configuration with agent overrides
 * @returns Array of agent definitions (orchestrator first, then subagents)
 */
export function createAgents(config?: PluginConfig): AgentDefinition[] {
  // TEMP: If fixer has no config, inherit from librarian's model to avoid breaking
  // existing users who don't have fixer in their config yet
  const getModelForAgent = (name: SubagentName): string => {
    if (name === 'fixer' && !getAgentOverride(config, 'fixer')?.model) {
      return (
        getAgentOverride(config, 'librarian')?.model ?? DEFAULT_MODELS.librarian
      );
    }
    return DEFAULT_MODELS[name];
  };

  // 1. Gather all sub-agent definitions with custom prompts
  const protoSubAgents = (
    Object.entries(SUBAGENT_FACTORIES) as [SubagentName, AgentFactory][]
  ).map(([name, factory]) => {
    const customPrompts = loadAgentPrompt(name);
    return factory(
      getModelForAgent(name),
      customPrompts.prompt,
      customPrompts.appendPrompt,
    );
  });

  // 2. Apply overrides and default permissions to each agent
  const allSubAgents = protoSubAgents.map((agent) => {
    const override = getAgentOverride(config, agent.name);
    if (override) {
      applyOverrides(agent, override);
    }
    applyDefaultPermissions(agent, override?.skills);
    return agent;
  });

  // 3. Create primary agents (orchestrator and cartographer)
  const primaryAgents: AgentDefinition[] = [];

  // Orchestrator
  const orchestratorModel =
    getAgentOverride(config, 'orchestrator')?.model ??
    DEFAULT_MODELS.orchestrator;
  const orchestratorPrompts = loadAgentPrompt('orchestrator');
  const orchestrator = createOrchestratorAgent(
    orchestratorModel,
    orchestratorPrompts.prompt,
    orchestratorPrompts.appendPrompt,
  );
  const oOverride = getAgentOverride(config, 'orchestrator');
  applyDefaultPermissions(orchestrator, oOverride?.skills);
  if (oOverride) {
    applyOverrides(orchestrator, oOverride);
  }
  primaryAgents.push(orchestrator);

  // Cartographer
  const cartographerModel =
    getAgentOverride(config, 'cartographer')?.model ??
    DEFAULT_MODELS.cartographer;
  const cartographerPrompts = loadAgentPrompt('cartographer');
  const cartographer = createCartographerAgent(
    cartographerModel,
    cartographerPrompts.prompt,
    cartographerPrompts.appendPrompt,
  );
  const cOverride = getAgentOverride(config, 'cartographer');
  applyDefaultPermissions(cartographer, cOverride?.skills);
  if (cOverride) {
    applyOverrides(cartographer, cOverride);
  }
  primaryAgents.push(cartographer);

  return [...primaryAgents, ...allSubAgents];
}

/**
 * Get agent configurations formatted for the OpenCode SDK.
 * Converts agent definitions to SDK config format and applies classification metadata.
 *
 * @param config - Optional plugin configuration with agent overrides
 * @returns Record mapping agent names to their SDK configurations
 */
export function getAgentConfigs(
  config?: PluginConfig,
): Record<string, SDKAgentConfig> {
  const agents = createAgents(config);
  return Object.fromEntries(
    agents.map((a) => {
      const sdkConfig: SDKAgentConfig & { mcps?: string[] } = {
        ...a.config,
        description: a.description,
        mcps: getAgentMcpList(a.name, config),
      };

      // Apply classification-based visibility and mode
      if (isSubagent(a.name)) {
        sdkConfig.mode = 'subagent';
      } else if (isPrimaryAgent(a.name)) {
        sdkConfig.mode = 'primary';
      }

      return [a.name, sdkConfig];
    }),
  );
}
