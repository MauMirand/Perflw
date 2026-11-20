# Agent Ecosystem Specification
## Perflw

**Purpose:** Expand the existing Perflw desktop application into an integrated Agent Ecosystem with editable agents, reusable skills, multi-provider LLM support, and efficient context management.

## 1. Non-negotiable project constraints

- Build on the existing Perflw codebase and architecture. Do not rebuild, replace, or unnecessarily refactor working systems.
- Preserve the current application structure, existing data, and backward compatibility.
- Inspect the relevant source files, tests, documentation, and Git history before changing code. The repository contains `src/`, `test/`, and `docs/`; Git history includes the **M1 provider layer** commit. Use these as the source of truth for existing architecture and provider work.
- Reuse existing abstractions and conventions wherever possible. In particular, inspect and extend the existing provider layer rather than creating a competing implementation.
- Keep the existing Ollama integration working.
- Do not implement a feature merely as a visual interface. Every control and feature must be connected to real application behavior.
- Avoid broad project scans, repeated reading of unchanged files, unnecessary dependencies, unrelated cleanup, and large-scale rewrites.
- Make focused, incremental changes. Do not implement future phases while working on the current phase unless a dependency makes it necessary.
- If an existing implementation already satisfies a requirement, retain it and report that it is already implemented rather than duplicating it.
- If a requirement conflicts with the current architecture, explain the conflict and propose the smallest compatible solution before making a destructive change.

## 2. Existing application capabilities to preserve

The current desktop application already has:
- An **Agents** category. Agents currently integrate with local Ollama.
- A functional **Agentic Automation** visual workflow builder with a node-based canvas.
- Workflow nodes for input, agents, Markdown instructions, and output.
- Connected agent execution and a chat/testing panel.

Preserve these systems and their current behavior. Extend them in place.

## 3. Advanced editable agent architecture

### 3.1 Agent files and directories

Each agent must have its own editable directory containing structured configuration and instruction files. Use the following as a suggested layout, adapting it to existing project conventions:

```text
agents/
  researcher/
    AGENT.md
    identity.md
    instructions.md
    capabilities.md
    context.md
    configuration.json
    resources/
```

The exact storage location and format should follow the existing application architecture. Do not create a parallel agent store if one already exists.

### 3.2 Agent management and editor

Implement:
- Create, edit, duplicate, and delete agents.
- Open and edit an agent's files from within the application.
- Display the agent's file structure clearly.
- Save changes persistently.
- Import and export agent configurations/directories where practical.
- Validate configuration files and show useful errors for invalid or missing values.
- Protect against accidental deletion or destructive edits where appropriate.

### 3.3 Runtime integration

Edits must affect the actual agent at runtime. The application must load the current saved identity, instructions, capabilities, context, configuration, and assigned skills when executing that agent.

Do not build an editor that only changes displayed text or stores files that the runtime ignores.

## 4. Reusable Skills management

### 4.1 Skills category

Add a dedicated **Skills** category to the application navigation.

Skills are reusable capability/instruction packages that can be assigned to one or more agents. They must be separate from agent-specific identity and configuration.

### 4.2 Skill structure

Use a package structure compatible with the existing architecture. Suggested layout:

```text
skills/
  skill-name/
    SKILL.md
    references/
    scripts/
    resources/
```

`SKILL.md` should contain the skill's instructions and relevant metadata. Supporting references, scripts, and resources should remain organized within the skill package.

### 4.3 Skill management

Implement:
- Create, edit, duplicate, delete, import, and export skills.
- Browse and edit skill files within the application.
- Enable or disable a skill.
- Assign and unassign skills to agents.
- Allow a skill to be shared by multiple agents.
- Show which agents use a skill.
- Validate skill metadata and required files.
- Support skill-specific references and resources.

### 4.4 Skill discovery and loading

Do not load every skill and every reference into every agent prompt.

Use progressive loading:
1. Load lightweight skill metadata or descriptions for discovery.
2. Identify skills relevant to the current task.
3. Load the full `SKILL.md` instructions only for selected skills.
4. Load individual references or resources only when needed.

Scripts must not execute automatically just because a skill is assigned or loaded. Script execution must be explicit, permission-controlled, and subject to the agent's capability restrictions.

## 5. Multi-provider LLM integration

### 5.1 Add LLM API action

Add an **Add LLM API** action in the Agents area or the existing provider settings location, following the application's current UI conventions.

Support these providers initially:
- Ollama (existing local integration)
- OpenAI
- Anthropic
- Google Gemini
- Custom OpenAI-compatible endpoints

Do not remove or regress existing Ollama functionality.

### 5.2 Provider architecture

- Inspect the existing **M1 provider layer** and extend it.
- Use or adapt a common provider interface/adapter pattern so agents can use different providers without duplicating execution logic.
- Keep provider-specific behavior behind the adapter boundary.
- Do not assume all providers support identical tools, structured output, streaming, context sizes, or other capabilities.
- Expose provider capabilities accurately and handle unsupported features gracefully.
- Keep provider configuration separate from agent identity and skill content.

### 5.3 Provider configuration and testing

Implement:
- Add, edit, and remove provider connections.
- Configure provider endpoint and model.
- Securely enter and store API credentials.
- Test a connection and report actionable success or failure information.
- Discover available models where the provider supports model discovery.
- Allow manual model identifiers when discovery is unavailable.
- Select a provider and model per agent.
- Display the selected provider/model clearly.
- Handle missing credentials, invalid endpoints, unavailable models, network errors, and provider errors without crashing the app.

### 5.4 Credential security

- Never store API keys in plaintext Markdown files, agent configuration exports, frontend state, logs, or ordinary application settings.
- Use the operating system's secure credential store or the project's established secure secret-storage mechanism.
- Keep secrets out of debug output and error messages.
- Do not include credentials when exporting agents, skills, or ordinary configuration.
- Ensure secret handling follows the current desktop application's security architecture.

## 6. Context management and token efficiency

Build a structured context assembly system. The execution context may include:
- Agent identity
- Agent instructions
- Relevant agent context files
- Selected skill descriptions and instructions
- Skill references/resources required for the task
- Workflow-level Markdown instructions
- User input
- Upstream workflow node outputs
- Available tools and permissions
- Relevant conversation or task history

### 6.1 Progressive and relevant context loading

- Load only the context needed for the current task.
- Discover skills from lightweight metadata first, then load selected skill instructions.
- Load reference files only when relevant.
- Avoid indiscriminately appending every agent file, skill, and resource to every request.
- Avoid duplicate instructions and duplicate context.
- Summarize or compact older context when useful, without discarding important task state.
- Keep upstream workflow outputs available to downstream nodes when relevant.
- Preserve clear precedence between system-level rules, agent instructions, skill instructions, workflow instructions, and user input.

### 6.2 Token budgeting and diagnostics

- Support configurable or provider-aware context/token budgets where feasible.
- Respect provider/model context limits.
- Reserve room for the model's response where applicable.
- Truncate, summarize, or omit lower-priority context safely when limits are approached.
- Avoid unnecessary repeated context.
- Use caching only where supported and safe; do not assume every provider offers prompt caching.
- Provide useful diagnostics about which context files and skills were loaded and why.
- Where feasible, show estimated context usage or token counts, while clearly distinguishing estimates from provider-reported values.
- Handle context overflow with a useful error or controlled reduction strategy rather than silent failure.

## 7. Agent capabilities, tools, and permissions

Support a capability/permission model that can govern access to:
- File reading
- File writing
- Document processing
- Web access
- Code execution
- External API access
- Workflow interaction
- Skill script execution

Requirements:
- Permissions must be configurable per agent.
- An agent must not be able to use a capability that has not been granted.
- Destructive or high-impact operations should require confirmation or approval where appropriate.
- Record meaningful tool actions and execution outcomes in logs.
- Do not claim an agent can use a tool if that tool is not actually available.
- Skills must not bypass or elevate the permissions of the agent using them.
- Validate permissions at execution time, not only in the UI.
- Apply safe defaults for newly created agents.

## 8. Agentic Automation workflow integration

Extend the existing node-based Agentic Automation system without replacing it.

Requirements:
- Existing Agent Nodes must use the latest saved agent configuration at execution time, or a clearly defined and consistent snapshot/version mechanism.
- Agent Nodes must use the agent's selected provider and model.
- Agent Nodes must load the skills assigned to that agent.
- Allow optional per-node skill overrides where compatible with the current workflow design.
- Preserve the existing Markdown instruction node as a workflow-level instruction/supplement.
- Pass upstream node output into downstream agent context.
- Keep the existing input, agent, Markdown instruction, output, execution, and testing behavior working.
- Make it possible to identify which agent, provider/model, skills, and relevant context were used during a node execution.
- Avoid maintaining a second, duplicated definition of an agent inside workflow nodes.
- Handle missing agents, disabled skills, unavailable providers, and execution failures gracefully.
- Do not silently change the meaning or behavior of existing saved workflows.

## 9. User experience and reliability

- Follow existing UI patterns and visual conventions.
- Provide clear loading, empty, success, validation, and error states.
- Make saved versus unsaved changes clear.
- Avoid inert buttons, fake connection tests, placeholder execution, or mock-only functionality in the completed implementation.
- Ensure the application remains usable if an optional provider is not configured.
- Provide helpful validation and error messages without exposing secrets.
- Keep the interface understandable as the number of agents, skills, and providers grows.

## 10. Implementation approach

Work incrementally and keep token/codebase usage controlled.

Before implementation:
1. Inspect the repository structure and the relevant source files in `src/`, `test/`, and `docs/`.
2. Inspect Git history around the **M1 provider layer** commit and identify what is already implemented.
3. Trace the existing agent data model, Ollama execution path, provider abstraction, workflow Agent Node, persistence mechanism, and relevant tests.
4. Identify the smallest set of files and components that need changes.
5. Present a short implementation plan with phase assignments and dependencies.

Then implement in logical stages. Recommended order:
1. **Foundation and editable agents:** extend the current agent model/storage and make agent files editable and runtime-effective.
2. **Skills management:** implement skill packages, editor, assignment, and progressive loading.
3. **Provider expansion:** extend the existing provider layer for OpenAI, Anthropic, Gemini, and custom OpenAI-compatible endpoints while preserving Ollama.
4. **Context and permissions:** implement relevant context assembly, token budgeting/diagnostics, and runtime permission enforcement.
5. **Workflow integration and verification:** connect the new agent/skill/provider/context behavior to existing Agent Nodes and test end-to-end workflows.

Adjust the order only when the actual codebase shows a dependency that requires it. Do not attempt an unnecessarily large all-at-once rewrite.

## 11. Engineering and token-efficiency rules

- Plan the shortest reliable implementation path.
- Read only files needed for the current task; do not repeatedly scan the entire repository.
- Reuse existing code, types, provider abstractions, components, and tests.
- Avoid unnecessary dependencies and unrelated refactoring.
- Do not rewrite working systems to fit a preferred architecture.
- Keep changes focused and reviewable.
- Run the narrowest relevant tests first, then broader tests where practical.
- Add or update tests for real behavior, edge cases, persistence, and integration.
- Verify functionality, not merely that a screen or button appears.
- Do not invent successful test results. Report tests that could not be run and why.
- If credentials are unavailable, test provider configuration/validation and clearly report that a live provider call could not be verified.
- Preserve existing user data and saved workflows.
- Stop and report a blocker rather than making risky assumptions or destructive changes.

## 12. Definition of done and explicit endpoint

The task is complete when the achievable core requirements below are implemented and verified against the existing application:

1. **Editable agents:** agents have persistent, editable structured files/configuration, and changes affect actual runtime execution.
2. **Skills:** the Skills category supports real skill package creation/editing, enable/disable, assignment to agents, and progressive instruction/reference loading. Script execution is permission-controlled.
3. **LLM providers:** the existing provider layer is extended to support the configured providers (Ollama, OpenAI, Anthropic, Gemini, and custom OpenAI-compatible endpoints), with per-agent provider/model selection, connection testing, and secure credential storage. Ollama continues to work.
4. **Context management:** agents receive relevant context without indiscriminately loading every file or skill; context limits and errors are handled; useful diagnostics are available.
5. **Permissions:** capabilities are enforced at runtime, with appropriate approval for destructive/high-impact actions.
6. **Workflow compatibility:** existing Agentic Automation workflows continue to work, and Agent Nodes use the updated agent, provider/model, skills, and upstream context.
7. **Verification:** relevant automated tests pass, and at least one practical end-to-end test demonstrates the new agent/skill/provider/workflow behavior to the extent possible with available credentials.

### Stop condition

Once the core requirements above are implemented to the extent supported by the current architecture, existing functionality is preserved, and the relevant tests/end-to-end checks have been performed, **stop**.

Do not continue adding optional features, redesigning unrelated areas, polishing indefinitely, or refactoring beyond what is required. If any requirement cannot be completed safely or verified, stop at that boundary and report the exact limitation rather than pretending it is done.

## 13. Required final report

At completion, provide a concise five-part report:

1. **Completed:** features implemented and how they work in the actual application.
2. **Files changed:** important files added, modified, or removed, grouped by feature.
3. **Tests and verification:** commands/tests run, results, and practical end-to-end checks performed.
4. **Limitations/blockers:** anything incomplete, unverified, dependent on credentials, or constrained by the existing architecture.
5. **Endpoint status:** whether the definition of done was met; if not, identify the remaining acceptance criteria precisely.

Do not claim completion based only on UI implementation. Be explicit about runtime behavior and test evidence.
